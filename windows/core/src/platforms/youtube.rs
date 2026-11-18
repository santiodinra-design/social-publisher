//! YouTube Data API v3, resumable uploads with videos.insert (port of `server/platforms/youtube.ts`).
//! Docs: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
use super::http::{classify, json, send, Req};
use super::{Availability, Ctx, Identity, Outcome, PubError, Reconciled, TokenSet};
use crate::jobs::Patch;
use crate::media::{is_shorts_shape, Issue};
use crate::settings::{get, redirect_uri};
use crate::util::{encode_component, form, js_len, js_str, js_truthy, now_ms};
use crate::App;
use serde_json::{json as j, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const CHUNK: u64 = 16 * 1024 * 1024; // multiple of 256 KB

pub fn availability() -> Availability {
	Availability { available: true, mode: "upload", note: "Uploads videos and Shorts (vertical or square, up to 3 minutes).".into() }
}

pub fn validate_settings(s: &Value) -> Vec<Issue> {
	let mut out = Vec::new();
	let title = js_str(&s["title"]).trim().to_string();
	if title.is_empty() {
		out.push(Issue::new("youtube.title", "YouTube needs a title."));
	}
	if js_len(&title) > 100 {
		out.push(Issue::new("youtube.title", "Titles can be up to 100 characters."));
	}
	if title.contains(['<', '>']) {
		out.push(Issue::new("youtube.title", "Titles cannot contain < or >."));
	}
	let d = js_str(&s["description"]);
	if d.len() > 5000 {
		out.push(Issue::new("youtube.description", "Descriptions can be up to 5,000 bytes."));
	}
	if d.contains(['<', '>']) {
		out.push(Issue::new("youtube.description", "Descriptions cannot contain < or >."));
	}
	if !matches!(s["privacy"].as_str(), Some("public" | "unlisted" | "private")) {
		out.push(Issue::new("youtube.privacy", "Choose public, unlisted or private."));
	}
	if !s["madeForKids"].is_boolean() {
		out.push(Issue::new("youtube.madeForKids", "Say whether this video is made for kids. YouTube requires it."));
	}
	out
}

pub fn authorize_url(app: &App, state: &str, challenge: &str) -> String {
	let q = form(&[
		("client_id", &get(app, "GOOGLE_CLIENT_ID")),
		("redirect_uri", &redirect_uri(app, crate::db::Platform::Youtube)),
		("response_type", "code"),
		("scope", "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly"),
		("access_type", "offline"),
		("prompt", "consent"),
		("include_granted_scopes", "true"),
		("state", state),
		("code_challenge", challenge),
		("code_challenge_method", "S256"),
	]);
	format!("https://accounts.google.com/o/oauth2/v2/auth?{q}")
}

fn expires_in(t: &Value) -> i64 {
	now_ms() + t["expires_in"].as_f64().unwrap_or(3600.0) as i64 * 1000
}

pub async fn exchange_code(app: &App, code: &str, verifier: &str) -> Result<TokenSet, PubError> {
	let t = json(
		app,
		Req::post(&app.endpoints.google_token).form(&[
			("code", code),
			("client_id", &get(app, "GOOGLE_CLIENT_ID")),
			("client_secret", &get(app, "GOOGLE_CLIENT_SECRET")),
			("redirect_uri", &redirect_uri(app, crate::db::Platform::Youtube)),
			("grant_type", "authorization_code"),
			("code_verifier", verifier),
		]),
	)
	.await?;
	Ok(TokenSet {
		access_token: js_str(&t["access_token"]),
		refresh_token: t["refresh_token"].as_str().map(String::from),
		access_expires_at: Some(expires_in(&t)),
		refresh_expires_at: None,
		scopes: t["scope"].as_str().map(String::from),
	})
}

pub async fn refresh(app: &App, refresh_token: Option<&str>) -> Result<TokenSet, PubError> {
	let Some(rt) = refresh_token.filter(|s| !s.is_empty()) else { return Err(PubError::permanent("No refresh token stored")) };
	let t = json(
		app,
		Req::post(&app.endpoints.google_token).form(&[("client_id", &get(app, "GOOGLE_CLIENT_ID")), ("client_secret", &get(app, "GOOGLE_CLIENT_SECRET")), ("refresh_token", rt), ("grant_type", "refresh_token")]),
	)
	.await?;
	Ok(TokenSet { access_token: js_str(&t["access_token"]), refresh_token: Some(rt.to_string()), access_expires_at: Some(expires_in(&t)), refresh_expires_at: None, scopes: t["scope"].as_str().map(String::from) })
}

pub async fn identity(app: &App, access_token: &str) -> Result<Identity, PubError> {
	let url = format!("{}/channels?part=snippet&mine=true", app.endpoints.youtube_api);
	let r = json(app, Req::get(&url).bearer(access_token)).await?;
	let ch = &r["items"][0];
	if !js_truthy(ch) {
		return Err(PubError::permanent("This Google account has no YouTube channel. Create one first."));
	}
	Ok(Identity {
		external_id: js_str(&ch["id"]),
		display_name: js_str(&ch["snippet"]["title"]),
		handle: ch["snippet"]["customUrl"].as_str().map(String::from),
		avatar_url: ch["snippet"]["thumbnails"]["default"]["url"].as_str().map(String::from),
		meta: None,
	})
}

pub async fn revoke(app: &App, access_token: Option<&str>, refresh_token: Option<&str>) {
	if let Some(t) = refresh_token.or(access_token) {
		let url = format!("{}?token={}", app.endpoints.google_revoke, encode_component(t));
		let _ = send(app, Req::post(&url)).await;
	}
}

pub async fn reconcile(ctx: &mut Ctx) -> Result<Reconciled, PubError> {
	// A video ID means YouTube has the video: keep checking it, never upload again.
	if ctx.target.remote_id.is_some() {
		return Ok(Reconciled::Resume);
	}
	// No upload session was ever stored, so no bytes were sent and YouTube cannot have created a video.
	if !js_truthy(&ctx.rf()["sessionUrl"]) {
		return Ok(Reconciled::Restart);
	}
	// Ask the upload session where it stands. Lookup errors (timeouts, outages, sign-in) are returned
	// so the runner keeps the session and checks again later.
	let (_, video_id) = upload_offset(ctx).await?;
	if let Some(id) = video_id {
		ctx.save(Patch::new().remote_id(id));
	}
	Ok(Reconciled::Resume)
}

pub async fn run(ctx: &mut Ctx) -> Result<Outcome, PubError> {
	let app = ctx.app.clone();
	let size = ctx.media.size.max(0) as u64;
	if ctx.target.remote_id.is_none() {
		if !js_truthy(&ctx.rf()["sessionUrl"]) {
			ctx.need_file()?;
			let token = ctx.token().await?;
			ctx.save(Patch::new().state("uploading").phase("init").progress(0.0));
			let s = &ctx.settings;
			let body = j!({
				"snippet": { "title": js_str(&s["title"]).trim(), "description": js_str(&s["description"]), "categoryId": if s["categoryId"].is_null() { "22".to_string() } else { js_str(&s["categoryId"]) } },
				"status": { "privacyStatus": s["privacy"], "selfDeclaredMadeForKids": js_truthy(&s["madeForKids"]), "embeddable": true },
			});
			let url = format!("{}/videos?uploadType=resumable&part=snippet,status", app.endpoints.youtube_upload);
			let mime = if ctx.media.mime.is_empty() { "video/*" } else { ctx.media.mime.as_str() };
			let res = send(&app, Req::post(&url).bearer(&token).header("X-Upload-Content-Length", size.to_string()).header("X-Upload-Content-Type", mime).json_body(&body)).await?;
			if !res.ok() {
				return Err(classify(res.status, &res.json().unwrap_or(Value::Null), "YouTube", None));
			}
			let Some(session_url) = res.header("location").filter(|s| !s.is_empty()) else { return Err(PubError::transient("YouTube did not return an upload session")) };
			ctx.save(Patch::new().phase("upload").rf(j!({ "sessionUrl": session_url })));
		}

		let (mut offset, mut video_id) = upload_offset(ctx).await?;
		let mut file = None;
		if video_id.is_none() && offset < size {
			ctx.need_file()?;
			file = Some(tokio::fs::File::open(&ctx.media.path).await.map_err(|e| PubError::unexpected(format!("Could not open the video file: {e}")))?);
		}
		while video_id.is_none() && offset < size {
			let end = (offset + CHUNK).min(size) - 1;
			let mut buf = vec![0u8; (end - offset + 1) as usize];
			let f = file.as_mut().expect("opened above");
			f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| PubError::unexpected(format!("Could not read the video file: {e}")))?;
			f.read_exact(&mut buf).await.map_err(|e| PubError::unexpected(format!("Could not read the video file: {e}")))?;
			let token = ctx.token().await?;
			// Record that the final part is about to go out: after this, an expired session no longer proves nothing was created.
			if end == size - 1 && !js_truthy(&ctx.rf()["finalSent"]) {
				let mut r = ctx.rf();
				r["finalSent"] = Value::Bool(true);
				ctx.save(Patch::new().rf(r));
			}
			let session_url = js_str(&ctx.rf()["sessionUrl"]);
			let res = send(&app, Req::put(&session_url).bearer(&token).header("Content-Range", format!("bytes {offset}-{end}/{size}")).body(buf).timeout(10 * 60_000)).await?;
			match res.status {
				308 => offset = range_end(res.header("range").as_deref()),
				200 | 201 => video_id = res.json().and_then(|v| v["id"].as_str().map(String::from)),
				404 => return Err(session_gone(ctx)),
				s => return Err(classify(s, &res.json().unwrap_or(Value::Null), "YouTube upload", None)),
			}
			ctx.save(Patch::new().state("uploading").progress((offset as f64 / size as f64).min(1.0)));
			if matches!(res.status, 200 | 201) {
				break;
			}
		}
		let Some(video_id) = video_id else { return Err(PubError::transient("Upload finished without a video ID; checking again")) };
		ctx.save(Patch::new().remote_id(video_id).state("processing").phase("processing").progress(1.0));
	}

	set_thumbnail(ctx).await;

	// Wait for YouTube to accept the upload before calling it published.
	let id = ctx.target.remote_id.clone().unwrap_or_default();
	for i in 0..180 {
		let token = ctx.token().await?;
		let url = format!("{}/videos?part=status,processingDetails&id={}", app.endpoints.youtube_api, encode_component(&id));
		let r = json(&app, Req::get(&url).bearer(&token)).await?;
		let v = &r["items"][0];
		let up = v["status"]["uploadStatus"].as_str().unwrap_or("");
		if up == "rejected" || up == "failed" {
			let reason = [&v["status"]["rejectionReason"], &v["status"]["failureReason"]].into_iter().find(|x| !x.is_null()).map(js_str).unwrap_or_else(|| "no reason given".into());
			return Err(PubError::rejected(format!("YouTube {up} the video: {reason}")));
		}
		if up == "processed" || (up == "uploaded" && v["processingDetails"]["processingStatus"] == "succeeded") {
			let short = is_shorts_shape(ctx.media.width, ctx.media.height, ctx.media.duration);
			let permalink = if short { format!("https://www.youtube.com/shorts/{id}") } else { format!("https://www.youtube.com/watch?v={id}") };
			return Ok(Outcome::Published { permalink: Some(permalink), remote_id: Some(id), message: None });
		}
		if up == "uploaded" && i > 6 {
			// Uploaded and accepted; processing can take a long time, so report it with a link.
			return Ok(Outcome::Published { permalink: Some(format!("https://www.youtube.com/watch?v={id}")), remote_id: Some(id), message: Some("Uploaded. YouTube is still processing higher resolutions.".into()) });
		}
		ctx.sleep(10_000).await;
	}
	Err(PubError::transient("YouTube is still processing the video"))
}

/** Asks the upload session how many bytes it holds, or which video it became. */
async fn upload_offset(ctx: &mut Ctx) -> Result<(u64, Option<String>), PubError> {
	let token = ctx.token().await?;
	let size = ctx.media.size.max(0) as u64;
	let session_url = js_str(&ctx.rf()["sessionUrl"]);
	let res = send(&ctx.app, Req::put(&session_url).bearer(&token).header("Content-Range", format!("bytes */{size}"))).await?;
	match res.status {
		308 => Ok((range_end(res.header("range").as_deref()), None)),
		200 | 201 => Ok((size, res.json().and_then(|v| v["id"].as_str().map(String::from)))),
		404 => Err(session_gone(ctx)),
		s => Err(classify(s, &res.json().unwrap_or(Value::Null), "YouTube upload", None)),
	}
}

/** The resumable session no longer exists. Restarting is only safe if the final part was never sent. */
fn session_gone(ctx: &mut Ctx) -> PubError {
	if !js_truthy(&ctx.rf()["finalSent"]) {
		ctx.save(Patch::new().clear_ref().clear_phase().progress(0.0));
		return PubError::transient("YouTube upload session expired before the upload finished; starting a new one");
	}
	PubError::attention(format!(
		"YouTube's upload session expired after the last part was sent, so it is not known whether the video was created. Check YouTube Studio → Content for \"{}\" before posting it again.",
		js_str(&ctx.settings["title"]).trim()
	))
}

fn range_end(range: Option<&str>) -> u64 {
	range.and_then(|r| r.split('-').nth(1)).and_then(|e| e.trim().parse::<u64>().ok()).map(|e| e + 1).unwrap_or(0)
}

/** Records that the thumbnail step is over, with a note for the owner. */
fn done(ctx: &mut Ctx, note: &str) {
	ctx.log(note);
	let mut r = ctx.rf();
	r["thumbDone"] = Value::Bool(true);
	ctx.save(Patch::new().rf(r));
}

/// Sets the custom thumbnail the owner chose, once the video exists. Best effort: YouTube only
/// allows custom thumbnails on channels it has verified, and a refused thumbnail must never fail a
/// video that uploaded fine, so problems are recorded as events and the default thumbnail stays.
async fn set_thumbnail(ctx: &mut Ctx) {
	let Some(cover_id) = crate::covers::chosen(&ctx.settings).map(String::from) else { return };
	let (Some(video_id), false) = (ctx.target.remote_id.clone(), js_truthy(&ctx.rf()["thumbDone"])) else { return };
	let Some(cover) = crate::covers::get(&ctx.app, &cover_id) else { return done(ctx, "The chosen thumbnail is no longer on this computer, so YouTube keeps its own.") };
	let Ok(bytes) = tokio::fs::read(&cover.path).await else { return done(ctx, "Could not read the chosen thumbnail, so YouTube keeps its own.") };
	let token = match ctx.token().await {
		Ok(t) => t,
		Err(_) => return,
	};
	let app = ctx.app.clone();
	let url = format!("{}/thumbnails/set?videoId={}&uploadType=media", app.endpoints.youtube_upload, encode_component(&video_id));
	match json(&app, Req::post(&url).bearer(&token).header("Content-Type", cover.mime.clone()).body(bytes).timeout(120_000)).await {
		Ok(_) => done(ctx, "Custom thumbnail set."),
		// A network problem is worth another try on the next attempt; anything else is final.
		Err(PubError::Transient { msg, .. }) => ctx.log(&format!("Thumbnail not set yet: {msg}")),
		Err(e) => done(ctx, &format!("YouTube did not accept the thumbnail ({}). Custom thumbnails need a verified channel: youtube.com/verify.", e.message())),
	}
}
