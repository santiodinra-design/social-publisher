//! Instagram API with Instagram Login, for professional accounts (port of `server/platforms/instagram.ts`).
//! Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing/
//!
//! Reels are published from a public video URL that Instagram downloads. With a public address of the
//! owner's own (a tunnel), this app serves each video at a short-lived signed URL under it. Otherwise
//! the video goes to the sign-in relay's temporary storage for a few minutes (see `relay.rs`).
use super::http::{json, Req};
use super::{Availability, Ctx, Identity, Outcome, PubError, Reconciled, TokenSet};
use crate::crypto::signed_token;
use crate::db::{AccountRow, Platform};
use crate::jobs::Patch;
use crate::media::Issue;
use crate::settings::{get, is_https, public_base_url, redirect_uri};
use crate::util::{form, js_len, js_num, js_str, js_truthy, now_ms};
use crate::App;
use regex::Regex;
use serde_json::{json as j, Value};
use std::sync::LazyLock;

const DAY: i64 = 86_400_000;

/// Unified login and Facebook Login sign in through Facebook and call graph.facebook.com.
/// Instagram Login (the default) uses graph.instagram.com. Each account remembers its route in `meta.via`.
pub const FB_GRAPH: &str = "https://graph.facebook.com/v27.0";
const FB_DIALOG: &str = "https://www.facebook.com/v27.0/dialog/oauth";
const FB_SCOPES: &str = "instagram_basic,instagram_content_publish,instagram_manage_insights,pages_show_list,pages_read_engagement,business_management";

/** How Instagram signs in: "unified" (a Meta configuration ID), "facebook" (Facebook Login with Pages) or "instagram". */
pub fn login_mode(app: &App) -> &'static str {
	if !get(app, "INSTAGRAM_CONFIG_ID").is_empty() {
		"unified"
	} else if get(app, "INSTAGRAM_LOGIN") == "facebook" {
		"facebook"
	} else {
		"instagram"
	}
}

/** The account was connected through Unified login or Facebook Login, so it lives on graph.facebook.com. */
pub fn via_facebook(a: &AccountRow) -> bool {
	a.meta.as_deref().and_then(|m| serde_json::from_str::<Value>(m).ok()).map(|m| matches!(m["via"].as_str(), Some("unified" | "facebook"))).unwrap_or(false)
}

fn graph_for(app: &App, a: &AccountRow) -> String {
	if via_facebook(a) {
		FB_GRAPH.to_string()
	} else {
		graph(app)
	}
}

fn graph(app: &App) -> String {
	format!("{}/{}", app.endpoints.instagram_graph, app.cfg.instagram_api_version)
}

pub fn public_media_url(app: &App, media_id: &str) -> String {
	format!("{}/m/{}", public_base_url(app).trim_end_matches('/'), signed_token(&app.cfg.session_secret, j!({ "media": media_id }), 6 * 3600))
}

/// Where Instagram downloads the video from: the owner's own public address (a tunnel to this app)
/// when one is set, otherwise the sign-in relay's temporary storage.
enum Source {
	Local,
	Relay,
	None,
}

fn source(app: &App) -> Source {
	if is_https(&public_base_url(app)) {
		Source::Local
	} else if crate::relay::base(app).is_some() && app.endpoints.relay_platforms.contains(&Platform::Instagram) {
		Source::Relay
	} else {
		Source::None
	}
}

pub fn availability(app: &App) -> Availability {
	if !matches!(source(app), Source::None) {
		Availability { available: true, mode: "reels", note: "Publishes Reels to a professional (Business or Creator) account.".into() }
	} else {
		Availability { available: false, mode: "reels", note: "Instagram downloads the video from a public HTTPS address. Set PUBLIC_BASE_URL (for example a tunnel to this app) to publish.".into() }
	}
}

static RE_HASHTAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#[\p{L}\p{N}_]+").unwrap());
static RE_MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@[A-Za-z0-9_.]+").unwrap());

pub fn validate_settings(s: &Value, caption: &str) -> Vec<Issue> {
	let mut out = Vec::new();
	if js_len(caption) > 2200 {
		out.push(Issue::new("caption.instagram", "Instagram captions are limited to 2,200 characters."));
	}
	if RE_HASHTAG.find_iter(caption).count() > 30 {
		out.push(Issue::new("caption.instagram", "Instagram allows up to 30 hashtags."));
	}
	if RE_MENTION.find_iter(caption).count() > 20 {
		out.push(Issue::new("caption.instagram", "Instagram allows up to 20 @mentions."));
	}
	let thumb = &s["thumbOffsetMs"];
	if !thumb.is_null() && (js_num(thumb).is_nan() || js_num(thumb) < 0.0) {
		out.push(Issue::new("instagram.thumb", "Cover frame must be a time in the video."));
	}
	out
}

pub fn authorize_url(app: &App, state: &str) -> String {
	let (id, back) = (get(app, "INSTAGRAM_APP_ID"), redirect_uri(app, Platform::Instagram));
	match login_mode(app) {
		// Unified login: the configuration set up in Meta decides the permissions and token lifetime.
		"unified" => {
			let cfg = get(app, "INSTAGRAM_CONFIG_ID");
			let q = form(&[("client_id", &id), ("config_id", &cfg), ("redirect_uri", &back), ("response_type", "code"), ("override_default_response_type", "true"), ("state", state)]);
			format!("{FB_DIALOG}?{q}")
		}
		// Facebook Login: sign in with Facebook, then choose the Pages whose Instagram accounts to share.
		"facebook" => {
			let q = form(&[("client_id", &id), ("redirect_uri", &back), ("response_type", "code"), ("scope", FB_SCOPES), ("auth_type", "rerequest"), ("state", state)]);
			format!("{FB_DIALOG}?{q}")
		}
		_ => {
			let q = form(&[
				("client_id", &id),
				("redirect_uri", &back),
				("response_type", "code"),
				("scope", "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights"),
				// Ask for the account's credentials even when Instagram is already signed in, so a second account can be added.
				("force_reauth", "true"),
				("state", state),
			]);
			format!("https://www.instagram.com/oauth/authorize?{q}")
		}
	}
}

fn expires(t: &Value) -> Option<i64> {
	t["expires_in"].as_f64().filter(|s| *s > 0.0).map(|s| now_ms() + s as i64 * 1000)
}

/** Unified login and Facebook Login: swap the code on graph.facebook.com. */
async fn exchange_facebook(app: &App, code: &str, facebook: bool) -> Result<TokenSet, PubError> {
	let (id, secret, back) = (get(app, "INSTAGRAM_APP_ID"), get(app, "INSTAGRAM_APP_SECRET"), redirect_uri(app, Platform::Instagram));
	let q = form(&[("client_id", &id), ("client_secret", &secret), ("redirect_uri", &back), ("code", code)]);
	let t = json(app, Req::get(&format!("{FB_GRAPH}/oauth/access_token?{q}"))).await?;
	if !facebook {
		// Portfolio-owned token. Its lifetime comes from the configuration ("Never" is recommended).
		return Ok(TokenSet { access_token: js_str(&t["access_token"]), access_expires_at: expires(&t), ..Default::default() });
	}
	// Long-lived user token; each Page's token taken from it does not expire.
	let l = form(&[("grant_type", "fb_exchange_token"), ("client_id", &id), ("client_secret", &secret), ("fb_exchange_token", &js_str(&t["access_token"]))]);
	let long = json(app, Req::get(&format!("{FB_GRAPH}/oauth/access_token?{l}"))).await?;
	Ok(TokenSet { access_token: js_str(&long["access_token"]), access_expires_at: expires(&long), ..Default::default() })
}

/// Every Instagram account a sign-in shares. Unified login and Facebook Login can share several.
pub async fn identities(app: &App, access_token: &str) -> Result<Vec<Identity>, PubError> {
	let who = |a: &Value, fallback: &str, meta: Value, tokens: Option<TokenSet>| {
		let (name, user) = (js_str(&a["name"]), js_str(&a["username"]));
		Identity {
			external_id: js_str(&a["id"]),
			display_name: [name, user.clone(), fallback.to_string()].into_iter().find(|s| !s.is_empty()).unwrap_or_default(),
			handle: (!user.is_empty()).then(|| format!("@{user}")),
			avatar_url: a["profile_picture_url"].as_str().map(String::from),
			meta: Some(meta),
			tokens,
		}
	};
	match login_mode(app) {
		"facebook" => {
			let r = json(app, Req::get(&format!("{FB_GRAPH}/me/accounts?fields=name,access_token,instagram_business_account{{id,username,name,profile_picture_url}}&limit=100")).bearer(access_token)).await?;
			let list: Vec<Identity> = r["data"]
				.as_array()
				.into_iter()
				.flatten()
				.filter(|p| js_truthy(&p["instagram_business_account"]["id"]))
				.map(|p| who(&p["instagram_business_account"], &js_str(&p["name"]), j!({ "via": "facebook", "pageId": p["id"] }), Some(TokenSet { access_token: js_str(&p["access_token"]), ..Default::default() })))
				.collect();
			if list.is_empty() {
				return Err(PubError::attention("No Instagram account came through. Link each Instagram account to a Facebook Page you manage, then connect again and tick those Pages when Facebook asks."));
			}
			Ok(list)
		}
		"unified" => {
			let r = json(app, Req::get(&format!("{FB_GRAPH}/me/assigned_instagram_accounts?fields=id,username,name,profile_picture_url")).bearer(access_token)).await?;
			let list: Vec<Identity> = r["data"].as_array().into_iter().flatten().map(|a| who(a, "Instagram account", j!({ "via": "unified" }), None)).collect();
			if list.is_empty() {
				return Err(PubError::attention("Meta did not share any Instagram account. Sign in again and tick your Instagram account(s) when asked, and make sure your Meta configuration includes the business_management permission."));
			}
			Ok(list)
		}
		_ => Ok(vec![identity(app, access_token).await?]),
	}
}

fn long_expiry(t: &Value) -> i64 {
	now_ms() + t["expires_in"].as_f64().unwrap_or(60.0 * 86400.0) as i64 * 1000
}

pub async fn exchange_code(app: &App, code: &str) -> Result<TokenSet, PubError> {
	match login_mode(app) {
		"unified" => return exchange_facebook(app, code, false).await,
		"facebook" => return exchange_facebook(app, code, true).await,
		_ => {}
	}
	let secret = get(app, "INSTAGRAM_APP_SECRET");
	let url = format!("{}/oauth/access_token", app.endpoints.instagram_api);
	let short = json(
		app,
		Req::post(&url).form(&[("client_id", &get(app, "INSTAGRAM_APP_ID")), ("client_secret", &secret), ("grant_type", "authorization_code"), ("redirect_uri", &redirect_uri(app, Platform::Instagram)), ("code", code)]),
	)
	.await?;
	// Swap the 1-hour token for a 60-day one.
	let q = form(&[("grant_type", "ig_exchange_token"), ("client_secret", &secret), ("access_token", &js_str(&short["access_token"]))]);
	let long = json(app, Req::get(&format!("{}/access_token?{q}", app.endpoints.instagram_graph))).await?;
	let scopes = match &short["permissions"] {
		Value::Array(a) => Some(a.iter().map(js_str).collect::<Vec<_>>().join(",")),
		Value::Null => Some(String::new()),
		_ => None,
	};
	Ok(TokenSet { access_token: js_str(&long["access_token"]), refresh_token: None, access_expires_at: Some(long_expiry(&long)), refresh_expires_at: None, scopes })
}

pub async fn refresh(app: &App, account: &AccountRow, access_token: Option<&str>) -> Result<TokenSet, PubError> {
	let Some(token) = access_token.filter(|s| !s.is_empty()) else { return Err(PubError::permanent("No token stored")) };
	if via_facebook(account) {
		// Facebook-route tokens are not refreshed by the app; an expired one means signing in again.
		if account.access_expires_at.map(|t| t > now_ms()).unwrap_or(true) {
			return Ok(TokenSet { access_token: token.to_string(), access_expires_at: account.access_expires_at, ..Default::default() });
		}
		return Err(PubError::auth("This Instagram sign-in has expired. Reconnect it in Connected accounts."));
	}
	// Long-lived tokens can be refreshed once they are at least 24 hours old and not yet expired.
	if now_ms() - account.updated_at < DAY && account.access_expires_at.unwrap_or(0) > now_ms() {
		return Ok(TokenSet { access_token: token.to_string(), access_expires_at: account.access_expires_at, ..Default::default() });
	}
	let q = form(&[("grant_type", "ig_refresh_token"), ("access_token", token)]);
	let t = json(app, Req::get(&format!("{}/refresh_access_token?{q}", app.endpoints.instagram_graph))).await?;
	Ok(TokenSet { access_token: js_str(&t["access_token"]), access_expires_at: Some(long_expiry(&t)), ..Default::default() })
}

pub async fn identity(app: &App, access_token: &str) -> Result<Identity, PubError> {
	let url = format!("{}/me?fields=user_id,username,name,profile_picture_url,account_type", graph(app));
	let me = json(app, Req::get(&url).bearer(access_token)).await?;
	let kind = &me["account_type"];
	if js_truthy(kind) && !matches!(js_str(kind).as_str(), "BUSINESS" | "MEDIA_CREATOR" | "CREATOR") {
		return Err(PubError::attention("This Instagram account is personal. Switch it to a Professional (Business or Creator) account to publish."));
	}
	let username = js_str(&me["username"]);
	let name = js_str(&me["name"]);
	Ok(Identity {
		external_id: js_str(if me["user_id"].is_null() { &me["id"] } else { &me["user_id"] }),
		display_name: if name.is_empty() { username.clone() } else { name },
		handle: (!username.is_empty()).then(|| format!("@{username}")),
		avatar_url: me["profile_picture_url"].as_str().map(String::from),
		meta: Some(j!({ "accountType": kind })),
		tokens: None,
	})
}

pub async fn reconcile(ctx: &mut Ctx) -> Result<Reconciled, PubError> {
	if let Some(id) = ctx.target.remote_id.clone() {
		return Ok(Reconciled::Done(finish_with(ctx, &id, None).await?));
	}
	// A Reel only goes live through media_publish with a container ID. Without a stored container,
	// that call was never made, so a new container cannot duplicate anything.
	let container_id = js_str(&ctx.rf()["containerId"]);
	if container_id.is_empty() {
		return Ok(Reconciled::Restart);
	}
	// Lookup errors are returned so the container is kept and checked again later.
	let c = container(ctx, &container_id).await?;
	match c["status_code"].as_str().unwrap_or("") {
		"PUBLISHED" => Ok(Reconciled::Done(match_published(ctx).await?)),
		// Instagram says this container was never published (it failed or expired), so a fresh one is safe.
		"ERROR" | "EXPIRED" => {
			crate::relay::release_media(ctx).await;
			ctx.save(Patch::new().clear_ref().clear_phase().progress(0.0));
			Ok(Reconciled::Restart)
		}
		// FINISHED or IN_PROGRESS: not published yet. Publishing the same container again cannot create a second Reel.
		_ => Ok(Reconciled::Resume),
	}
}

pub async fn run(ctx: &mut Ctx) -> Result<Outcome, PubError> {
	let app = ctx.app.clone();
	let src = source(&app);
	if matches!(src, Source::None) {
		return Err(PubError::attention("Set PUBLIC_BASE_URL to a public HTTPS address so Instagram can download the video."));
	}
	let token = ctx.token().await?;
	let ig_id = ctx.account.external_id.clone();
	let g = graph_for(&app, &ctx.account);

	if !js_truthy(&ctx.rf()["containerId"]) {
		ctx.need_file()?;
		let limit = json(&app, Req::get(&format!("{g}/{ig_id}/content_publishing_limit?fields=quota_usage,config")).bearer(&token)).await.unwrap_or(Value::Null);
		let used = limit["data"][0]["quota_usage"].as_f64();
		let total = limit["data"][0]["config"]["quota_total"].as_f64();
		if let (Some(u), Some(t)) = (used, total) {
			if u >= t {
				return Err(PubError::transient_after(format!("Instagram's publishing limit is reached ({u}/{t} in 24 h)"), 60 * 60_000));
			}
		}
		let video_url = match src {
			Source::Relay => crate::relay::host_media(ctx, &token).await?,
			_ => public_media_url(&app, &ctx.media.id),
		};
		ctx.save(Patch::new().state("uploading").phase("container").progress(0.05));
		let share = (ctx.settings["shareToFeed"] != Value::Bool(false)).to_string();
		let mut params: Vec<(&str, String)> = vec![("media_type", "REELS".into()), ("video_url", video_url), ("caption", ctx.caption.clone()), ("share_to_feed", share)];
		let thumb = &ctx.settings["thumbOffsetMs"];
		if !thumb.is_null() && thumb != "" {
			params.push(("thumb_offset", (js_num(thumb).round() as i64).to_string()));
		}
		// A cover image the owner chose replaces the cover frame. A missing one is skipped, never fatal.
		if let Some(cover_id) = crate::covers::chosen(&ctx.settings).map(String::from) {
			match crate::covers::get(&app, &cover_id) {
				Some(c) => {
					let url = match src {
						Source::Relay => {
							let f = crate::relay::Hosted { prefix: "hostedCover", path: &c.path, size: c.size.max(0) as u64, mime: &c.mime, what: "cover image" };
							crate::relay::host_file(ctx, &token, f).await?
						}
						_ => public_media_url(&app, &c.id),
					};
					params.push(("cover_url", url));
				}
				None => ctx.log("The chosen cover image is no longer on this computer, so Instagram picks the cover."),
			}
		}
		let pairs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
		let c = json(&app, Req::post(&format!("{g}/{ig_id}/media")).bearer(&token).form(&pairs)).await?;
		// Keep any hosted-video details next to the container, so the copy can be deleted later.
		let mut r = ctx.rf();
		r["containerId"] = c["id"].clone();
		ctx.save(Patch::new().phase("processing").state("processing").rf(r).progress(0.1));
		ctx.log("Instagram is downloading and processing the video.");
	}

	if ctx.target.phase.as_deref() != Some("publishing") {
		let mut i = 0u32;
		loop {
			let id = js_str(&ctx.rf()["containerId"]);
			let c = container(ctx, &id).await?;
			match c["status_code"].as_str().unwrap_or("") {
				// Instagram has its own copy now, so the hosted one can go.
				"FINISHED" => {
					crate::relay::release_media(ctx).await;
					break;
				}
				"PUBLISHED" => {
					crate::relay::release_media(ctx).await;
					return match_published(ctx).await;
				}
				"ERROR" => {
					crate::relay::release_media(ctx).await;
					return Err(PubError::rejected(format!("Instagram could not process the video: {}", c["status"].as_str().unwrap_or("unknown error"))));
				}
				"EXPIRED" => {
					crate::relay::release_media(ctx).await;
					ctx.save(Patch::new().clear_ref().clear_phase());
					return Err(PubError::transient("Instagram container expired before publishing"));
				}
				_ => {}
			}
			if i > 180 {
				return Err(PubError::transient("Instagram is still processing the video"));
			}
			ctx.save(Patch::new().progress((0.1 + i as f64 * 0.01).min(0.9)));
			ctx.sleep(5000).await;
			i += 1;
		}
	}

	// From here a lost response could mean the Reel is live, so mark the attempt uncertain first.
	let mut r = ctx.rf();
	r["publishAt"] = Value::from(now_ms());
	ctx.save(Patch::new().phase("publishing").uncertain(true).rf(r));
	let creation_id = js_str(&ctx.rf()["containerId"]);
	let published = json(&app, Req::post(&format!("{g}/{ig_id}/media_publish")).bearer(&token).form(&[("creation_id", &creation_id)])).await?;
	let media_id = js_str(&published["id"]);
	ctx.save(Patch::new().remote_id(media_id.clone()).uncertain(false));
	finish_with(ctx, &media_id, None).await
}

async fn container(ctx: &Ctx, id: &str) -> Result<Value, PubError> {
	let token = ctx.token().await?;
	json(&ctx.app, Req::get(&format!("{}/{id}?fields=status_code,status", graph_for(&ctx.app, &ctx.account))).bearer(&token)).await
}

async fn recent_media(ctx: &Ctx) -> Result<Vec<Value>, PubError> {
	let token = ctx.token().await?;
	let url = format!("{}/{}/media?fields=id,permalink,timestamp,caption,media_product_type&limit=25", graph_for(&ctx.app, &ctx.account), ctx.account.external_id);
	let r = json(&ctx.app, Req::get(&url).bearer(&token)).await?;
	Ok(r["data"].as_array().cloned().unwrap_or_default())
}

fn timestamp_ms(s: &str) -> Option<i64> {
	chrono::DateTime::parse_from_rfc3339(s).or_else(|_| chrono::DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%z")).ok().map(|d| d.timestamp_millis())
}

/// The container says PUBLISHED but the publish response was lost. Instagram returns no media ID on
/// the container, so look for exactly one recent Reel with this caption posted after the publish
/// call. Identical captions are common, so anything other than exactly one match needs the owner.
async fn match_published(ctx: &mut Ctx) -> Result<Outcome, PubError> {
	let since = ctx.rf()["publishAt"].as_i64().unwrap_or(ctx.post_created_at) - 60_000;
	let media = recent_media(ctx).await?;
	let matches: Vec<&Value> = media
		.iter()
		.filter(|m| {
			let recent = m["timestamp"].as_str().and_then(timestamp_ms).map(|t| t >= since).unwrap_or(false);
			let kind = &m["media_product_type"];
			recent && m["caption"].as_str().unwrap_or("") == ctx.caption && (!js_truthy(kind) || kind == "REELS")
		})
		.collect();
	if matches.len() == 1 {
		let id = js_str(&matches[0]["id"]);
		let link = matches[0]["permalink"].as_str().map(String::from);
		return finish_with(ctx, &id, link).await;
	}
	if matches.len() > 1 {
		return Ok(Outcome::NeedsAttention {
			message: format!(
				"Instagram confirmed this Reel was published, but {} recent posts have the same caption, so the app cannot tell which one it is. Open your Instagram profile to find it. Do not post it again.",
				matches.len()
			),
		});
	}
	// Published but not listed yet: the media list can lag. Check again later; repeated misses end in needs_attention.
	Err(PubError::transient("Instagram says the Reel was published but it is not in your recent posts yet"))
}

async fn finish_with(ctx: &Ctx, media_id: &str, permalink: Option<String>) -> Result<Outcome, PubError> {
	let mut link = permalink.filter(|s| !s.is_empty());
	if link.is_none() {
		let token = ctx.token().await?;
		let m = json(&ctx.app, Req::get(&format!("{}/{media_id}?fields=permalink", graph_for(&ctx.app, &ctx.account))).bearer(&token)).await.unwrap_or(Value::Null);
		link = m["permalink"].as_str().map(String::from);
	}
	Ok(Outcome::Published { permalink: link, remote_id: Some(media_id.to_string()), message: None })
}
