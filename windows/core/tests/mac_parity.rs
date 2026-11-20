//! Features the Mac app gained after the Windows port: drafts only, account groups, the inbox folder,
//! the public Terms and Privacy pages, and the Instagram sign-in routes.
mod common;
use publisher_core::db::Platform;
use publisher_core::probe::fixtures;
use publisher_core::{inbox, server, App, Endpoints};
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
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
		Api { app, base, http: Client::new() }
	}
	fn req(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
		self.http.request(method, format!("{}{path}", self.base)).header("Cookie", format!("sp_desktop={}", self.app.cfg.desktop_token)).header("X-Requested-With", "social-publisher")
	}
	async fn send(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
		let res = self.req(method, path).json(&body).send().await.unwrap();
		let status = res.status();
		(status, res.json().await.unwrap_or(Value::Null))
	}
	async fn get(&self, path: &str) -> Value {
		self.req(Method::GET, path).send().await.unwrap().json().await.unwrap()
	}
}

#[tokio::test]
async fn drafts_only_sends_tiktok_to_the_inbox_and_groups_work() {
	let api = Api::start().await;
	let (_, accounts) = api.send(Method::POST, "/api/demo/accounts", json!({})).await;
	let by = |p: &str| accounts.as_array().unwrap().iter().find(|a| a["platform"] == p).unwrap()["id"].clone();
	let config = api.get("/api/config").await;
	for f in ["groups", "draftsOnly", "inbox"] {
		assert!(config["features"].as_array().unwrap().contains(&json!(f)), "missing feature {f}");
	}

	let (status, media) = api.req(Method::PUT, "/api/media").header("Content-Type", "video/mp4").header("X-Filename", "a.mp4").body(fixtures::mp4(b"avc1", 1080, 1920, 6, 30, true)).send().await.map(|r| (r.status(), r)).unwrap();
	assert_eq!(status, 200);
	let media: Value = media.json().await.unwrap();
	let post = json!({
		"idempotencyKey": "drafts-12345678",
		"mediaId": media["id"],
		"caption": "hello",
		"targets": [
			{ "accountId": by("youtube"), "settings": { "title": "My clip", "privacy": "public", "madeForKids": false } },
			{ "accountId": by("tiktok"), "settings": { "mode": "direct", "privacy": "PUBLIC_TO_EVERYONE" } },
		],
	});
	let (status, made) = api.send(Method::POST, "/api/posts", post).await;
	assert_eq!(status, 200, "{made}");
	let sent = made["post"]["targets"].as_array().unwrap();
	let of = |p: &str| sent.iter().find(|t| t["platform"] == p).unwrap()["settings"].clone();
	assert_eq!((of("tiktok")["mode"].clone(), of("tiktok")["privacy"].clone()), (json!("inbox"), json!("SELF_ONLY")));
	assert_eq!(of("youtube")["privacy"], "public");

	// Groups: create, list, rename, refuse bad input, delete.
	let (status, g) = api.send(Method::POST, "/api/groups", json!({ "name": " Roblox ", "accountIds": [by("youtube"), by("tiktok"), "nope"] })).await;
	assert_eq!(status, 200, "{g}");
	assert_eq!((g["name"].clone(), g["accountIds"].as_array().unwrap().len()), (json!("Roblox"), 2));
	assert_eq!(api.send(Method::POST, "/api/groups", json!({ "name": "", "accountIds": [by("youtube")] })).await.0, 422);
	assert_eq!(api.send(Method::POST, "/api/groups", json!({ "name": "x", "accountIds": [] })).await.0, 422);
	let id = g["id"].as_str().unwrap();
	let (status, list) = api.send(Method::PUT, &format!("/api/groups/{id}"), json!({ "name": "Shorts", "accountIds": [by("youtube")] })).await;
	assert_eq!((status, list[0]["name"].clone(), list[0]["accountIds"].clone()), (StatusCode::OK, json!("Shorts"), json!([by("youtube")])));
	assert_eq!(api.send(Method::DELETE, &format!("/api/groups/{id}"), json!({})).await.1, json!([]));
	assert_eq!(api.send(Method::DELETE, "/api/groups/missing", json!({})).await.0, 404);

	// The Terms and Privacy pages are public; the API stays locked.
	for page in ["/terms", "/privacy"] {
		let res = api.http.get(format!("{}{page}", api.base)).send().await.unwrap();
		assert_eq!(res.status(), 200);
		assert!(res.text().await.unwrap().contains("Publisher"));
	}
	assert_eq!(api.http.get(format!("{}/api/groups", api.base)).send().await.unwrap().status(), 401);
}

#[tokio::test]
async fn instagram_sign_in_route_follows_the_setup() {
	let api = Api::start().await;
	let (status, setup) = api.send(Method::PUT, "/api/setup/instagram", json!({ "id": "1234567", "secret": "abc", "loginMode": "facebook" })).await;
	assert_eq!(status, 200, "{setup}");
	assert_eq!(setup["platforms"]["instagram"]["loginMode"], "facebook");
	let url = publisher_core::platforms::authorize_url(&api.app, Platform::Instagram, "s", "c");
	assert!(url.starts_with("https://www.facebook.com/") && url.contains("pages_show_list"), "{url}");

	// Unified login needs its configuration ID, which is a number.
	assert_eq!(api.send(Method::PUT, "/api/setup/instagram", json!({ "id": "1234567", "secret": "abc", "loginMode": "unified" })).await.0, 422);
	assert_eq!(api.send(Method::PUT, "/api/setup/instagram", json!({ "id": "1234567", "secret": "abc", "configId": "abc" })).await.0, 422);
	let (_, setup) = api.send(Method::PUT, "/api/setup/instagram", json!({ "id": "1234567", "secret": "abc", "configId": "98765432" })).await;
	assert_eq!(setup["platforms"]["instagram"]["loginMode"], "unified");
	assert!(publisher_core::platforms::authorize_url(&api.app, Platform::Instagram, "s", "c").contains("config_id=98765432"));

	// Back to Instagram Login, which always asks for the account so a second one can be added.
	let (_, setup) = api.send(Method::PUT, "/api/setup/instagram", json!({ "id": "1234567", "secret": "abc", "loginMode": "instagram" })).await;
	assert_eq!((setup["platforms"]["instagram"]["loginMode"].clone(), setup["platforms"]["instagram"]["configPreview"].clone()), (json!("instagram"), Value::Null));
	assert!(publisher_core::platforms::authorize_url(&api.app, Platform::Instagram, "s", "c").contains("force_reauth=true"));
	assert!(publisher_core::platforms::authorize_url(&api.app, Platform::Youtube, "s", "c").contains("prompt=select_account"));
	assert!(publisher_core::platforms::authorize_url(&api.app, Platform::Tiktok, "s", "c").contains("disable_auto_auth=1"));

	// A cancelled sign-in is explained in plain words.
	let page = api.http.get(format!("{}/api/oauth/youtube/callback?error=access_denied&state=x", api.base)).send().await.unwrap().text().await.unwrap();
	assert!(page.contains("Google cancelled the sign-in"), "{page}");
}

#[tokio::test]
async fn the_inbox_folder_sends_drops_as_drafts() {
	let dir = std::env::temp_dir().join(format!("publisher-inbox-test-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(&dir).unwrap();
	// Only this test reads INBOX_DIR.
	std::env::set_var("INBOX_DIR", &dir);
	let app = App::for_tests(Endpoints::default());
	common::seed_account(&app, Platform::Youtube, false);
	common::seed_account(&app, Platform::Tiktok, false);
	common::seed_account(&app, Platform::Instagram, false);

	std::fs::write(dir.join("my-story.mp4"), fixtures::mp4(b"avc1", 1080, 1920, 6, 30, true)).unwrap();
	std::fs::write(dir.join("my-story.json"), json!({ "title": "Story", "caption": "A story #tag", "privacy": "unlisted" }).to_string()).unwrap();
	std::fs::write(dir.join("broken.mp4"), fixtures::mp4(b"avc1", 1080, 1920, 6, 30, true)).unwrap();
	std::fs::write(dir.join("broken.json"), "{ not json").unwrap();
	// A blank account name must never mean "every account".
	std::fs::write(dir.join("blank.mp4"), fixtures::mp4(b"avc1", 1080, 1920, 6, 30, true)).unwrap();
	std::fs::write(dir.join("blank.json"), json!({ "caption": "x", "accounts": [" "] }).to_string()).unwrap();
	let (mut sizes, mut busy) = (HashMap::new(), HashSet::new());
	// The first look only notes the sizes (a video may still be copying); the second sends.
	inbox::scan(&app, &mut sizes, &mut busy).await;
	assert!(dir.join("my-story.mp4").exists());
	inbox::scan(&app, &mut sizes, &mut busy).await;

	assert!(dir.join("Sent").join("my-story.mp4").exists() && dir.join("Sent").join("my-story.json").exists());
	let receipt: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("Sent").join("my-story.result.json")).unwrap()).unwrap();
	assert_eq!(receipt["to"].as_array().unwrap().len(), 2, "{receipt}");
	let post = publisher_core::jobs::post_view(&app, receipt["postId"].as_str().unwrap()).unwrap();
	let targets = post["targets"].as_array().unwrap();
	assert!(targets.iter().all(|t| t["platform"] != "instagram"));
	let of = |p: &str| targets.iter().find(|t| t["platform"] == p).unwrap()["settings"].clone();
	assert_eq!((of("youtube")["privacy"].clone(), of("youtube")["title"].clone()), (json!("unlisted"), json!("Story")));
	assert_eq!(of("tiktok")["mode"], "inbox");

	let why = std::fs::read_to_string(dir.join("Needs attention").join("broken.error.txt")).unwrap();
	assert!(why.contains("not valid JSON"), "{why}");
	let why = std::fs::read_to_string(dir.join("Needs attention").join("blank.error.txt")).unwrap();
	assert!(why.contains("No connected YouTube or TikTok account called"), "{why}");
	let status = inbox::status(&app);
	assert_eq!(status["recent"].as_array().unwrap().len(), 3);
	let _ = std::fs::remove_dir_all(&dir);
}
