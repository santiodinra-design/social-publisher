//! The local API and the built UI (port of `server/app.ts`, desktop mode).
//!
//! It listens on 127.0.0.1 only. Every `/api/*` call must carry the per-launch cookie that only the
//! app's own window holds; loopback alone is not trusted. The open routes are the static UI,
//! `/api/session`, signed `/m/` media links, OAuth callbacks and the one-use window entry link.
use crate::accounts::{self, get_account, list_accounts, mark_account, upsert_account};
use crate::app::PendingOAuth;
use crate::crypto::{constant_eq, pkce_pair, random_id, read_signed_token, redact, signed_token};
use crate::db::{self, MediaRow, Platform, PLATFORMS};
use crate::jobs::{self, NewTarget};
use crate::media::{self, info_of, media_view, validate_media, Issue, VIDEO_MIME};
use crate::platforms::{self, Identity, TokenSet};
use crate::settings::{self, check_keys, fields, setup_view};
use crate::util::{decode_component, encode_component, js_str, now_ms};
use crate::{probe, relay, App};
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::Router;
use futures_util::StreamExt;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const DESKTOP_COOKIE: &str = "sp_desktop";
/// What this backend can do beyond the original contract. The shared UI shows a feature only when it
/// is listed here, so the Mac app (whose server sends none) keeps its screens unchanged.
const FEATURES: &[&str] = &["schedule", "notifications", "markPosted", "repost", "covers", "analytics", "groups", "draftsOnly", "inbox", "phone"];
const SIGN_IN_HOSTS: [&str; 5] = ["accounts.google.com", "www.instagram.com", "api.instagram.com", "www.tiktok.com", "www.facebook.com"];

/// Drafts only: TikTok always goes to the inbox (the owner finishes it in TikTok) and Instagram, which
/// has no drafts in its API, is refused. YouTube keeps the visibility the owner chose.
pub fn as_draft(platform: Platform, settings: &Value) -> Option<Value> {
	match platform {
		Platform::Youtube => Some(settings.clone()),
		Platform::Tiktok => {
			let mut s = if settings.is_object() { settings.clone() } else { json!({}) };
			s["mode"] = Value::from("inbox");
			s["privacy"] = Value::from("SELF_ONLY");
			Some(s)
		}
		Platform::Instagram => None,
	}
}
pub const DRAFTS_INSTAGRAM: &str = "Drafts only is on, and Instagram has no drafts for apps. Post this Reel from the Instagram app, or turn off Drafts only.";

#[derive(rust_embed::RustEmbed)]
#[folder = "../../dist"]
struct Ui;

type S = State<Arc<App>>;

pub fn router(app: Arc<App>) -> Router {
	Router::new()
		.route("/api/session", get(session).post(session_post).delete(session_delete))
		.route("/api/status", get(status))
		.route("/api/config", get(config))
		.route("/api/setup", get(setup))
		.route("/api/setup/public-url", put(setup_public_url))
		.route("/api/setup/{platform}", put(setup_put).delete(setup_delete))
		.route("/api/accounts", get(accounts_list))
		.route("/api/analytics", get(analytics_get))
		.route("/api/accounts/{id}", delete(account_delete))
		.route("/api/accounts/{id}/verify", post(account_verify))
		.route("/api/demo/accounts", post(demo_accounts))
		.route("/api/oauth/{platform}/begin", post(oauth_begin))
		.route("/api/oauth/{platform}/start", get(oauth_start))
		.route("/api/oauth/{platform}/callback", get(oauth_callback))
		.route("/api/media", put(media_put).layer(DefaultBodyLimit::disable()))
		.route("/api/media/{id}", get(media_get))
		.route("/m/{token}", get(media_file))
		.route("/api/covers", put(cover_put).layer(DefaultBodyLimit::max(crate::covers::MAX_BYTES + 1024)))
		.route("/api/covers/{id}", get(cover_get))
		.route("/api/posts", get(posts_list).post(posts_create))
		.route("/api/posts/{id}", get(post_get))
		.route("/api/posts/{id}/retry", post(post_retry))
		.route("/api/posts/{id}/schedule", post(post_schedule))
		.route("/api/posts/{id}/cancel", post(post_cancel))
		.route("/api/targets/{id}/posted", post(target_posted))
		.route("/api/desktop/enter", get(desktop_enter))
		.route("/api/desktop/services", get(desktop_services))
		.route("/api/desktop/pick-video", post(desktop_pick_video))
		.route("/api/desktop/upload-progress", get(desktop_upload_progress))
		.route("/api/desktop/open-external", post(desktop_open_external))
		.route("/api/desktop/open-link", post(desktop_open_link))
		.route("/api/desktop/reveal-logs", post(desktop_reveal_logs))
		.route("/api/desktop/prefs", get(desktop_prefs).put(desktop_prefs_put))
		.route("/api/desktop/reveal-inbox", post(desktop_reveal_inbox))
		.route("/api/groups", get(groups_list).post(groups_create))
		.route("/api/groups/{id}", put(groups_update).delete(groups_delete))
		.route("/api/inbox", get(inbox_get))
		.route("/api/phone", get(phone_get).put(phone_put))
		.route("/api/phone/pair", post(phone_pair))
		.route("/api/phone/devices/{id}", delete(phone_remove))
		.route("/pair/{secret}", get(phone_redeem))
		.route("/terms", get(terms_page))
		.route("/privacy", get(privacy_page))
		.fallback(static_ui)
		.layer(DefaultBodyLimit::max(1024 * 1024))
		.layer(middleware::from_fn_with_state(app.clone(), guard))
		.with_state(app)
}

// ---------- helpers ----------

fn reply(status: StatusCode, body: Value) -> Response {
	let mut res = (status, body.to_string()).into_response();
	res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
	res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
	res
}
fn ok(body: Value) -> Response {
	reply(StatusCode::OK, body)
}
fn fail(status: u16, message: &str) -> Response {
	reply(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST), json!({ "error": message }))
}
fn fail_with(status: u16, message: &str, issues: &[Issue]) -> Response {
	reply(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST), json!({ "error": message, "issues": issues.iter().map(Issue::json).collect::<Vec<_>>() }))
}
fn html(body: String) -> Response {
	let mut res = body.into_response();
	res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
	res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
	res
}
fn redirect(to: &str) -> Response {
	let mut res = StatusCode::FOUND.into_response();
	if let Ok(v) = HeaderValue::from_str(to) {
		res.headers_mut().insert(header::LOCATION, v);
	}
	res
}
fn parse(body: &Bytes) -> Value {
	if body.is_empty() {
		json!({})
	} else {
		serde_json::from_slice(body).unwrap_or(Value::Null)
	}
}
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
	headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|pair| {
		let (k, v) = pair.trim().split_once('=')?;
		(k == name).then(|| v.to_string())
	})
}
fn desktop_ok(app: &App, headers: &HeaderMap) -> bool {
	let got = cookie(headers, DESKTOP_COOKIE).unwrap_or_default();
	let want = &app.cfg.desktop_token;
	!want.is_empty() && constant_eq(got.as_bytes(), want.as_bytes())
}
fn is_open(path: &str) -> bool {
	if path == "/api/session" || path == "/api/desktop/enter" || path.starts_with("/m/") || path.starts_with("/pair/") || !path.starts_with("/api/") {
		return true;
	}
	// /api/oauth/<platform>/callback
	path.strip_prefix("/api/oauth/").and_then(|r| r.strip_suffix("/callback")).map(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_lowercase())).unwrap_or(false)
}

/** The paired phone behind a request, unless it is the app window itself. */
fn phone_of(app: &App, headers: &HeaderMap) -> Option<String> {
	if desktop_ok(app, headers) {
		None
	} else {
		crate::phone::device_of(app, cookie(headers, crate::phone::COOKIE))
	}
}

async fn guard(State(app): S, req: Request, next: Next) -> Response {
	let path = req.uri().path();
	// Requests that come straight from the inbox folder carry no peer address; they are this process.
	let local = req.extensions().get::<ConnectInfo<std::net::SocketAddr>>().map(|c| c.0.ip().is_loopback()).unwrap_or(true);
	// The window's one-use entry link only ever comes from this computer.
	if path == "/api/desktop/enter" && !local {
		return fail(403, "Blocked request.");
	}
	if !is_open(path) {
		let desktop = desktop_ok(&app, req.headers());
		let phone = if desktop { None } else { crate::phone::device_of(&app, cookie(req.headers(), crate::phone::COOKIE)) };
		if !desktop && phone.is_none() {
			return fail(401, "Sign in first.");
		}
		if phone.is_some() && crate::phone::blocked(req.method(), path) {
			return fail(403, "Do this in Publisher on the computer.");
		}
		// Simple CSRF guard: state-changing API calls must come from this app.
		let safe = matches!(*req.method(), Method::GET | Method::HEAD);
		if !safe && req.headers().get("x-requested-with").and_then(|v| v.to_str().ok()) != Some("social-publisher") {
			return fail(403, "Blocked request.");
		}
	}
	let mut res = next.run(req).await;
	res.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
	res
}

fn platform_of(p: &str) -> Result<Platform, Response> {
	Platform::parse(p).ok_or_else(|| fail(404, "Unknown platform"))
}

// ---------- session, status, config ----------

/// `desktop`: the app window. `phone`: a paired phone (it gets the web screens, without the native
/// bridge). `phonePairing`: a phone that is not paired yet is told how to pair instead of a password.
async fn session(State(app): S, headers: HeaderMap) -> Response {
	let desktop = desktop_ok(&app, &headers);
	let phone = phone_of(&app, &headers).is_some();
	ok(json!({ "signedIn": desktop || phone, "demoMode": app.cfg.demo_mode, "noSignIn": false, "desktop": !phone, "phone": phone, "phonePairing": crate::phone::enabled(&app) }))
}
async fn session_post() -> Response {
	fail(403, "This server belongs to the Publisher desktop app. Open the app instead.")
}
/** A paired phone signing out forgets itself, so it needs a new QR code to come back. */
async fn session_delete(State(app): S, headers: HeaderMap) -> Response {
	let mut res = ok(json!({ "ok": true }));
	if let Some(id) = phone_of(&app, &headers) {
		crate::phone::remove(&app, &id);
		if let Ok(v) = HeaderValue::from_str(&crate::phone::clear_cookie()) {
			res.headers_mut().insert(header::SET_COOKIE, v);
		}
	}
	res
}

/** Worker health comes from the worker's own heartbeat, not from this server answering. */
async fn status(State(app): S) -> Response {
	ok(json!({ "worker": db::worker_status(&app), "activeJobs": jobs::active_jobs(&app), "noSignIn": false, "demoMode": app.cfg.demo_mode, "now": now_ms() }))
}

async fn config(State(app): S) -> Response {
	let platforms: serde_json::Map<String, Value> = PLATFORMS
		.iter()
		.map(|p| {
			let av = platforms::availability(&app, *p, false);
			(p.as_str().to_string(), json!({ "configured": relay::ready(&app, *p), "hosted": relay::hosted(&app, *p), "available": av.available, "mode": av.mode, "note": av.note, "limits": media::limits_json(*p) }))
		})
		.collect();
	let video_hosting = relay::base(&app).is_some() && app.endpoints.relay_platforms.contains(&Platform::Instagram);
	ok(json!({ "demoMode": app.cfg.demo_mode, "publicBaseUrl": !settings::public_base_url(&app).is_empty(), "videoHosting": video_hosting, "features": FEATURES, "draftsOnly": settings::drafts_only(&app), "platforms": platforms }))
}

// ---------- platform app keys (entered in the app) ----------

fn valid_public_url(v: &str) -> bool {
	match v.strip_prefix("https://") {
		Some(rest) => {
			let host = rest.split('/').next().unwrap_or("");
			!host.is_empty() && !host.chars().any(char::is_whitespace)
		}
		None => false,
	}
}
const PUBLIC_URL_HINT: &str = "Use the full https:// address of your tunnel.";

async fn setup(State(app): S) -> Response {
	ok(setup_view(&app))
}

async fn setup_put(State(app): S, Path(platform): Path<String>, body: Bytes) -> Response {
	let p = match platform_of(&platform) {
		Ok(p) => p,
		Err(r) => return r,
	};
	let b = parse(&body);
	let text = |k: &str| match &b[k] {
		Value::Null => Some(String::new()),
		Value::String(s) if s.encode_utf16().count() <= 300 => Some(s.clone()),
		_ => None,
	};
	let (Some(id), Some(secret), true) = (text("id"), text("secret"), b.is_object()) else { return fail(400, "Check the fields.") };
	let public = match &b["publicBaseUrl"] {
		Value::Null => None,
		Value::String(s) if s.encode_utf16().count() <= 300 => Some(s.trim().to_string()),
		_ => return fail(400, "Check the fields."),
	};
	// Instagram only: how it signs in, and the Unified login configuration ID.
	let config_id = match &b["configId"] {
		Value::Null => String::new(),
		Value::String(s) if s.encode_utf16().count() <= 60 => s.trim().to_string(),
		_ => return fail(400, "Check the fields."),
	};
	let login = match &b["loginMode"] {
		Value::Null => None,
		Value::String(s) if matches!(s.as_str(), "unified" | "facebook" | "instagram") => Some(s.clone()),
		_ => return fail(400, "Check the fields."),
	};
	let ig_mode = (p == Platform::Instagram).then(|| login.clone().or_else(|| (!config_id.is_empty()).then(|| "unified".to_string()))).flatten();
	let mut issues = check_keys(p, &id, &secret);
	if let Some(u) = public.as_deref().filter(|u| !u.is_empty()) {
		if !valid_public_url(u) {
			issues.push(Issue::new("publicBaseUrl", PUBLIC_URL_HINT));
		}
	}
	if ig_mode.as_deref() == Some("unified") && config_id.is_empty() && settings::get(&app, "INSTAGRAM_CONFIG_ID").is_empty() {
		issues.push(Issue::new("configId", "Paste the Configuration ID from your Unified login configuration."));
	}
	if p == Platform::Instagram && !config_id.is_empty() && !(config_id.len() >= 6 && config_id.bytes().all(|b| b.is_ascii_digit())) {
		issues.push(Issue::new("configId", "The configuration ID is a number."));
	}
	if !issues.is_empty() {
		return fail_with(422, "Check the highlighted fields.", &issues);
	}
	let f = fields(p);
	let trimmed_public = public.map(|u| u.trim_end_matches('/').to_string());
	let mut values: Vec<(&str, Option<&str>)> = vec![(f.id, Some(id.trim())), (f.secret, Some(secret.trim()))];
	if let Some(u) = &trimmed_public {
		values.push(("PUBLIC_BASE_URL", Some(u.as_str())));
	}
	// The connection type decides the sign-in: only Unified login keeps a configuration ID.
	match ig_mode.as_deref() {
		Some("unified") => {
			if !config_id.is_empty() {
				values.push(("INSTAGRAM_CONFIG_ID", Some(config_id.as_str())));
			}
			values.push(("INSTAGRAM_LOGIN", None));
		}
		Some(mode) => {
			values.push(("INSTAGRAM_CONFIG_ID", None));
			values.push(("INSTAGRAM_LOGIN", (mode == "facebook").then_some("facebook")));
		}
		None => {}
	}
	match settings::save(&app, &values) {
		Ok(()) => ok(setup_view(&app)),
		Err(e) => fail(500, &e),
	}
}

async fn setup_delete(State(app): S, Path(platform): Path<String>) -> Response {
	let p = match platform_of(&platform) {
		Ok(p) => p,
		Err(r) => return r,
	};
	let f = fields(p);
	let _ = settings::save(&app, &[(f.id, None), (f.secret, None)]);
	ok(setup_view(&app))
}

async fn setup_public_url(State(app): S, body: Bytes) -> Response {
	let b = parse(&body);
	let v = b["publicBaseUrl"].as_str().filter(|s| s.encode_utf16().count() <= 300).map(|s| s.trim().trim_end_matches('/').to_string()).unwrap_or_default();
	if !v.is_empty() && !valid_public_url(&v) {
		return fail_with(422, PUBLIC_URL_HINT, &[Issue::new("publicBaseUrl", PUBLIC_URL_HINT)]);
	}
	let _ = settings::save(&app, &[("PUBLIC_BASE_URL", (!v.is_empty()).then_some(v.as_str()))]);
	ok(setup_view(&app))
}

// ---------- accounts and OAuth ----------

async fn accounts_list(State(app): S) -> Response {
	ok(list_accounts(&app))
}

async fn account_delete(State(app): S, Path(id): Path<String>) -> Response {
	match accounts::disconnect(&app, &id).await {
		Ok(()) => ok(json!({ "ok": true })),
		Err(e) => fail(409, &e),
	}
}

/** Live, read-only check: asks the platform who this token belongs to. Nothing is posted. */
async fn account_verify(State(app): S, Path(id): Path<String>) -> Response {
	let Some(a) = get_account(&app, &id).filter(|a| a.status != "disconnected") else { return fail(404, "Account not found.") };
	let checked_at = now_ms();
	if a.is_demo {
		return ok(json!({ "ok": true, "simulated": true, "checkedAt": checked_at, "message": "Demo account: no live check is possible." }));
	}
	let label = a.platform.label();
	let check = async {
		let token = accounts::access_token(&app, &a.id).await?;
		platforms::identity(&app, a.platform, &token, &TokenSet { access_token: token.clone(), ..Default::default() }).await
	};
	match check.await {
		Ok(who) => {
			if who.external_id != a.external_id {
				return ok(json!({ "ok": false, "checkedAt": checked_at, "message": format!("Signed in as {}, which is a different account from the one saved here. Reconnect the right account.", who.display_name) }));
			}
			mark_account(&app, &a.id, "connected", None);
			ok(json!({ "ok": true, "checkedAt": checked_at, "message": format!("{label} confirmed this is {}.", who.display_name) }))
		}
		Err(e) => {
			let auth = e.is_auth();
			if auth {
				mark_account(&app, &a.id, "reconnect_required", Some(e.message()));
			}
			let message =
				if auth { "Sign-in expired or was revoked. Reconnect this account.".to_string() } else { format!("Could not reach {label} right now ({}). This does not mean the connection is broken.", e.message()) };
			ok(json!({ "ok": false, "checkedAt": checked_at, "reconnect": auth, "message": message }))
		}
	}
}

async fn demo_accounts(State(app): S) -> Response {
	if !app.cfg.demo_mode {
		return fail(404, "Demo mode is off.");
	}
	for (p, id, name, handle) in
		[(Platform::Tiktok, "demo-tt", "Demo TikTok", "@demo.tiktok"), (Platform::Instagram, "demo-ig", "Demo Instagram", "@demo.reels"), (Platform::Youtube, "demo-yt", "Demo YouTube", "@demochannel")]
	{
		let who = Identity { external_id: id.into(), display_name: name.into(), handle: Some(handle.into()), ..Default::default() };
		upsert_account(&app, p, &who, &TokenSet { access_token: "demo".into(), ..Default::default() }, true);
	}
	ok(list_accounts(&app))
}

/// Sign-in state lives on the server (one use, 10 minutes), so the callback works even though it
/// arrives in the system browser, which does not share the app window's cookies.
fn begin_oauth(app: &App, platform: Platform) -> String {
	let state = random_id(18);
	let (verifier, challenge) = pkce_pair();
	let via_relay = relay::hosted(app, platform);
	{
		let mut pending = app.pending_oauth.lock();
		let t = now_ms();
		pending.retain(|_, v| v.exp >= t);
		pending.insert(state.clone(), PendingOAuth { verifier, platform, exp: t + 600_000, via_relay });
	}
	if via_relay {
		relay::authorize_url(app, platform, &state, &challenge)
	} else {
		platforms::authorize_url(app, platform, &state, &challenge)
	}
}

async fn oauth_begin(State(app): S, Path(platform): Path<String>) -> Response {
	let p = match platform_of(&platform) {
		Ok(p) => p,
		Err(r) => return r,
	};
	if !relay::ready(&app, p) {
		return fail(409, &format!("{} is not set up yet. Add its app keys first.", p.label()));
	}
	ok(json!({ "url": begin_oauth(&app, p) }))
}

async fn oauth_start(State(app): S, Path(platform): Path<String>) -> Response {
	let p = match platform_of(&platform) {
		Ok(p) => p,
		Err(r) => return r,
	};
	if !relay::ready(&app, p) {
		return redirect(&format!("{}/accounts?error={}", app.cfg.app_url, encode_component(&format!("{platform} is not set up yet. Add its app keys first."))));
	}
	redirect(&begin_oauth(&app, p))
}

async fn oauth_callback(State(app): S, Path(platform): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
	let p = match platform_of(&platform) {
		Ok(p) => p,
		Err(r) => return r,
	};
	// One use only.
	let saved = q.get("state").and_then(|s| app.pending_oauth.lock().remove(s));
	// The callback opens in the system browser, so answer with a small page there.
	let done = |good: bool, msg: &str| html(callback_page(good, msg));
	let param = |k: &str| q.get(k).filter(|v| !v.is_empty());
	if param("error").map(String::as_str) == Some("access_denied") || param("error_reason").map(String::as_str) == Some("user_denied") {
		return done(
			false,
			&if p == Platform::Youtube {
				"Google cancelled the sign-in. Try Connect again: on \"Google hasn't verified this app\" click Continue (not Back to safety), then tick every permission box and click Continue. The Google account must also be a Test user on your consent screen while the app is in Testing.".to_string()
			} else {
				format!("{} cancelled the sign-in. Try Connect again and allow every permission it asks for. While your developer app is in testing, this account must be added as a tester there.", p.label())
			},
		);
	}
	if let Some(e) = param("error") {
		let detail = param("error_description").or(param("error_reason")).unwrap_or(e);
		return done(false, &format!("{platform}: {detail}"));
	}
	let Some(saved) = saved.filter(|s| s.platform == p && s.exp >= now_ms()) else {
		return done(false, "The sign-in link expired or did not match. Please try connecting again from the app.");
	};
	let Some(code) = param("code") else { return done(false, "The platform did not return an authorization code.") };
	let connect = async {
		let tokens = platforms::exchange_code(&app, p, code, &saved.verifier, saved.via_relay).await?;
		// One sign-in can share several accounts (Instagram through Facebook); all of them are connected.
		let mut names = Vec::new();
		for mut who in platforms::identities(&app, p, &tokens.access_token, &tokens).await? {
			if saved.via_relay {
				who.meta = Some(relay::mark(who.meta.take()));
			}
			let own = who.tokens.clone().unwrap_or_else(|| tokens.clone());
			names.push(upsert_account(&app, p, &who, &own, false).map(|a| a.display_name).unwrap_or(who.display_name));
		}
		Ok::<_, platforms::PubError>(names.join(", "))
	};
	match connect.await {
		Ok(name) => done(true, &name),
		Err(e) => {
			app.log.line(&format!("[api] oauth exchange failed for {platform}"));
			done(false, &format!("Could not connect {platform}: {}", redact(e.message())))
		}
	}
}

fn esc(s: &str) -> String {
	s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn callback_page(good: bool, msg: &str) -> String {
	let title = if good { format!("Connected {}", esc(msg)) } else { "Could not connect".to_string() };
	let body = if good { "You can close this tab and go back to Publisher. The account appears in Connected accounts.".to_string() } else { esc(msg) };
	let dot = if good { "#3ccf8b" } else { "#f0605e" };
	format!(
		r#"<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publisher</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0c0d;color:#ecebe8;font:15px/1.5 "Segoe UI",system-ui,sans-serif}}main{{max-width:420px;padding:28px;border:1px solid #2a2a2c;border-radius:14px;background:#151516}}b{{display:block;font-size:17px;margin-bottom:6px}}i{{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;background:{dot}}}</style>
<main><b><i></i>{title}</b><span>{body}</span></main>"#
	)
}

// ---------- media ----------

fn clean_filename(raw: &str) -> String {
	let mut out = String::new();
	let mut in_run = false;
	for c in raw.chars() {
		if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ' ') {
			out.push(c);
			in_run = false;
		} else if !in_run {
			out.push('_');
			in_run = true;
		}
	}
	out.chars().take(120).collect()
}

fn ext_for(filename: &str) -> String {
	let e: String = filename.rsplit('.').next().unwrap_or("mp4").to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect();
	if e.is_empty() {
		"mp4".into()
	} else {
		e
	}
}

fn mime_for_ext(ext: &str) -> Option<&'static str> {
	match ext {
		"mp4" | "m4v" => Some("video/mp4"),
		"mov" => Some("video/quicktime"),
		"webm" => Some("video/webm"),
		_ => None,
	}
}

/** Reads the file's facts, stores the media row and returns what the page shows. */
async fn register_media(app: &Arc<App>, id: String, file: PathBuf, filename: String, mime: String, size: u64) -> Result<Value, Response> {
	let info = {
		let (file, ffprobe) = (file.clone(), app.cfg.ffprobe.clone());
		tokio::task::spawn_blocking(move || probe::probe(&file, size, ffprobe.as_deref())).await.unwrap_or_default()
	};
	if info.video_codec.is_none() {
		let _ = tokio::fs::remove_file(&file).await;
		return Err(fail(422, "This file has no video stream. Only videos can be published."));
	}
	let stored = app.db().execute(
		"INSERT INTO media (id, path, filename, mime, size, duration, width, height, video_codec, audio_codec, fps, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		params![id, file.to_string_lossy(), filename, mime, size as i64, info.duration, info.width, info.height, info.video_codec, info.audio_codec, info.fps, now_ms()],
	);
	if stored.is_err() {
		let _ = tokio::fs::remove_file(&file).await;
		return Err(fail(500, "Could not save the video. Try again."));
	}
	db::get_media(app, &id, true).map(|m| media_view(&m)).ok_or_else(|| fail(500, "Could not save the video. Try again."))
}

/** Upload from the page (drag and drop). The body is streamed straight to disk. */
async fn media_put(State(app): S, req: Request) -> Response {
	let headers = req.headers().clone();
	let head = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
	let mime = head("content-type").split(';').next().unwrap_or("").trim().to_string();
	let raw_name = head("x-filename");
	let filename = clean_filename(&decode_component(if raw_name.is_empty() { "video.mp4" } else { &raw_name }));
	let length: u64 = head("content-length").parse().unwrap_or(0);
	if !VIDEO_MIME.contains(&mime.as_str()) && mime != "application/octet-stream" {
		return fail(415, "Only video files can be published.");
	}
	if length > app.cfg.max_upload_bytes {
		return fail(413, "File is too large.");
	}
	let id = random_id(12);
	let ext = ext_for(&filename);
	let dir = app.media_dir();
	let _ = tokio::fs::create_dir_all(&dir).await;
	let file = dir.join(format!("{id}.{ext}"));

	let written = async {
		let out = tokio::fs::File::create(&file).await.map_err(|_| ())?;
		let mut out = tokio::io::BufWriter::with_capacity(1024 * 1024, out);
		let mut stream = req.into_body().into_data_stream();
		let mut size = 0u64;
		while let Some(chunk) = stream.next().await {
			let chunk = chunk.map_err(|_| ())?;
			size += chunk.len() as u64;
			if size > app.cfg.max_upload_bytes {
				return Err(());
			}
			out.write_all(&chunk).await.map_err(|_| ())?;
		}
		out.flush().await.map_err(|_| ())?;
		Ok::<u64, ()>(size)
	};
	let size = match written.await {
		Ok(s) => s,
		Err(()) => {
			let _ = tokio::fs::remove_file(&file).await;
			return fail(400, "Upload was interrupted. Try again.");
		}
	};
	let detected = if mime == "application/octet-stream" { mime_for_ext(&ext).map(String::from).unwrap_or(mime) } else { mime };
	match register_media(&app, id, file, filename, detected, size).await {
		Ok(view) => ok(view),
		Err(r) => r,
	}
}

fn preview_url(app: &App, media_id: &str) -> String {
	format!("/m/{}", signed_token(&app.cfg.session_secret, json!({ "media": media_id }), 2 * 3600))
}

/** Lets a saved draft find its video again. Returns 404 once the file is cleaned up. */
async fn media_get(State(app): S, Path(id): Path<String>) -> Response {
	match db::get_media(&app, &id, true).filter(|m| std::path::Path::new(&m.path).exists()) {
		Some(m) => {
			let mut view = media_view(&m);
			view["previewUrl"] = Value::from(preview_url(&app, &m.id));
			ok(view)
		}
		None => fail(404, "This video is no longer on this computer. Upload it again."),
	}
}

/** Signed, short-lived link to a video: the in-app preview, and what Instagram downloads. */
async fn media_file(State(app): S, Path(token): Path<String>, headers: HeaderMap) -> Response {
	let not_found = || (StatusCode::NOT_FOUND, "Not found").into_response();
	let Some(data) = read_signed_token(&app.cfg.session_secret, &token) else { return not_found() };
	let Some(m) = data["media"].as_str().and_then(|id| db::get_media(&app, id, true)) else { return not_found() };
	send_file(&m, &headers).await.unwrap_or_else(not_found)
}

async fn send_file(m: &MediaRow, headers: &HeaderMap) -> Option<Response> {
	let mut file = tokio::fs::File::open(&m.path).await.ok()?;
	let total = file.metadata().await.ok()?.len();
	let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|r| r.split("bytes=").nth(1)).and_then(|r| {
		let (a, b) = r.split(',').next()?.trim().split_once('-')?;
		Some((a.trim().parse::<u64>().ok(), b.trim().parse::<u64>().ok()))
	});
	let mut res = Response::builder().header(header::ACCEPT_RANGES, "bytes").header(header::CONTENT_TYPE, m.mime.as_str()).header(header::CACHE_CONTROL, "no-store");
	let (start, len) = match range {
		Some((a, b)) => {
			let start = a.unwrap_or(0);
			let end = b.map(|e| e.min(total.saturating_sub(1))).unwrap_or(total.saturating_sub(1));
			if start > end || start >= total {
				return res.status(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE, format!("bytes */{total}")).body(Body::empty()).ok();
			}
			res = res.status(StatusCode::PARTIAL_CONTENT).header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
			(start, end - start + 1)
		}
		None => (0, total),
	};
	if start > 0 {
		file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
	}
	let stream = tokio_util::io::ReaderStream::with_capacity(file.take(len), 256 * 1024);
	res.header(header::CONTENT_LENGTH, len).body(Body::from_stream(stream)).ok()
}

// ---------- posts ----------

async fn posts_create(State(app): S, body: Bytes) -> Response {
	create_post(&app, &parse(&body)).await
}

/** Checks and saves a new post. Also used by the inbox folder, so a drop gets every normal check. */
pub(crate) async fn create_post(app: &Arc<App>, b: &Value) -> Response {
	let app = app.clone();
	let mut shape: Vec<Issue> = Vec::new();
	let key = b["idempotencyKey"].as_str().unwrap_or("");
	if !(8..=100).contains(&key.encode_utf16().count()) {
		shape.push(Issue::new("idempotencyKey", "Invalid request. Reload the page and try again."));
	}
	let media_id = b["mediaId"].as_str().unwrap_or("");
	if media_id.is_empty() {
		shape.push(Issue::new("mediaId", "Upload a video first."));
	}
	let caption = match &b["caption"] {
		Value::Null => "",
		Value::String(s) if s.encode_utf16().count() <= 5000 => s.as_str(),
		_ => {
			shape.push(Issue::new("caption", "Captions can be up to 5,000 characters."));
			""
		}
	};
	let empty = Vec::new();
	let wanted = b["targets"].as_array().unwrap_or(&empty);
	if wanted.is_empty() {
		shape.push(Issue::new("targets", "Choose at least one destination."));
	}
	for (i, t) in wanted.iter().enumerate() {
		if t["accountId"].as_str().unwrap_or("").is_empty() || !(t["settings"].is_null() || t["settings"].is_object()) {
			shape.push(Issue::new(format!("targets.{i}"), "This destination is not valid."));
		}
	}
	let scheduled_at = match &b["scheduledAt"] {
		Value::Null => None,
		v => match v.as_i64() {
			Some(at) if at > now_ms() + 60_000 && at < now_ms() + MAX_SCHEDULE_MS => Some(at),
			_ => {
				shape.push(Issue::new("scheduledAt", "Pick a time at least a minute from now and within 60 days."));
				None
			}
		},
	};
	if !shape.is_empty() {
		return fail_with(400, "Check the highlighted fields.", &shape);
	}

	let existing: Option<String> = {
		use rusqlite::OptionalExtension;
		app.db().query_row("SELECT id FROM posts WHERE idempotency_key = ?", [key], |r| r.get(0)).optional().ok().flatten()
	};
	if let Some(id) = existing {
		return ok(json!({ "post": jobs::post_view(&app, &id), "duplicate": true }));
	}
	let Some(m) = db::get_media(&app, media_id, true) else {
		return fail_with(400, "Upload the video again.", &[Issue::new("media", "The uploaded video is no longer available.")]);
	};

	let info = info_of(&m);
	let mut issues: Vec<Issue> = Vec::new();
	let mut targets: Vec<NewTarget> = Vec::new();
	let mut seen: Vec<String> = Vec::new();
	let mut demo: Option<bool> = None;
	for t in wanted {
		let account_id = t["accountId"].as_str().unwrap_or("");
		let mut settings = if t["settings"].is_object() { t["settings"].clone() } else { json!({}) };
		let Some(a) = get_account(&app, account_id).filter(|a| a.status != "disconnected") else {
			issues.push(Issue::new(format!("target.{account_id}"), "This account is not connected."));
			continue;
		};
		if settings::drafts_only(&app) {
			match as_draft(a.platform, &settings) {
				Some(d) => settings = d,
				None => {
					issues.push(Issue::new(format!("target.{}", a.id), DRAFTS_INSTAGRAM));
					continue;
				}
			}
		}
		if seen.contains(&a.id) {
			continue;
		}
		seen.push(a.id.clone());
		let is_demo = *demo.get_or_insert(a.is_demo);
		if is_demo != a.is_demo {
			issues.push(Issue::new(format!("target.{}", a.id), "Demo accounts and real accounts cannot be in the same post."));
		}
		if a.status == "reconnect_required" {
			issues.push(Issue::new(format!("target.{}", a.id), format!("Reconnect {} before publishing.", a.display_name)));
		}
		let av = platforms::availability(&app, a.platform, a.is_demo);
		if !av.available {
			issues.push(Issue::new(format!("target.{}", a.id), av.note));
		}
		let own = js_str(&settings["captionOverride"]);
		let effective = if own.trim().is_empty() { caption.to_string() } else { own.trim().to_string() };
		for i in validate_media(a.platform, &info, &m.mime, &m.filename).into_iter().chain(platforms::validate_settings(&app, a.platform, &settings, &effective)).chain(crate::covers::issues(&app, a.platform, &settings))
		{
			let field = if i.field == "media" { format!("media.{}", a.platform.as_str()) } else { i.field };
			issues.push(Issue::new(field, i.message));
		}
		targets.push(NewTarget { account_id: a.id.clone(), platform: a.platform.as_str().to_string(), settings });
	}
	if !issues.is_empty() {
		return fail_with(422, "Fix the highlighted fields before publishing.", &issues);
	}
	match jobs::create_post(&app, key, &m.id, caption, demo.unwrap_or(false), &targets, scheduled_at) {
		Ok((id, duplicate)) => {
			app.wake.notify_one();
			ok(json!({ "post": jobs::post_view(&app, &id), "duplicate": duplicate }))
		}
		Err(e) => {
			app.log.line(&format!("[api] could not create post: {e}"));
			fail(500, "Could not save the post. Try again.")
		}
	}
}

async fn posts_list(State(app): S) -> Response {
	ok(jobs::list_posts(&app, 50))
}

async fn post_get(State(app): S, Path(id): Path<String>) -> Response {
	match jobs::post_view(&app, &id) {
		Some(p) => ok(p),
		None => fail(404, "Not found"),
	}
}

const MAX_SCHEDULE_MS: i64 = 60 * 86_400_000;

/// `{ "at": <ms> }` moves a scheduled post; `{ "at": null }` publishes it now.
async fn post_schedule(State(app): S, Path(id): Path<String>, body: Bytes) -> Response {
	let b = parse(&body);
	let at = match &b["at"] {
		Value::Null => None,
		v => match v.as_i64() {
			Some(at) if at > now_ms() + 60_000 && at < now_ms() + MAX_SCHEDULE_MS => Some(at),
			_ => return fail_with(422, "Pick a time at least a minute from now and within 60 days.", &[Issue::new("scheduledAt", "Pick a time at least a minute from now and within 60 days.")]),
		},
	};
	if jobs::reschedule(&app, &id, at) == 0 {
		return fail(409, "This post has already started publishing, so its time cannot change.");
	}
	app.wake.notify_one();
	ok(json!({ "post": jobs::post_view(&app, &id) }))
}

async fn post_cancel(State(app): S, Path(id): Path<String>) -> Response {
	if jobs::cancel_scheduled(&app, &id) == 0 {
		return fail(409, "Nothing to cancel. Only destinations still waiting for their time can be cancelled.");
	}
	ok(json!({ "post": jobs::post_view(&app, &id) }))
}

async fn post_retry(State(app): S, Path(id): Path<String>, body: Bytes) -> Response {
	let b = parse(&body);
	let only: Option<Vec<String>> = b["targetIds"].as_array().filter(|a| a.iter().all(Value::is_string)).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect());
	let ids = jobs::retry_targets(&app, &id, only.as_deref());
	if ids.is_empty() {
		return fail(409, "Nothing to retry. Only failed destinations can be retried.");
	}
	app.wake.notify_one();
	ok(json!({ "retried": ids, "post": jobs::post_view(&app, &id) }))
}

// ---------- desktop bridge (what the Mac app does over Electron IPC) ----------

/// The window opens this link once at start to collect its cookie. The key works a single time and
/// is never written to the log.
async fn desktop_enter(State(app): S, Query(q): Query<HashMap<String, String>>) -> Response {
	let given = q.get("k").cloned().unwrap_or_default();
	// Only the right key uses it up, so another program on this PC cannot lock the window out by guessing.
	let accepted = {
		let mut slot = app.enter_nonce.lock();
		let good = slot.as_deref().map(|n| !given.is_empty() && constant_eq(n.as_bytes(), given.as_bytes())).unwrap_or(false);
		if good {
			slot.take();
		}
		good
	};
	match accepted {
		true => {
			let mut res = html("<!doctype html><meta charset=\"utf-8\"><title>Publisher</title><body style=\"background:#0c0c0d\"><script>location.replace('/')</script>".to_string());
			let set = format!("{DESKTOP_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", app.cfg.desktop_token);
			if let Ok(v) = HeaderValue::from_str(&set) {
				res.headers_mut().insert(header::SET_COOKIE, v);
			}
			res
		}
		_ => (StatusCode::FORBIDDEN, "This link has already been used. Open Publisher from its icon instead.").into_response(),
	}
}

async fn desktop_services(State(app): S) -> Response {
	let worker = match db::worker_status(&app)["state"].as_str() {
		Some("running") => "running",
		Some("stale") => "crashed",
		_ => "starting",
	};
	ok(
		json!({ "version": app.cfg.version, "api": "running", "worker": worker, "logsDir": app.cfg.logs_dir.to_string_lossy(), "dataDir": app.cfg.data_dir.to_string_lossy(), "port": app.cfg.port, "platform": std::env::consts::OS }),
	)
}

async fn desktop_upload_progress(State(app): S) -> Response {
	ok(json!({ "progress": app.upload_progress.load(Ordering::Relaxed) as f64 / 1000.0 }))
}

/// Native file picker. The chosen file is copied on disk into the app's media folder, which is much
/// faster than sending it through the page, and nothing is held in memory.
async fn desktop_pick_video(State(app): S) -> Response {
	let canceled = || ok(json!({ "canceled": true }));
	if app.shell.get().is_none() || app.picking.swap(true, Ordering::SeqCst) {
		return canceled();
	}
	app.upload_progress.store(0, Ordering::Relaxed);
	let picked = {
		let app = app.clone();
		tokio::task::spawn_blocking(move || app.shell.get().and_then(|s| s.pick_video())).await.ok().flatten()
	};
	let result = match picked {
		None => canceled(),
		Some(path) => import_picked(&app, path).await,
	};
	app.picking.store(false, Ordering::SeqCst);
	result
}

pub(crate) async fn import_picked(app: &Arc<App>, source: PathBuf) -> Response {
	let problem = |m: &str| ok(json!({ "canceled": false, "error": m }));
	let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "video.mp4".into());
	let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
	let Some(mime) = mime_for_ext(&ext) else { return problem("Only MP4, MOV or WebM videos can be published.") };
	let Ok(meta) = tokio::fs::metadata(&source).await else { return problem("That file could not be opened.") };
	let size = meta.len();
	if size > app.cfg.max_upload_bytes {
		return problem("File is too large.");
	}
	let id = random_id(12);
	let dir = app.media_dir();
	let _ = tokio::fs::create_dir_all(&dir).await;
	let dest = dir.join(format!("{id}.{ext}"));
	let copied = {
		let (app, source, dest) = (app.clone(), source.clone(), dest.clone());
		tokio::task::spawn_blocking(move || -> std::io::Result<u64> {
			use std::io::{Read, Write};
			let mut input = std::fs::File::open(&source)?;
			let mut output = std::fs::File::create(&dest)?;
			let mut buf = vec![0u8; 4 * 1024 * 1024];
			let mut done = 0u64;
			loop {
				let n = input.read(&mut buf)?;
				if n == 0 {
					break;
				}
				output.write_all(&buf[..n])?;
				done += n as u64;
				app.upload_progress.store(((done as f64 / size.max(1) as f64) * 1000.0) as u32, Ordering::Relaxed);
			}
			output.sync_all()?;
			Ok(done)
		})
		.await
	};
	let copied_size = match copied {
		Ok(Ok(n)) => n,
		_ => {
			let _ = tokio::fs::remove_file(&dest).await;
			app.log.line("[api] copying the chosen video failed");
			return problem("The video could not be copied into Publisher. Check free disk space and try again.");
		}
	};
	match register_media(app, id.clone(), dest, clean_filename(&name), mime.to_string(), copied_size).await {
		Ok(mut view) => {
			app.upload_progress.store(1000, Ordering::Relaxed);
			view["previewUrl"] = Value::from(preview_url(app, &id));
			ok(json!({ "canceled": false, "media": view, "filename": name, "size": copied_size }))
		}
		Err(_) => problem("This file has no video stream. Only videos can be published."),
	}
}

fn https_url(body: &Bytes) -> Option<url::Url> {
	let b = parse(body);
	let raw = b["url"].as_str()?;
	if raw.len() > 4000 {
		return None;
	}
	url::Url::parse(raw).ok().filter(|u| u.scheme() == "https" && u.host_str().is_some())
}

/** Opens a platform sign-in page in the default browser. Only the known sign-in hosts are allowed. */
async fn desktop_open_external(State(app): S, body: Bytes) -> Response {
	let relay_host = relay::host(&app);
	let allowed = https_url(&body).filter(|u| {
		let h = u.host_str().unwrap_or("");
		SIGN_IN_HOSTS.contains(&h) || relay_host.as_deref() == Some(h)
	});
	match (allowed, app.shell.get()) {
		(Some(u), Some(shell)) => {
			shell.open_url(u.as_str());
			ok(json!({ "ok": true }))
		}
		_ => ok(json!({ "ok": false })),
	}
}

/** Opens an https link the owner clicked in the page (setup guides, published posts) in the default browser. */
async fn desktop_open_link(State(app): S, body: Bytes) -> Response {
	match (https_url(&body), app.shell.get()) {
		(Some(u), Some(shell)) => {
			shell.open_url(u.as_str());
			ok(json!({ "ok": true }))
		}
		_ => ok(json!({ "ok": false })),
	}
}

async fn desktop_reveal_logs(State(app): S) -> Response {
	if let Some(shell) = app.shell.get() {
		shell.reveal(&app.cfg.logs_dir);
	}
	ok(json!({ "ok": true }))
}

// ---------- built UI ----------

async fn static_ui(req: Request) -> Response {
	let path = req.uri().path();
	if path.starts_with("/api/") {
		return fail(404, "Not found");
	}
	if !matches!(*req.method(), Method::GET | Method::HEAD) {
		return StatusCode::METHOD_NOT_ALLOWED.into_response();
	}
	let wanted = path.trim_start_matches('/');
	let (name, file) = match Ui::get(wanted).filter(|_| !wanted.is_empty()) {
		Some(f) => (wanted, f),
		// Client-side routes (/history, /accounts) all load the app shell.
		None => match Ui::get("index.html") {
			Some(f) => ("index.html", f),
			None => return (StatusCode::NOT_FOUND, "The interface was not built into this copy of Publisher.").into_response(),
		},
	};
	let mime = mime_guess::from_path(name).first_or_octet_stream();
	let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
	let mut res = Body::from(file.data.into_owned()).into_response();
	res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")));
	res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
	res
}

/// Script injected into the app window. It provides the same `window.publisher` bridge the Mac app's
/// preload does, implemented with calls to this server, and sends https links to the default browser.
pub fn bridge_script(origin: &str) -> String {
	format!(
		r#"(() => {{
	if (location.origin !== {origin:?} || window.publisher) return;
	const call = (method, url, body) => fetch(url, {{ method, credentials: 'same-origin', headers: {{ 'X-Requested-With': 'social-publisher', ...(body ? {{ 'Content-Type': 'application/json' }} : {{}}) }}, body: body ? JSON.stringify(body) : undefined }}).then((r) => r.json());
	window.publisher = Object.freeze({{
		platform: 'windows',
		async pickVideo(onProgress) {{
			const timer = setInterval(() => call('GET', '/api/desktop/upload-progress').then((j) => typeof j.progress === 'number' && onProgress(Math.max(0, Math.min(1, j.progress)))).catch(() => {{}}), 150);
			try {{
				return await call('POST', '/api/desktop/pick-video');
			}} catch {{
				return {{ canceled: false, error: 'The video could not be added. Try again.' }};
			}} finally {{
				clearInterval(timer);
			}}
		}},
		openExternal: (url) => call('POST', '/api/desktop/open-external', {{ url: String(url) }}).then((j) => Boolean(j.ok)).catch(() => false),
		revealLogs: () => call('POST', '/api/desktop/reveal-logs').then(() => undefined).catch(() => undefined),
		revealInbox: () => call('POST', '/api/desktop/reveal-inbox').then(() => undefined).catch(() => undefined),
		services: () => call('GET', '/api/desktop/services'),
	}});
	document.addEventListener('click', (e) => {{
		const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
		if (!a || !/^https:\/\//i.test(a.href) || a.origin === location.origin) return;
		e.preventDefault();
		call('POST', '/api/desktop/open-link', {{ url: a.href }}).catch(() => {{}});
	}}, true);
	window.addEventListener('contextmenu', (e) => {{
		const t = e.target;
		if (!(t && t.closest && t.closest('input, textarea, [contenteditable]'))) e.preventDefault();
	}});
}})();"#
	)
}

pub async fn serve(listener: tokio::net::TcpListener, app: Arc<App>) -> std::io::Result<()> {
	axum::serve(listener, router(app).into_make_service_with_connect_info::<std::net::SocketAddr>()).await
}

// ---------- phone access (see phone.rs) ----------

async fn phone_get(State(app): S) -> Response {
	ok(crate::phone::view(&app, None))
}

async fn phone_put(State(app): S, body: Bytes) -> Response {
	match parse(&body)["enabled"].as_bool() {
		Some(on) => match crate::phone::set_enabled(&app, on) {
			Ok(v) => ok(v),
			Err(e) => fail(500, &format!("Could not save phone access: {e}")),
		},
		None => fail(400, "Check the fields."),
	}
}

async fn phone_pair(State(app): S) -> Response {
	match crate::phone::pair(&app) {
		Ok(v) => ok(v),
		Err(m) => fail(409, m),
	}
}

async fn phone_remove(State(app): S, Path(id): Path<String>) -> Response {
	if crate::phone::remove(&app, &id) {
		ok(crate::phone::view(&app, None))
	} else {
		fail(404, "Not found")
	}
}

/** The phone opens the QR code's link: it is paired and lands in the app. */
async fn phone_redeem(State(app): S, Path(secret): Path<String>, headers: HeaderMap) -> Response {
	let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
	match crate::phone::redeem(&app, &secret, ua) {
		Some(value) => {
			let mut res = html("<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Publisher</title><body style=\"background:#0c0c0d\"><script>location.replace('/')</script>".to_string());
			if let Ok(v) = HeaderValue::from_str(&crate::phone::set_cookie(&value, &headers)) {
				res.headers_mut().insert(header::SET_COOKIE, v);
			}
			res
		}
		None => {
			let mut res = html(callback_page(false, "This pairing link has expired or was already used. In Publisher on the computer, open Connected accounts → Phone access and scan a new code."));
			*res.status_mut() = StatusCode::GONE;
			res
		}
	}
}

/** Windows app preferences kept in the database: whether finished posts are announced. */
fn prefs(app: &App) -> Value {
	json!({ "notifications": crate::notify::enabled(app), "draftsOnly": settings::drafts_only(app) })
}

async fn desktop_prefs(State(app): S) -> Response {
	ok(prefs(&app))
}

async fn desktop_prefs_put(State(app): S, body: Bytes) -> Response {
	let b = parse(&body);
	for (field, key) in [("notifications", "NOTIFY"), ("draftsOnly", "DRAFTS_ONLY")] {
		if let Some(on) = b[field].as_bool() {
			if let Err(e) = settings::save(&app, &[(key, if on { None } else { Some("off") })]) {
				return fail(500, &e);
			}
		}
	}
	ok(prefs(&app))
}

async fn desktop_reveal_inbox(State(app): S) -> Response {
	let dir = crate::inbox::dir(&app);
	let _ = std::fs::create_dir_all(&dir);
	if let Some(shell) = app.shell.get() {
		shell.reveal(&dir);
	}
	ok(json!({ "ok": true }))
}

async fn inbox_get(State(app): S) -> Response {
	ok(crate::inbox::status(&app))
}

// ---------- saved account groups ----------

async fn groups_list(State(app): S) -> Response {
	ok(crate::groups::list(&app))
}

async fn groups_create(State(app): S, body: Bytes) -> Response {
	let b = parse(&body);
	match crate::groups::clean(&app, &b["name"], &b["accountIds"]) {
		Ok((name, ids)) => ok(crate::groups::create(&app, &name, &ids)),
		Err(m) => fail(422, m),
	}
}

async fn groups_update(State(app): S, Path(id): Path<String>, body: Bytes) -> Response {
	let b = parse(&body);
	match crate::groups::clean(&app, &b["name"], &b["accountIds"]) {
		Ok((name, ids)) if crate::groups::update(&app, &id, &name, &ids) => ok(crate::groups::list(&app)),
		Ok(_) => fail(404, "Not found"),
		Err(m) => fail(422, m),
	}
}

async fn groups_delete(State(app): S, Path(id): Path<String>) -> Response {
	if crate::groups::delete(&app, &id) {
		ok(crate::groups::list(&app))
	} else {
		fail(404, "Not found")
	}
}

// ---------- Terms and Privacy pages (public; platform developer consoles ask for these links) ----------

fn legal_page(title: &str, body: &str) -> Response {
	let mut res = html(format!(
		r#"<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publisher · {title}</title><style>body{{font:16px/1.6 "Segoe UI",system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#ddd;background:#16161a}}h1{{font-size:24px}}h2{{font-size:17px;margin-top:28px}}</style><h1>{title}</h1>{body}<p style="color:#888;margin-top:32px">Last updated 16 November 2026</p></html>"#
	));
	res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
	res
}

async fn terms_page() -> Response {
	legal_page("Terms of Service", "
<p>Publisher is a private, single-user tool. Its owner uses it to upload their own videos to their own YouTube, Instagram and TikTok accounts. It is not offered to the public.</p>
<h2>Use</h2><p>Only the owner may use Publisher, and only with accounts they own or are allowed to manage. Each post is started by the owner. Publisher never posts on its own.</p>
<h2>Platforms</h2><p>Using Publisher with YouTube, Instagram or TikTok is also subject to those platforms' own terms and community guidelines. The owner is responsible for the content they post, including having the rights to any music.</p>
<h2>No warranty</h2><p>Publisher is provided as is, without any warranty.</p>")
}

async fn privacy_page() -> Response {
	legal_page("Privacy Policy", "
<p>Publisher is a private tool that runs on its owner's own computer. It has no other users and no servers of its own.</p>
<h2>What it stores</h2><p>When the owner connects an account, Publisher stores the sign-in token and basic profile details (name, handle, avatar) on the owner's computer, encrypted with a key protected by Windows for the signed-in user. It also keeps the owner's videos, captions and post history there.</p>
<h2>How it is used</h2><p>This data is used only to upload the owner's videos and to show their own post statistics. Publisher has no ads or analytics trackers, and it does not sell or share data with anyone except the platform a video is being posted to.</p>
<h2>Deleting data</h2><p>Disconnecting an account in Publisher deletes its token. Access can also be removed at any time in the platform's own app settings. Uploaded video copies are deleted automatically after a few days.</p>")
}

/** The owner finished a TikTok inbox draft in the TikTok app. `permalink` is optional. */
async fn target_posted(State(app): S, Path(id): Path<String>, body: Bytes) -> Response {
	let b = parse(&body);
	let link = match jobs::tiktok_link(b["permalink"].as_str().unwrap_or("")) {
		Ok(l) => l,
		Err(m) => return fail_with(422, m, &[Issue::new("permalink", m)]),
	};
	match jobs::mark_posted(&app, &id, link.as_deref()) {
		Ok(post_id) => ok(json!({ "post": jobs::post_view(&app, &post_id) })),
		Err(m) => fail(409, m),
	}
}

/** Saves a cover image (JPEG or PNG, up to 8 MB) for a YouTube thumbnail or an Instagram cover. */
async fn cover_put(State(app): S, body: Bytes) -> Response {
	match crate::covers::save(&app, &body) {
		Ok(v) => ok(v),
		Err(m) => fail(422, m),
	}
}

async fn cover_get(State(app): S, Path(id): Path<String>, headers: HeaderMap) -> Response {
	let not_found = || (StatusCode::NOT_FOUND, "Not found").into_response();
	let Some(m) = crate::covers::get(&app, &id) else { return not_found() };
	send_file(&m, &headers).await.unwrap_or_else(not_found)
}

/** Account stats: `?days=7|28|90`, optional `account=<id>`, and `fresh=1` to skip the 10-minute cache. */
async fn analytics_get(State(app): S, Query(q): Query<HashMap<String, String>>) -> Response {
	let days = q.get("days").and_then(|d| d.parse::<i64>().ok()).unwrap_or(28);
	let fresh = q.get("fresh").map(|v| v == "1").unwrap_or(false);
	ok(crate::analytics::report(&app, days, q.get("account").map(String::as_str), fresh).await)
}
