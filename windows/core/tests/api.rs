//! The local API as the page uses it: lock-down, the window's entry link, upload, publish, history.
mod common;
use publisher_core::probe::fixtures;
use publisher_core::{runner, server, App, Endpoints};
use reqwest::{Client, Method, Response, StatusCode};
use serde_json::{json, Value};
use std::sync::Arc;

struct Api {
	app: Arc<App>,
	base: String,
	http: Client,
}

impl Api {
	async fn start() -> Api {
		let app = App::for_tests(Endpoints::default());
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}", listener.local_addr().unwrap());
		let serving = app.clone();
		tokio::spawn(async move { server::serve(listener, serving).await.unwrap() });
		Api { app, base, http: Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap() }
	}

	/// A request as the app window sends it: with the launch cookie and the CSRF header.
	fn req(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
		self.http.request(method, format!("{}{path}", self.base)).header("Cookie", format!("sp_desktop={}", self.app.cfg.desktop_token)).header("X-Requested-With", "social-publisher")
	}
	async fn get(&self, path: &str) -> Value {
		self.req(Method::GET, path).send().await.unwrap().json().await.unwrap()
	}
	async fn send(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
		let res: Response = self.req(method, path).json(&body).send().await.unwrap();
		let status = res.status();
		(status, res.json().await.unwrap_or(Value::Null))
	}
	async fn upload(&self, name: &str, mime: &str, bytes: Vec<u8>) -> (StatusCode, Value) {
		let res = self.req(Method::PUT, "/api/media").header("Content-Type", mime).header("X-Filename", name).body(bytes).send().await.unwrap();
		let status = res.status();
		(status, res.json().await.unwrap_or(Value::Null))
	}
}

#[tokio::test]
async fn the_api_is_locked_to_the_app_window() {
	let api = Api::start().await;
	let bare = |m: Method, p: &str| api.http.request(m, format!("{}{p}", api.base));

	// No cookie: every API call is refused, even from this computer.
	assert_eq!(bare(Method::GET, "/api/accounts").send().await.unwrap().status(), 401);
	assert_eq!(bare(Method::GET, "/api/posts").header("Cookie", "sp_desktop=wrong").send().await.unwrap().status(), 401);
	// The cookie alone is not enough to change anything: the app's own header is required too.
	let no_header = bare(Method::POST, "/api/demo/accounts").header("Cookie", format!("sp_desktop={}", api.app.cfg.desktop_token)).send().await.unwrap();
	assert_eq!(no_header.status(), 403);
	// Password sign-in does not exist in the desktop app.
	assert_eq!(bare(Method::POST, "/api/session").json(&json!({ "password": "x" })).send().await.unwrap().status(), 403);
	let s: Value = bare(Method::GET, "/api/session").send().await.unwrap().json().await.unwrap();
	assert_eq!(s, json!({ "signedIn": false, "demoMode": true, "noSignIn": false, "desktop": true, "phone": false, "phonePairing": false }));
	assert_eq!(api.get("/api/session").await["signedIn"], true);
	// Unknown API paths are JSON 404s, not the page.
	assert_eq!(api.req(Method::GET, "/api/nope").send().await.unwrap().status(), 404);
}

#[tokio::test]
async fn the_window_entry_link_works_exactly_once() {
	let api = Api::start().await;
	*api.app.enter_nonce.lock() = Some("one-time-key".into());
	let wrong = api.http.get(format!("{}/api/desktop/enter?k=guess", api.base)).send().await.unwrap();
	assert_eq!(wrong.status(), 403);
	// A wrong guess does not use the key up, so another program cannot lock the window out.
	let good = api.http.get(format!("{}/api/desktop/enter?k=one-time-key", api.base)).send().await.unwrap();
	assert_eq!(good.status(), 200);
	let cookie = good.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
	assert!(cookie.starts_with(&format!("sp_desktop={}", api.app.cfg.desktop_token)));
	assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
	let again = api.http.get(format!("{}/api/desktop/enter?k=one-time-key", api.base)).send().await.unwrap();
	assert_eq!(again.status(), 403);
}

#[tokio::test]
async fn upload_publish_and_history_in_demo_mode() {
	let api = Api::start().await;
	let (status, accounts) = api.send(Method::POST, "/api/demo/accounts", json!({})).await;
	assert_eq!(status, 200);
	let accounts = accounts.as_array().unwrap().clone();
	assert_eq!(accounts.len(), 3);
	assert!(accounts.iter().all(|a| a["isDemo"] == true && a.get("access_token").is_none() && a.get("accessToken").is_none()));

	// A real (tiny) MP4: vertical, 6 seconds.
	let (status, media) = api.upload("my%20clip.mp4", "video/mp4", fixtures::mp4(b"avc1", 1080, 1920, 6, 30, true)).await;
	assert_eq!(status, 200, "{media}");
	assert_eq!(media["filename"], "my clip.mp4");
	assert_eq!((media["width"].as_i64(), media["height"].as_i64(), media["duration"].as_f64()), (Some(1080), Some(1920), Some(6.0)));
	assert_eq!(media["videoCodec"], "h264");
	assert_eq!(media["shortsShape"], true);
	assert_eq!(media["issues"]["youtube"], json!([]));

	// Not a video: refused, and nothing is left on disk.
	let (status, body) = api.upload("notes.mp4", "video/mp4", b"just some text".to_vec()).await;
	assert_eq!(status, 422);
	assert!(body["error"].as_str().unwrap().contains("no video stream"));
	assert_eq!(api.upload("a.txt", "text/plain", b"x".to_vec()).await.0, 415);
	assert_eq!(std::fs::read_dir(api.app.media_dir()).unwrap().count(), 1);

	// The preview link plays in the window and supports seeking.
	let found = api.get(&format!("/api/media/{}", media["id"].as_str().unwrap())).await;
	let preview = found["previewUrl"].as_str().unwrap().to_string();
	let part = api.http.get(format!("{}{preview}", api.base)).header("Range", "bytes=0-99").send().await.unwrap();
	assert_eq!(part.status(), 206);
	assert_eq!(part.headers()["content-range"].to_str().unwrap().split('/').next().unwrap(), "bytes 0-99");
	assert_eq!(part.bytes().await.unwrap().len(), 100);
	assert_eq!(api.http.get(format!("{}/m/forged.token", api.base)).send().await.unwrap().status(), 404);

	// Validation: YouTube needs a title; nothing is queued while anything is wrong.
	let target = |a: &Value, settings: Value| json!({ "accountId": a["id"], "settings": settings });
	let by = |p: &str| accounts.iter().find(|a| a["platform"] == p).unwrap().clone();
	let (status, body) = api
		.send(
			Method::POST,
			"/api/posts",
			json!({ "idempotencyKey": "key-12345678", "mediaId": media["id"], "caption": "hello", "targets": [target(&by("youtube"), json!({ "privacy": "private", "madeForKids": false }))] }),
		)
		.await;
	assert_eq!(status, 422);
	assert!(body["issues"].as_array().unwrap().iter().any(|i| i["field"] == "youtube.title"));
	let (status, body) = api.send(Method::POST, "/api/posts", json!({ "idempotencyKey": "key-12345678", "mediaId": media["id"], "caption": "hello", "targets": [] })).await;
	assert_eq!(status, 400);
	assert_eq!(body["issues"][0]["message"], "Choose at least one destination.");
	assert_eq!(api.get("/api/posts").await, json!([]));

	let good = json!({
		"idempotencyKey": "key-12345678",
		"mediaId": media["id"],
		"caption": "hello",
		"targets": [target(&by("youtube"), json!({ "title": "My clip", "privacy": "private", "madeForKids": false })), target(&by("instagram"), json!({})), target(&by("tiktok"), json!({}))],
	});
	// Drafts only is on by default, as on the Mac: Instagram has no drafts, so it is refused...
	assert_eq!(api.get("/api/config").await["draftsOnly"], true);
	let (status, body) = api.send(Method::POST, "/api/posts", good.clone()).await;
	assert_eq!(status, 422);
	assert!(body["issues"][0]["message"].as_str().unwrap().contains("Instagram has no drafts"), "{body}");
	assert_eq!(api.get("/api/posts").await, json!([]));
	// Turning it off allows Instagram again (TikTok and the inbox folder: tests/mac_parity.rs).
	let (status, prefs) = api.send(Method::PUT, "/api/desktop/prefs", json!({ "draftsOnly": false })).await;
	assert_eq!((status, prefs["draftsOnly"].clone()), (StatusCode::OK, json!(false)));

	let (status, created) = api.send(Method::POST, "/api/posts", good.clone()).await;
	assert_eq!(status, 200, "{created}");
	assert_eq!(created["duplicate"], false);
	assert_eq!(created["post"]["targets"].as_array().unwrap().len(), 3);
	assert_eq!(api.get("/api/status").await["activeJobs"], 3);

	// A double click sends the same key again: same post, no new jobs.
	let (_, again) = api.send(Method::POST, "/api/posts", good).await;
	assert_eq!(again["duplicate"], true);
	assert_eq!(again["post"]["id"], created["post"]["id"]);
	assert_eq!(api.get("/api/status").await["activeJobs"], 3);

	// An account with a post in progress cannot be disconnected.
	let (status, _) = api.send(Method::DELETE, &format!("/api/accounts/{}", by("youtube")["id"].as_str().unwrap()), json!({})).await;
	assert_eq!(status, 409);

	runner::tick(&api.app, "w", 3).await;
	let post = api.get(&format!("/api/posts/{}", created["post"]["id"].as_str().unwrap())).await;
	assert_eq!(post["done"], true);
	let state = |p: &str| post["targets"].as_array().unwrap().iter().find(|t| t["platform"] == p).unwrap()["state"].clone();
	assert_eq!((state("youtube"), state("instagram"), state("tiktok")), (json!("published"), json!("published"), json!("needs_attention")));
	assert!(post["targets"].as_array().unwrap().iter().all(|t| t["permalink"].is_null()));
	assert_eq!(api.get("/api/posts").await.as_array().unwrap().len(), 1);
	assert_eq!(api.get("/api/status").await["activeJobs"], 0);

	// Only the destination that needs attention can be retried.
	let (status, retried) = api.send(Method::POST, &format!("/api/posts/{}/retry", post["id"].as_str().unwrap()), json!({})).await;
	assert_eq!(status, 200);
	assert_eq!(retried["retried"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn platform_keys_are_checked_stored_encrypted_and_never_sent_back() {
	let api = Api::start().await;
	let (status, body) = api.send(Method::PUT, "/api/setup/youtube", json!({ "id": "not-a-google-id", "secret": "s3cret-value" })).await;
	assert_eq!(status, 422);
	assert_eq!(body["issues"][0]["message"], "A Google client ID ends in .apps.googleusercontent.com.");
	assert_eq!(api.send(Method::PUT, "/api/setup/public-url", json!({ "publicBaseUrl": "http://insecure.example" })).await.0, 422);
	assert_eq!(api.send(Method::PUT, "/api/setup/myspace", json!({ "id": "a", "secret": "b" })).await.0, 404);

	// Before keys exist, connecting says so instead of opening a broken sign-in page.
	let (status, body) = api.send(Method::POST, "/api/oauth/youtube/begin", json!({})).await;
	assert_eq!(status, 409);
	assert!(body["error"].as_str().unwrap().contains("not set up yet"));

	let id = "1234567890-abcdefghijk.apps.googleusercontent.com";
	let (status, view) = api.send(Method::PUT, "/api/setup/youtube", json!({ "id": id, "secret": "GOCSPX-very-secret-value" })).await;
	assert_eq!(status, 200);
	let yt = &view["platforms"]["youtube"];
	assert_eq!((yt["configured"].clone(), yt["hasSecret"].clone(), yt["source"].clone()), (json!(true), json!(true), json!("app")));
	assert_eq!(yt["redirectUri"], "http://127.0.0.1:8787/api/oauth/youtube/callback");
	assert!(!view.to_string().contains("GOCSPX-very-secret-value") && !view.to_string().contains(id));
	let stored: Vec<String> = { api.app.db().prepare("SELECT value FROM app_settings").unwrap().query_map([], |r| r.get(0)).unwrap().flatten().collect() };
	assert_eq!(stored.len(), 2);
	assert!(stored.iter().all(|v| v.starts_with("v1.") && !v.contains("GOCSPX")));

	// Sign-in opens Google with PKCE and a one-use state held by the server.
	let (_, begin) = api.send(Method::POST, "/api/oauth/youtube/begin", json!({})).await;
	let url = url::Url::parse(begin["url"].as_str().unwrap()).unwrap();
	assert_eq!(url.host_str(), Some("accounts.google.com"));
	let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
	assert_eq!(q["client_id"], id);
	assert_eq!(q["code_challenge_method"], "S256");
	assert_eq!(q["redirect_uri"], "http://127.0.0.1:8787/api/oauth/youtube/callback");
	// A callback with a state the server never issued is refused (the callback is an open route).
	let forged = api.http.get(format!("{}/api/oauth/youtube/callback?state=forged&code=abc", api.base)).send().await.unwrap();
	assert!(forged.text().await.unwrap().contains("expired or did not match"));

	// Instagram and TikTok use the public HTTPS address for their redirects.
	let (_, view) = api.send(Method::PUT, "/api/setup/public-url", json!({ "publicBaseUrl": "https://my-tunnel.example/" })).await;
	assert_eq!(view["platforms"]["instagram"]["redirectUri"], "https://my-tunnel.example/api/oauth/instagram/callback");
	assert_eq!(view["platforms"]["youtube"]["redirectUri"], "http://127.0.0.1:8787/api/oauth/youtube/callback");

	let (_, view) = api.send(Method::DELETE, "/api/setup/youtube", json!({})).await;
	assert_eq!(view["platforms"]["youtube"]["configured"], false);
}
