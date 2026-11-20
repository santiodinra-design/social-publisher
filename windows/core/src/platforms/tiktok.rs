//! TikTok Content Posting API (port of `server/platforms/tiktok.ts`).
//! Docs: https://developers.tiktok.com/docs/en/content-posting-api-get-started
//!
//! Direct Post from an unaudited app only works for private accounts with SELF_ONLY visibility, and
//! TikTok's guidelines exclude personal tools from the audit. So the default is the supported
//! alternative: upload to the creator's TikTok inbox as a draft, which they finish in the TikTok app.
use super::http::{classify, json, send, Req};
use super::{Availability, Ctx, Identity, Outcome, PubError, Reconciled, TokenSet};
use crate::db::Platform;
use crate::jobs::Patch;
use crate::media::Issue;
use crate::settings::{get, redirect_uri};
use crate::util::{form, js_len, js_str, js_truthy, now_ms};
use crate::App;
use serde_json::{json as j, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const MB: u64 = 1024 * 1024;

/// Chunks must be 5–64 MB; the final chunk may be up to 128 MB. Files under 5 MB go in one chunk.
pub fn chunk_plan(size: u64) -> (u64, u64) {
	if size < 5 * MB {
		return (size, 1);
	}
	let chunk = 10 * MB;
	(chunk, (size / chunk).max(1))
}

pub fn availability(app: &App) -> Availability {
	if app.cfg.tiktok_direct_post {
		Availability { available: true, mode: "direct", note: "Direct Post is enabled. TikTok blocks public posts from unaudited apps; only private (Only me) posts to a private account will go through.".into() }
	} else {
		Availability { available: true, mode: "inbox", note: "Direct posting is unavailable for personal tools. Videos go to your TikTok inbox as drafts, and you finish posting in the TikTok app.".into() }
	}
}

pub fn validate_settings(app: &App, s: &Value, caption: &str) -> Vec<Issue> {
	let mut out = Vec::new();
	if js_len(caption) > 2200 {
		out.push(Issue::new("caption.tiktok", "TikTok captions are limited to 2,200 characters."));
	}
	if s["mode"] == "direct" {
		if !app.cfg.tiktok_direct_post {
			out.push(Issue::new("tiktok.mode", "Direct Post is not available for this app."));
		}
		if !js_truthy(&s["privacy"]) {
			out.push(Issue::new("tiktok.privacy", "Choose who can view the post."));
		}
	}
	out
}

pub fn authorize_url(app: &App, state: &str) -> String {
	// user.info.stats and video.list feed the Stats page.
	let mut scopes = vec!["user.info.basic", "user.info.stats", "video.list", "video.upload"];
	if app.cfg.tiktok_direct_post {
		scopes.push("video.publish");
	}
	let q = form(&[("client_key", &get(app, "TIKTOK_CLIENT_KEY")), ("scope", &scopes.join(",")), ("response_type", "code"), ("redirect_uri", &redirect_uri(app, Platform::Tiktok)), ("state", state),
		// Ask which TikTok account to use instead of silently reusing the signed-in one.
		("disable_auto_auth", "1")]);
	format!("https://www.tiktok.com/v2/auth/authorize/?{q}")
}

fn token_set(t: &Value) -> TokenSet {
	let n = now_ms();
	let at = |v: &Value| v.as_f64().filter(|s| *s != 0.0).map(|s| n + (s * 1000.0) as i64);
	TokenSet {
		access_token: js_str(&t["access_token"]),
		refresh_token: t["refresh_token"].as_str().map(String::from),
		access_expires_at: at(&t["expires_in"]),
		refresh_expires_at: at(&t["refresh_expires_in"]),
		scopes: t["scope"].as_str().map(String::from),
	}
}

pub async fn exchange_code(app: &App, code: &str) -> Result<TokenSet, PubError> {
	let url = format!("{}/v2/oauth/token/", app.endpoints.tiktok_api);
	let t = json(
		app,
		Req::post(&url).form(&[
			("client_key", &get(app, "TIKTOK_CLIENT_KEY")),
			("client_secret", &get(app, "TIKTOK_CLIENT_SECRET")),
			("code", code),
			("grant_type", "authorization_code"),
			("redirect_uri", &redirect_uri(app, Platform::Tiktok)),
		]),
	)
	.await?;
	Ok(token_set(&t))
}

pub async fn refresh(app: &App, refresh_token: Option<&str>) -> Result<TokenSet, PubError> {
	let Some(rt) = refresh_token.filter(|s| !s.is_empty()) else { return Err(PubError::permanent("No refresh token stored")) };
	let url = format!("{}/v2/oauth/token/", app.endpoints.tiktok_api);
	let t = json(app, Req::post(&url).form(&[("client_key", &get(app, "TIKTOK_CLIENT_KEY")), ("client_secret", &get(app, "TIKTOK_CLIENT_SECRET")), ("grant_type", "refresh_token"), ("refresh_token", rt)])).await?;
	Ok(token_set(&t))
}

pub async fn identity(app: &App, access_token: &str, tokens: &TokenSet) -> Result<Identity, PubError> {
	let url = format!("{}/v2/user/info/?fields=open_id,avatar_url,display_name", app.endpoints.tiktok_api);
	let r = json(app, Req::get(&url).bearer(access_token)).await?;
	let u = &r["data"]["user"];
	let name = js_str(&u["display_name"]);
	Ok(Identity {
		external_id: u["open_id"].as_str().map(String::from).unwrap_or_else(|| tokens.scopes.clone().unwrap_or_else(|| "tiktok".into())),
		display_name: if name.is_empty() { "TikTok account".into() } else { name },
		handle: None,
		avatar_url: u["avatar_url"].as_str().map(String::from),
		meta: None,
		tokens: None,
	})
}

pub async fn revoke(app: &App, access_token: Option<&str>) {
	let Some(token) = access_token else { return };
	let url = format!("{}/v2/oauth/revoke/", app.endpoints.tiktok_api);
	let _ = send(app, Req::post(&url).form(&[("client_key", &get(app, "TIKTOK_CLIENT_KEY")), ("client_secret", &get(app, "TIKTOK_CLIENT_SECRET")), ("token", token)])).await;
}

pub async fn reconcile(ctx: &mut Ctx) -> Result<Reconciled, PubError> {
	// No publish ID stored means TikTok never gave us an upload address, so no video bytes were sent.
	let publish_id = js_str(&ctx.rf()["publishId"]);
	if publish_id.is_empty() {
		return Ok(Reconciled::Restart);
	}
	// Lookup errors are returned so the publish ID is kept and checked again later.
	let st = status(ctx, &publish_id).await?;
	if let Some(done) = outcome_for(ctx, &st)? {
		return Ok(Reconciled::Done(done));
	}
	let uploaded = js_truthy(&ctx.rf()["uploaded"]);
	if st["status"] == "PROCESSING_UPLOAD" && !uploaded {
		// TikTok is still waiting for parts. If the last part was never sent, this upload cannot complete,
		// so starting a new one cannot produce a second video.
		if !js_truthy(&ctx.rf()["finalSent"]) {
			ctx.save(Patch::new().clear_ref().clear_phase().progress(0.0));
			return Ok(Reconciled::Restart);
		}
		return Err(PubError::transient("TikTok received the last part but has not confirmed the upload yet"));
	}
	// TikTok has moved past the upload stage: keep checking the same publish ID.
	if !uploaded {
		let mut r = ctx.rf();
		r["uploaded"] = Value::Bool(true);
		ctx.save(Patch::new().state("processing").phase("poll").progress(1.0).rf(r));
	}
	Ok(Reconciled::Resume)
}

pub async fn run(ctx: &mut Ctx) -> Result<Outcome, PubError> {
	let app = ctx.app.clone();
	let api = app.endpoints.tiktok_api.clone();
	let direct = ctx.settings["mode"] == "direct";
	if direct && !app.cfg.tiktok_direct_post {
		return Err(PubError::permanent("Direct Post is not available for this app."));
	}
	let token = ctx.token().await?;
	let size = ctx.media.size.max(0) as u64;

	if !js_truthy(&ctx.rf()["publishId"]) || !js_truthy(&ctx.rf()["uploaded"]) {
		ctx.need_file()?;
		let (chunk_size, count) = chunk_plan(size);
		let mut body = j!({ "source_info": { "source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk_size, "total_chunk_count": count } });
		if direct {
			let info = json(&app, Req::post(&format!("{api}/v2/post/publish/creator_info/query/")).bearer(&token).header("Content-Type", "application/json; charset=UTF-8")).await?;
			let info = &info["data"];
			let privacy = ctx.settings["privacy"].clone();
			if !info["privacy_level_options"].as_array().map(|o| o.contains(&privacy)).unwrap_or(false) {
				return Err(PubError::attention(format!("TikTok does not allow the \"{}\" privacy setting for this account right now.", js_str(&privacy))));
			}
			if let (Some(d), Some(max)) = (ctx.media.duration.filter(|d| *d != 0.0), info["max_video_post_duration_sec"].as_f64().filter(|m| *m != 0.0)) {
				if d > max {
					return Err(PubError::permanent(format!("This TikTok account can post videos up to {max} s.")));
				}
			}
			let s = &ctx.settings;
			body["post_info"] = j!({
				"title": ctx.caption,
				"privacy_level": privacy,
				"disable_comment": !js_truthy(&s["allowComments"]),
				"disable_duet": !js_truthy(&s["allowDuet"]),
				"disable_stitch": !js_truthy(&s["allowStitch"]),
			});
		}
		ctx.save(Patch::new().state("uploading").phase("init").progress(0.0));
		let init_url = format!("{api}/v2/post/publish/{}/init/", if direct { "video" } else { "inbox/video" });
		let init = json(&app, Req::post(&init_url).bearer(&token).json_body(&body)).await?;
		let publish_id = js_str(&init["data"]["publish_id"]);
		let upload_url = js_str(&init["data"]["upload_url"]);
		if publish_id.is_empty() || upload_url.is_empty() {
			return Err(PubError::transient("TikTok did not return an upload address"));
		}
		ctx.save(Patch::new().phase("upload").rf(j!({ "publishId": publish_id, "uploaded": false })));
		ctx.log(&format!("TikTok upload started ({count} part{}).", if count > 1 { "s" } else { "" }));

		let read_err = |e: std::io::Error| PubError::unexpected(format!("Could not read the video file: {e}"));
		let mut file = tokio::fs::File::open(&ctx.media.path).await.map_err(read_err)?;
		let mime = if ctx.media.mime.is_empty() { "video/mp4".to_string() } else { ctx.media.mime.clone() };
		for i in 0..count {
			let start = i * chunk_size;
			let end = if i == count - 1 { size.saturating_sub(1) } else { start + chunk_size - 1 };
			let mut buf = vec![0u8; (end + 1 - start) as usize];
			file.seek(std::io::SeekFrom::Start(start)).await.map_err(read_err)?;
			file.read_exact(&mut buf).await.map_err(read_err)?;
			if i == count - 1 {
				ctx.save(Patch::new().rf(j!({ "publishId": publish_id, "uploaded": false, "finalSent": true })));
			}
			let res = send(&app, Req::put(&upload_url).header("Content-Type", mime.clone()).header("Content-Range", format!("bytes {start}-{end}/{size}")).body(buf).timeout(10 * 60_000)).await?;
			if !matches!(res.status, 200 | 201 | 206) {
				return Err(classify(res.status, &res.json().unwrap_or(Value::Null), "TikTok upload", None));
			}
			ctx.save(Patch::new().progress((end + 1) as f64 / size.max(1) as f64));
		}
		ctx.save(Patch::new().state("processing").phase("poll").progress(1.0).rf(j!({ "publishId": publish_id, "uploaded": true })));
	}

	// Poll until TikTok confirms the outcome (about 20 minutes at most).
	for _ in 0..240 {
		let publish_id = js_str(&ctx.rf()["publishId"]);
		let st = status(ctx, &publish_id).await?;
		if let Some(done) = outcome_for(ctx, &st)? {
			return Ok(done);
		}
		ctx.sleep(5000).await;
	}
	Err(PubError::transient("TikTok is still processing the video"))
}

async fn status(ctx: &Ctx, publish_id: &str) -> Result<Value, PubError> {
	let token = ctx.token().await?;
	let url = format!("{}/v2/post/publish/status/fetch/", ctx.app.endpoints.tiktok_api);
	let r = json(&ctx.app, Req::post(&url).bearer(&token).json_body(&j!({ "publish_id": publish_id }))).await?;
	Ok(r["data"].clone())
}

fn outcome_for(ctx: &Ctx, st: &Value) -> Result<Option<Outcome>, PubError> {
	match st["status"].as_str().unwrap_or("") {
		"SEND_TO_USER_INBOX" => Ok(Some(Outcome::NeedsAttention { message: "Sent to your TikTok inbox. Open TikTok, tap the inbox notification and finish posting there.".into() })),
		"PUBLISH_COMPLETE" => {
			// "publicaly" is TikTok's own spelling of this field.
			let id = Some(&st["publicaly_available_post_id"][0]).filter(|v| js_truthy(v)).map(js_str);
			let handle = ctx.account.handle.as_deref().map(|h| h.trim_start_matches('@').to_string()).filter(|h| !h.is_empty());
			let permalink = match (&id, &handle) {
				(Some(id), Some(h)) => Some(format!("https://www.tiktok.com/@{h}/video/{id}")),
				_ => None,
			};
			let message = id.is_none().then(|| "Posted privately; TikTok does not give a public link for private posts.".to_string());
			Ok(Some(Outcome::Published { permalink, remote_id: id, message }))
		}
		"FAILED" => Err(PubError::rejected(format!("TikTok rejected the video: {}", st["fail_reason"].as_str().unwrap_or("unknown reason")))),
		_ => Ok(None),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn chunk_plan_follows_tiktoks_rules() {
		assert_eq!(chunk_plan(3 * MB), (3 * MB, 1));
		assert_eq!(chunk_plan(10 * MB), (10 * MB, 1));
		// The remainder joins the last chunk, which may be up to 128 MB.
		assert_eq!(chunk_plan(25 * MB), (10 * MB, 2));
		assert_eq!(chunk_plan(7 * MB), (10 * MB, 1));
	}
}
