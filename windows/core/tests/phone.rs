//! Phone access: pairing with a one-use link, what a paired phone may do, removing it, turning it off.
use publisher_core::{server, App, Endpoints};
use reqwest::{Client, Method, StatusCode};
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
	/// As the app window sends it.
	async fn desk(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
		let res = self.http.request(method, format!("{}{path}", self.base)).header("Cookie", format!("sp_desktop={}", self.app.cfg.desktop_token)).header("X-Requested-With", "social-publisher").json(&body).send().await.unwrap();
		let status = res.status();
		(status, res.json().await.unwrap_or(Value::Null))
	}
	/// As a phone sends it, with its own cookie (or none).
	async fn phone(&self, cookie: &str, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
		let res = self.http.request(method, format!("{}{path}", self.base)).header("Cookie", cookie).header("X-Requested-With", "social-publisher").json(&body).send().await.unwrap();
		let status = res.status();
		(status, res.json().await.unwrap_or(Value::Null))
	}
}

fn link_path(url: &str) -> String {
	format!("/pair/{}", url.rsplit("/pair/").next().unwrap())
}

#[tokio::test]
async fn a_phone_pairs_once_and_can_post_but_not_change_keys() {
	let api = Api::start().await;
	// Off by default: no pairing, and the page tells a phone nothing about pairing.
	assert_eq!(api.desk(Method::POST, "/api/phone/pair", json!({})).await.0, StatusCode::CONFLICT);
	assert_eq!(api.phone("", Method::GET, "/api/session", json!({})).await.1["phonePairing"], false);

	// A public HTTPS address makes the pairing link work whatever Wi-Fi the test machine has.
	api.desk(Method::PUT, "/api/setup/public-url", json!({ "publicBaseUrl": "https://publisher.example.test" })).await;
	let (status, view) = api.desk(Method::PUT, "/api/phone", json!({ "enabled": true })).await;
	assert_eq!((status, view["enabled"].clone()), (StatusCode::OK, json!(true)), "{view}");
	let (status, pair) = api.desk(Method::POST, "/api/phone/pair", json!({})).await;
	assert_eq!(status, StatusCode::OK, "{pair}");
	assert!(pair["qr"].as_str().unwrap().starts_with("<?xml") || pair["qr"].as_str().unwrap().contains("<svg"));
	let path = link_path(pair["url"].as_str().unwrap());

	// The phone opens the link: it gets its own cookie, once.
	let res = api.http.get(format!("{}{path}", api.base)).header("User-Agent", "Mozilla/5.0 (Linux; Android 15; Pixel 9)").send().await.unwrap();
	assert_eq!(res.status(), 200);
	let set = res.headers()["set-cookie"].to_str().unwrap().to_string();
	assert!(set.starts_with("sp_phone=") && set.contains("HttpOnly") && set.contains("SameSite=Lax"), "{set}");
	let cookie = set.split(';').next().unwrap().to_string();
	assert_eq!(api.http.get(format!("{}{path}", api.base)).send().await.unwrap().status(), StatusCode::GONE);

	let (_, s) = api.phone(&cookie, Method::GET, "/api/session", json!({})).await;
	assert_eq!((s["signedIn"].clone(), s["phone"].clone(), s["desktop"].clone()), (json!(true), json!(true), json!(false)));
	let (_, view) = api.desk(Method::GET, "/api/phone", json!({})).await;
	assert_eq!(view["devices"][0]["name"], "Android phone");

	// What a phone may do: read and post, and its own preferences.
	assert_eq!(api.phone(&cookie, Method::GET, "/api/accounts", json!({})).await.0, StatusCode::OK);
	assert_eq!(api.phone(&cookie, Method::POST, "/api/demo/accounts", json!({})).await.0, StatusCode::OK);
	assert_eq!(api.phone(&cookie, Method::GET, "/api/desktop/prefs", json!({})).await.0, StatusCode::OK);
	// Drafts only can only be changed on the computer.
	assert_eq!(api.phone(&cookie, Method::PUT, "/api/desktop/prefs", json!({ "draftsOnly": false })).await.0, StatusCode::FORBIDDEN);
	assert_eq!(api.phone(&cookie, Method::GET, "/api/setup", json!({})).await.0, StatusCode::OK);
	// What stays on the computer.
	for (m, p) in [
		(Method::PUT, "/api/setup/youtube"),
		(Method::PUT, "/api/setup/public-url"),
		(Method::POST, "/api/oauth/youtube/begin"),
		(Method::GET, "/api/phone"),
		(Method::POST, "/api/phone/pair"),
		(Method::POST, "/api/desktop/pick-video"),
		(Method::POST, "/api/desktop/reveal-logs"),
	] {
		assert_eq!(api.phone(&cookie, m.clone(), p, json!({})).await.0, StatusCode::FORBIDDEN, "{m} {p}");
	}
	// A made-up key, or one without the app's header, gets nothing.
	assert_eq!(api.phone("sp_phone=abc.def", Method::GET, "/api/accounts", json!({})).await.0, StatusCode::UNAUTHORIZED);
	let no_header = api.http.post(format!("{}/api/demo/accounts", api.base)).header("Cookie", &cookie).send().await.unwrap();
	assert_eq!(no_header.status(), StatusCode::FORBIDDEN);

	// Turning phone access off refuses every phone at once; on again, the same phone works.
	api.desk(Method::PUT, "/api/phone", json!({ "enabled": false })).await;
	assert_eq!(api.phone(&cookie, Method::GET, "/api/accounts", json!({})).await.0, StatusCode::UNAUTHORIZED);
	api.desk(Method::PUT, "/api/phone", json!({ "enabled": true })).await;
	assert_eq!(api.phone(&cookie, Method::GET, "/api/accounts", json!({})).await.0, StatusCode::OK);

	// Removing it on the computer ends it.
	let id = view["devices"][0]["id"].as_str().unwrap().to_string();
	let (_, view) = api.desk(Method::DELETE, &format!("/api/phone/devices/{id}"), json!({})).await;
	assert_eq!(view["devices"], json!([]));
	assert_eq!(api.phone(&cookie, Method::GET, "/api/accounts", json!({})).await.0, StatusCode::UNAUTHORIZED);

	// Signing out on a phone forgets that phone.
	let (_, pair) = api.desk(Method::POST, "/api/phone/pair", json!({})).await;
	let res = api.http.get(format!("{}{}", api.base, link_path(pair["url"].as_str().unwrap()))).header("User-Agent", "iPhone").send().await.unwrap();
	let cookie = res.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
	assert_eq!(api.phone(&cookie, Method::DELETE, "/api/session", json!({})).await.0, StatusCode::OK);
	assert_eq!(api.phone(&cookie, Method::GET, "/api/accounts", json!({})).await.0, StatusCode::UNAUTHORIZED);
	assert_eq!(api.desk(Method::GET, "/api/phone", json!({})).await.1["devices"], json!([]));
	api.desk(Method::PUT, "/api/phone", json!({ "enabled": false })).await;
}

#[tokio::test]
async fn encoded_or_odd_paths_cannot_skip_the_checks() {
	let api = Api::start().await;
	// Never the API's data without the window's cookie: either 401 or the app's page.
	for path in ["/%61pi/accounts", "/%61pi/phone", "/api/%70hone", "/api//accounts", "/api/accounts/", "/API/accounts"] {
		let res = api.http.get(format!("{}{path}", api.base)).send().await.unwrap();
		let status = res.status();
		let html = res.headers().get("content-type").map(|v| v.to_str().unwrap().starts_with("text/html")).unwrap_or(false);
		assert!(status == StatusCode::UNAUTHORIZED || status == StatusCode::NOT_FOUND || html, "{path} {status}");
	}
	api.desk(Method::PUT, "/api/setup/public-url", json!({ "publicBaseUrl": "https://publisher.example.test" })).await;
	api.desk(Method::PUT, "/api/phone", json!({ "enabled": true })).await;
	let (_, pair) = api.desk(Method::POST, "/api/phone/pair", json!({})).await;
	let res = api.http.get(format!("{}{}", api.base, link_path(pair["url"].as_str().unwrap()))).send().await.unwrap();
	let cookie = res.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
	for (m, p) in [(Method::GET, "/api/%70hone"), (Method::PUT, "/%61pi/setup/youtube"), (Method::POST, "/api/oauth/youtube/%62egin"), (Method::POST, "/api/desktop/%70ick-video")] {
		let (status, body) = api.phone(&cookie, m.clone(), p, json!({})).await;
		assert!(status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND || !body.is_object() || body.get("error").is_some(), "{m} {p} {status} {body}");
		assert_ne!(status, StatusCode::OK, "{m} {p} {body}");
	}
	api.desk(Method::PUT, "/api/phone", json!({ "enabled": false })).await;
}
