//! One-click sign-in through the hosted relay: connect, refresh, revoke, and Instagram video hosting.
//! The relay and the platforms are both played by the local mock server.
mod common;
use base64::Engine;
use common::*;
use publisher_core::accounts::{self, get_account, upsert_account};
use publisher_core::db::Platform;
use publisher_core::platforms::{Identity, TokenSet};
use publisher_core::util::now_ms;
use publisher_core::{relay, server, settings, App};
use reqwest::Method;
use serde_json::{json, Value};
use sha2::Digest;
use std::sync::Arc;

async fn serve(app: &Arc<App>) -> String {
	let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
	let base = format!("http://{}", listener.local_addr().unwrap());
	let serving = app.clone();
	tokio::spawn(async move { server::serve(listener, serving).await.unwrap() });
	base
}

fn window(app: &App, method: Method, url: String) -> reqwest::RequestBuilder {
	reqwest::Client::new().request(method, url).header("Cookie", format!("sp_desktop={}", app.cfg.desktop_token)).header("X-Requested-With", "social-publisher")
}

fn query(url: &str) -> Value {
	let u = reqwest::Url::parse(url).unwrap();
	Value::Object(u.query_pairs().map(|(k, v)| (k.into_owned(), Value::from(v.into_owned()))).collect())
}

#[tokio::test]
async fn youtube_connects_and_refreshes_through_the_relay_when_no_keys_are_saved() {
	let mock = Mock::start(|c, _| match c.path.as_str() {
		"/relay/token/youtube" => json(200, json!({ "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "scope": "youtube.upload" })),
		"/relay/refresh/youtube" => json(200, json!({ "access_token": "at-2", "expires_in": 3599 })),
		"/youtube/channels" => json(200, json!({ "items": [{ "id": "UC1", "snippet": { "title": "My Channel", "customUrl": "@mine", "thumbnails": { "default": { "url": "https://yt.example/a.jpg" } } } }] })),
		_ => json(404, json!({})),
	})
	.await;
	let app = App::for_tests(mock.endpoints_with_relay());
	let base = serve(&app).await;

	// Customers see a plain Connect: the platform counts as ready, and as hosted.
	let cfg: Value = window(&app, Method::GET, format!("{base}/api/config")).send().await.unwrap().json().await.unwrap();
	assert_eq!((cfg["platforms"]["youtube"]["configured"].clone(), cfg["platforms"]["youtube"]["hosted"].clone()), (json!(true), json!(true)));

	// Connect opens the relay with this app's port, a one-use state and a PKCE challenge.
	let begun: Value = window(&app, Method::POST, format!("{base}/api/oauth/youtube/begin")).send().await.unwrap().json().await.unwrap();
	let url = begun["url"].as_str().unwrap();
	assert!(url.starts_with(&format!("{}/relay/start/youtube?port=8787&state=", mock.base)), "{url}");
	let q = query(url);
	let (state, challenge) = (q["state"].as_str().unwrap().to_string(), q["challenge"].as_str().unwrap().to_string());

	// The relay sends the browser back to the app, which swaps the code at the relay, never at Google.
	let page = reqwest::get(format!("{base}/api/oauth/youtube/callback?code=code-1&state={state}")).await.unwrap().text().await.unwrap();
	assert!(page.contains("Connected My Channel"), "{page}");
	let token_call = mock.calls().into_iter().find(|c| c.path == "/relay/token/youtube").unwrap();
	let body: Value = serde_json::from_str(&token_call.body).unwrap();
	assert_eq!(body["code"], "code-1");
	let verifier = body["verifier"].as_str().unwrap();
	assert_eq!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes())), challenge);
	assert_eq!(mock.count(|c| c.path.starts_with("/google")), 0);

	// The account remembers it came through the relay, so its refresh goes there too.
	let id: String = app.db().query_row("SELECT id FROM accounts WHERE platform = 'youtube'", [], |r| r.get(0)).unwrap();
	let a = get_account(&app, &id).unwrap();
	assert!(relay::via_relay(&a));
	app.db().execute("UPDATE accounts SET access_expires_at = ? WHERE id = ?", rusqlite::params![now_ms(), id]).unwrap();
	assert_eq!(accounts::access_token(&app, &id).await.unwrap(), "at-2");
	let refresh_call = mock.calls().into_iter().find(|c| c.path == "/relay/refresh/youtube").unwrap();
	assert_eq!(serde_json::from_str::<Value>(&refresh_call.body).unwrap(), json!({ "refreshToken": "rt-1" }));
	// The refresh token Google did not resend is kept.
	app.db().execute("UPDATE accounts SET access_expires_at = ? WHERE id = ?", rusqlite::params![now_ms(), id]).unwrap();
	accounts::access_token(&app, &id).await.unwrap();
	let again = mock.calls().into_iter().filter(|c| c.path == "/relay/refresh/youtube").nth(1).unwrap();
	assert!(again.body.contains("rt-1"));

	// The browser bridge may open the relay's sign-in page.
	let opened: Value = window(&app, Method::POST, format!("{base}/api/desktop/open-external")).json(&json!({ "url": "https://example.com/x" })).send().await.unwrap().json().await.unwrap();
	assert_eq!(opened["ok"], false);
}

#[tokio::test]
async fn developer_keys_saved_in_the_app_take_priority_over_the_relay() {
	let mock = Mock::start(|_, _| json(404, json!({}))).await;
	let app = App::for_tests(mock.endpoints_with_relay());
	settings::save(&app, &[("GOOGLE_CLIENT_ID", Some("1-abc.apps.googleusercontent.com")), ("GOOGLE_CLIENT_SECRET", Some("s"))]).unwrap();
	assert!(!relay::hosted(&app, Platform::Youtube));
	assert!(relay::hosted(&app, Platform::Tiktok));
	let base = serve(&app).await;
	let begun: Value = window(&app, Method::POST, format!("{base}/api/oauth/youtube/begin")).send().await.unwrap().json().await.unwrap();
	assert!(begun["url"].as_str().unwrap().starts_with("https://accounts.google.com/"));

	// Without a relay and without keys, Connect is refused as before.
	let plain = App::for_tests(mock.endpoints());
	let base = serve(&plain).await;
	let res = window(&plain, Method::POST, format!("{base}/api/oauth/tiktok/begin")).send().await.unwrap();
	assert_eq!(res.status(), 409);
	// A relay built for some platforms only leaves the others to developer keys.
	let mut partial = mock.endpoints_with_relay();
	partial.relay_platforms = vec![Platform::Youtube];
	let some = App::for_tests(partial);
	assert!(relay::hosted(&some, Platform::Youtube) && !relay::hosted(&some, Platform::Instagram));
}

#[tokio::test]
async fn an_expired_relay_sign_in_asks_for_reconnect_and_disconnect_revokes_through_the_relay() {
	let mock = Mock::start(|c, _| match c.path.as_str() {
		"/relay/refresh/tiktok" => json(400, json!({ "error": "invalid_grant", "error_description": "Refresh token is invalid or expired." })),
		"/relay/revoke/tiktok" => json(200, json!({})),
		_ => json(404, json!({})),
	})
	.await;
	let app = App::for_tests(mock.endpoints_with_relay());
	let who = Identity { external_id: "open-1".into(), display_name: "Me".into(), meta: Some(relay::mark(None)), ..Default::default() };
	let a = upsert_account(&app, Platform::Tiktok, &who, &TokenSet { access_token: "tt-at".into(), refresh_token: Some("tt-rt".into()), access_expires_at: Some(now_ms()), ..Default::default() }, false).unwrap();

	let err = accounts::access_token(&app, &a.id).await.unwrap_err();
	assert!(err.is_auth());
	assert_eq!(get_account(&app, &a.id).unwrap().status, "reconnect_required");
	assert_eq!(mock.count(|c| c.path.starts_with("/tiktok")), 0);

	accounts::disconnect(&app, &a.id).await.unwrap();
	let revoke = mock.calls().into_iter().find(|c| c.path == "/relay/revoke/tiktok").unwrap();
	assert_eq!(serde_json::from_str::<Value>(&revoke.body).unwrap(), json!({ "token": "tt-at" }));
	assert_eq!(get_account(&app, &a.id).unwrap().status, "disconnected");
}

#[tokio::test]
async fn instagram_publishes_from_the_relay_and_the_hosted_copy_is_deleted() {
	const ID: &str = "0123456789abcdef0123456789abcdef";
	let mock = Mock::start(|c, earlier| {
		let p = c.path.as_str();
		match (c.method.as_str(), p) {
			(_, "/ig/v25.0/instagram-1/content_publishing_limit") => json(200, json!({ "data": [{ "quota_usage": 1, "config": { "quota_total": 50 } }] })),
			("POST", "/relay/media") => json(200, json!({ "id": ID, "uploadId": "up-1", "key": "media-key", "partSize": 1024 * 1024 })),
			("PUT", _) if p.starts_with(&format!("/relay/media/{ID}/parts/")) => {
				let n: u64 = p.rsplit('/').next().unwrap().parse().unwrap();
				json(200, json!({ "partNumber": n, "etag": format!("e{n}") }))
			}
			("POST", _) if p == format!("/relay/media/{ID}/complete") => json(200, json!({ "url": format!("https://relay.example.test/m/{ID}?exp=1&sig=s"), "expiresAt": now_ms() + 6 * 3600 * 1000 })),
			("DELETE", _) if p == format!("/relay/media/{ID}") => json(200, json!({ "ok": true })),
			("POST", "/ig/v25.0/instagram-1/media") => json(200, json!({ "id": "C1" })),
			(_, "/ig/v25.0/C1") => {
				// Instagram is still downloading the first time it is asked.
				let asked = earlier.iter().filter(|e| e.path == "/ig/v25.0/C1").count();
				json(200, json!({ "status_code": if asked == 0 { "IN_PROGRESS" } else { "FINISHED" } }))
			}
			("POST", "/ig/v25.0/instagram-1/media_publish") => json(200, json!({ "id": "M1" })),
			(_, "/ig/v25.0/M1") => json(200, json!({ "permalink": "https://www.instagram.com/reel/abc/" })),
			_ => json(404, json!({})),
		}
	})
	.await;
	// No tunnel of the owner's own: the relay hosts the video.
	let app = App::for_tests_with(mock.endpoints_with_relay(), |c| c.public_base_url = None);
	let (_, target_id, _) = new_target(&app, Platform::Instagram, false, "first reel", json!({}));

	let t = run_again(&app, &target_id).await;
	assert_eq!(t.state, "published", "{:?}", t.error);
	assert_eq!(t.permalink.as_deref(), Some("https://www.instagram.com/reel/abc/"));

	let calls = mock.calls();
	// 3 MB in 1 MB parts, each with the upload key.
	assert_eq!(calls.iter().filter(|c| c.method == "PUT" && c.path.contains("/parts/")).count(), 3);
	let complete: Value = serde_json::from_str(&calls.iter().find(|c| c.path.ends_with("/complete")).unwrap().body).unwrap();
	assert_eq!(complete["parts"], json!([{ "partNumber": 1, "etag": "e1" }, { "partNumber": 2, "etag": "e2" }, { "partNumber": 3, "etag": "e3" }]));
	// Instagram was given the relay's signed link.
	let container = calls.iter().find(|c| c.path == "/ig/v25.0/instagram-1/media").unwrap();
	assert!(container.body.contains("video_url=https%3A%2F%2Frelay.example.test%2Fm%2F"), "{}", container.body);
	// The copy is deleted once Instagram has it, before the Reel goes live.
	let at = |f: &dyn Fn(&Call) -> bool| calls.iter().position(f).unwrap();
	assert!(at(&|c| c.method == "DELETE") < at(&|c| c.path.ends_with("/media_publish")));
	let r = rf(&app, &target_id);
	assert!(r.get("hostedKey").is_none() && r.get("hostedUrl").is_none(), "{r}");
	assert_eq!(r["containerId"], "C1");
}
