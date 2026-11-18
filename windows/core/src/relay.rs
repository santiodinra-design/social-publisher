//! One-click sign-in through the operator's hosted relay (the Cloudflare Worker in `relay/`).
//!
//! When a relay address is built in (`PUBLISHER_RELAY_URL` at build time, or `relayUrl` in
//! settings.json) and the owner has not saved developer keys for a platform, that platform is
//! "hosted": Connect opens the relay, which holds the client secret and the registered HTTPS
//! redirect, and the relay sends the browser back to this app on 127.0.0.1. Customers never create
//! developer apps or tunnels. Developer keys saved in the app still take priority, so the owner can
//! test with sandbox keys.
//!
//! Tokens are stored here exactly as before. Accounts connected through the relay carry
//! `"via": "relay"` in their meta, so refreshes and revokes go back through the relay.
use crate::db::{AccountRow, Platform};
use crate::platforms::http::{json, send, Req};
use crate::platforms::{Ctx, PubError, TokenSet};
use crate::util::{encode_component, js_str, now_ms};
use crate::{settings, App};
use serde_json::{json as j, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/** The relay origin without a trailing slash, if one is configured. */
pub fn base(app: &App) -> Option<&str> {
	app.endpoints.relay.as_deref().map(|s| s.trim_end_matches('/')).filter(|s| !s.is_empty())
}

/** Connect goes through the relay: one is configured for this platform and no developer keys are saved. */
pub fn hosted(app: &App, p: Platform) -> bool {
	base(app).is_some() && app.endpoints.relay_platforms.contains(&p) && !settings::configured(app, p)
}

/** The platform can be connected, either with saved developer keys or through the relay. */
pub fn ready(app: &App, p: Platform) -> bool {
	settings::configured(app, p) || hosted(app, p)
}

/** The account's tokens were issued through the relay's app, so they must be refreshed there too. */
pub fn via_relay(a: &AccountRow) -> bool {
	a.meta.as_deref().and_then(|m| serde_json::from_str::<Value>(m).ok()).map(|m| m["via"] == "relay").unwrap_or(false)
}

/** Adds the relay marker to an account's meta. */
pub fn mark(meta: Option<Value>) -> Value {
	let mut m = meta.filter(Value::is_object).unwrap_or_else(|| j!({}));
	m["via"] = Value::from("relay");
	m
}

/** The relay's sign-in page. The relay puts this app's port into the platform state and strips it again on the way back. */
pub fn authorize_url(app: &App, p: Platform, state: &str, challenge: &str) -> String {
	let b = base(app).unwrap_or_default();
	let pkce = if p == Platform::Youtube { format!("&challenge={}", encode_component(challenge)) } else { String::new() };
	format!("{b}/start/{}?port={}&state={}{pkce}", p.as_str(), app.cfg.port, encode_component(state))
}

/** The relay's host, so the desktop bridge may open it in the browser. */
pub fn host(app: &App) -> Option<String> {
	base(app).and_then(|b| reqwest::Url::parse(b).ok()).and_then(|u| u.host_str().map(String::from))
}

fn token_set(p: Platform, t: &Value) -> TokenSet {
	let n = now_ms();
	let secs = |v: &Value| v.as_f64().filter(|s| *s > 0.0).map(|s| n + (s * 1000.0) as i64);
	let default_life = match p {
		Platform::Youtube => Some(n + 3600 * 1000),
		Platform::Instagram => Some(n + 60 * 86_400_000),
		Platform::Tiktok => None,
	};
	let scopes = match (&t["scope"], &t["permissions"]) {
		(Value::String(s), _) => Some(s.clone()),
		(_, Value::Array(a)) => Some(a.iter().map(js_str).collect::<Vec<_>>().join(",")),
		_ => None,
	};
	TokenSet {
		access_token: js_str(&t["access_token"]),
		refresh_token: t["refresh_token"].as_str().map(String::from),
		access_expires_at: secs(&t["expires_in"]).or(default_life),
		refresh_expires_at: secs(&t["refresh_expires_in"]),
		scopes,
	}
}

fn missing_token(t: &Value) -> Result<(), PubError> {
	if t["access_token"].as_str().unwrap_or("").is_empty() {
		// TikTok reports some errors with HTTP 200 and an error field.
		let why = [js_str(&t["error"]), js_str(&t["error_description"])].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(": ");
		return Err(if why.contains("invalid_grant") { PubError::auth(why) } else { PubError::permanent(if why.is_empty() { "The sign-in service returned no token".into() } else { why }) });
	}
	Ok(())
}

pub async fn exchange_code(app: &App, p: Platform, code: &str, verifier: &str) -> Result<TokenSet, PubError> {
	let url = format!("{}/token/{}", base(app).unwrap_or_default(), p.as_str());
	let body = if p == Platform::Youtube { j!({ "code": code, "verifier": verifier }) } else { j!({ "code": code }) };
	let t = json(app, Req::post(&url).json_body(&body)).await?;
	missing_token(&t)?;
	Ok(token_set(p, &t))
}

pub async fn refresh(app: &App, p: Platform, refresh_token: Option<&str>) -> Result<TokenSet, PubError> {
	let Some(rt) = refresh_token.filter(|s| !s.is_empty()) else { return Err(PubError::permanent("No refresh token stored")) };
	let url = format!("{}/refresh/{}", base(app).ok_or_else(|| PubError::permanent("This account was connected through the sign-in service, which this build does not have"))?, p.as_str());
	let t = json(app, Req::post(&url).json_body(&j!({ "refreshToken": rt }))).await?;
	missing_token(&t)?;
	let mut set = token_set(p, &t);
	// Google does not send a new refresh token; keep the one that works.
	set.refresh_token = set.refresh_token.or_else(|| Some(rt.to_string()));
	Ok(set)
}

/** Best effort, like the direct revoke. */
pub async fn revoke_tiktok(app: &App, access_token: Option<&str>) {
	if let (Some(b), Some(t)) = (base(app), access_token) {
		let url = format!("{b}/revoke/tiktok");
		let _ = send(app, Req::post(&url).json_body(&j!({ "token": t }))).await;
	}
}

// ---------- Instagram video hosting ----------

/// A file Instagram downloads from the relay: the video, or the Reel's cover image.
pub struct Hosted<'a> {
	/// Prefix of the keys kept in the destination's checkpoints, for example `hosted` or `hostedCover`.
	pub prefix: &'a str,
	pub path: &'a str,
	pub size: u64,
	pub mime: &'a str,
	pub what: &'a str,
}

/// Instagram Login can only publish a Reel from a public URL. Without a tunnel of the owner's own,
/// the video is uploaded to the relay's temporary storage and Instagram downloads it from a signed
/// link. The link is reused while it has at least 30 minutes left.
pub async fn host_media(ctx: &mut Ctx, ig_token: &str) -> Result<String, PubError> {
	let (path, mime) = (ctx.media.path.clone(), ctx.media.mime.clone());
	host_file(ctx, ig_token, Hosted { prefix: "hosted", path: &path, size: ctx.media.size.max(0) as u64, mime: &mime, what: "video" }).await
}

pub async fn host_file(ctx: &mut Ctx, ig_token: &str, f: Hosted<'_>) -> Result<String, PubError> {
	let key_of = |k: &str| format!("{}{k}", f.prefix);
	let rf = ctx.rf();
	if let (Some(url), Some(exp)) = (rf[key_of("Url")].as_str(), rf[key_of("Exp")].as_i64()) {
		if exp - now_ms() > 30 * 60_000 {
			return Ok(url.to_string());
		}
	}
	if !std::path::Path::new(f.path).exists() {
		ctx.need_file()?;
		return Err(PubError::permanent(format!("The {} is no longer on this computer.", f.what)));
	}
	let app = ctx.app.clone();
	let b = base(&app).ok_or_else(|| PubError::attention("Instagram needs a public address to download the video from, and this build has no sign-in service."))?.to_string();
	let size = f.size;
	let created = json(&app, Req::post(&format!("{b}/media")).bearer(ig_token).json_body(&j!({ "size": size, "type": f.mime }))).await?;
	let (id, upload_id, key) = (js_str(&created["id"]), js_str(&created["uploadId"]), js_str(&created["key"]));
	let part_size = created["partSize"].as_u64().filter(|n| *n > 0).unwrap_or(50 * 1024 * 1024);
	if id.is_empty() || upload_id.is_empty() || key.is_empty() {
		return Err(PubError::transient(format!("The sign-in service did not start the {} upload", f.what)));
	}
	ctx.log(&format!("Uploading the {} to temporary storage so Instagram can download it.", f.what));
	let read_err = |e: std::io::Error| PubError::transient(format!("Could not read the {}: {e}", f.what));
	let mut file = tokio::fs::File::open(f.path).await.map_err(read_err)?;
	let mut parts = Vec::new();
	let mut sent = 0u64;
	let mut n = 1u32;
	while sent < size {
		let len = part_size.min(size - sent) as usize;
		let mut buf = vec![0u8; len];
		file.seek(std::io::SeekFrom::Start(sent)).await.map_err(read_err)?;
		file.read_exact(&mut buf).await.map_err(read_err)?;
		let url = format!("{b}/media/{id}/parts/{n}?uploadId={}", encode_component(&upload_id));
		let r = json(&app, Req::put(&url).header("x-media-key", key.clone()).body(buf).timeout(10 * 60_000)).await?;
		parts.push(j!({ "partNumber": r["partNumber"].as_u64().unwrap_or(n as u64), "etag": js_str(&r["etag"]) }));
		sent += len as u64;
		n += 1;
		if f.prefix == "hosted" {
			ctx.save(crate::jobs::Patch::new().state("uploading").phase("hosting").progress(0.05 * (sent as f64 / size.max(1) as f64)));
		}
	}
	let done = json(&app, Req::post(&format!("{b}/media/{id}/complete")).header("x-media-key", key.clone()).json_body(&j!({ "uploadId": upload_id, "parts": parts }))).await?;
	let url = js_str(&done["url"]);
	if url.is_empty() {
		return Err(PubError::transient(format!("The sign-in service did not return a {} link", f.what)));
	}
	let mut r = ctx.rf();
	r[key_of("Id")] = Value::from(id);
	r[key_of("Key")] = Value::from(key);
	r[key_of("Url")] = Value::from(url.clone());
	r[key_of("Exp")] = Value::from(done["expiresAt"].as_i64().unwrap_or(now_ms() + 6 * 3600 * 1000));
	ctx.save(crate::jobs::Patch::new().rf(r));
	Ok(url)
}

/// Deletes the hosted copies (video and cover) once Instagram has them, or no longer needs them.
/// Best effort: the relay deletes anything left over within 24 hours.
pub async fn release_media(ctx: &mut Ctx) {
	let mut r = ctx.rf();
	let mut changed = false;
	for prefix in ["hosted", "hostedCover"] {
		let k = |s: &str| format!("{prefix}{s}");
		let (id, key) = (js_str(&r[k("Id")]), js_str(&r[k("Key")]));
		if id.is_empty() || key.is_empty() {
			continue;
		}
		if let Some(b) = base(&ctx.app) {
			let url = format!("{b}/media/{id}");
			let _ = send(&ctx.app, Req::new(reqwest::Method::DELETE, &url).header("x-media-key", key)).await;
		}
		if let Some(o) = r.as_object_mut() {
			for s in ["Id", "Key", "Url", "Exp"] {
				o.remove(&k(s));
			}
		}
		changed = true;
	}
	if changed {
		ctx.save(crate::jobs::Patch::new().rf(r));
	}
}
