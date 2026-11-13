//! Shared test helpers: seeded rows and a scriptable stand-in for the platform APIs.
#![allow(dead_code)]
use axum::extract::{Request, State};
use axum::response::Response;
use axum::Router;
use publisher_core::accounts::upsert_account;
use publisher_core::db::{AccountRow, Platform, TargetRow};
use publisher_core::jobs::{self, NewTarget};
use publisher_core::platforms::{Identity, TokenSet};
use publisher_core::util::now_ms;
use publisher_core::{runner, App, Endpoints};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Call {
	pub method: String,
	pub path: String,
	pub query: String,
	pub range: Option<String>,
	pub body: String,
}

impl Call {
	/// A resumable-upload status query ("how much do you have?"), which sends no video bytes.
	pub fn is_status_query(&self) -> bool {
		self.range.as_deref().map(|r| r.starts_with("bytes */")).unwrap_or(false)
	}
}

pub struct Reply {
	pub status: u16,
	pub headers: Vec<(&'static str, String)>,
	pub body: String,
}

pub fn json(status: u16, body: Value) -> Reply {
	Reply { status, headers: vec![], body: body.to_string() }
}
pub fn empty(status: u16) -> Reply {
	Reply { status, headers: vec![], body: String::new() }
}

type Handler = dyn Fn(&Call, &[Call]) -> Reply + Send + Sync;
type MockState = (Arc<Mutex<Vec<Call>>>, Arc<Handler>);

#[derive(Clone)]
pub struct Mock {
	pub base: String,
	calls: Arc<Mutex<Vec<Call>>>,
}

impl Mock {
	/// Starts a local server. `handler` gets the current call and every earlier one.
	pub async fn start(handler: impl Fn(&Call, &[Call]) -> Reply + Send + Sync + 'static) -> Mock {
		let calls: Arc<Mutex<Vec<Call>>> = Arc::new(Mutex::new(Vec::new()));
		let handler: Arc<Handler> = Arc::new(handler);
		let state: MockState = (calls.clone(), handler);
		let app = Router::new().fallback(serve).with_state(state);
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let base = format!("http://{}", listener.local_addr().unwrap());
		tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
		Mock { base, calls }
	}

	pub fn calls(&self) -> Vec<Call> {
		self.calls.lock().unwrap().clone()
	}
	pub fn count(&self, f: impl Fn(&Call) -> bool) -> usize {
		self.calls().iter().filter(|c| f(c)).count()
	}

	pub fn endpoints(&self) -> Endpoints {
		Endpoints {
			google_token: format!("{}/google/token", self.base),
			google_revoke: format!("{}/google/revoke", self.base),
			youtube_api: format!("{}/youtube", self.base),
			youtube_upload: format!("{}/youtube-upload", self.base),
			youtube_analytics: format!("{}/yt-analytics", self.base),
			instagram_graph: format!("{}/ig", self.base),
			instagram_api: format!("{}/ig-api", self.base),
			tiktok_api: format!("{}/tiktok", self.base),
			relay: None,
			relay_platforms: publisher_core::db::PLATFORMS.to_vec(),
		}
	}

	/** Endpoints with the sign-in relay at `<mock>/relay`. */
	pub fn endpoints_with_relay(&self) -> Endpoints {
		Endpoints { relay: Some(format!("{}/relay", self.base)), ..self.endpoints() }
	}
}

async fn serve(State((calls, handler)): State<MockState>, req: Request) -> Response {
	let (parts, body) = req.into_parts();
	let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default();
	let call = Call {
		method: parts.method.to_string(),
		path: parts.uri.path().to_string(),
		query: parts.uri.query().unwrap_or("").to_string(),
		range: parts.headers.get("content-range").and_then(|v| v.to_str().ok()).map(String::from),
		// Video chunks are large and irrelevant; keep only small bodies.
		body: if bytes.len() < 4096 { String::from_utf8_lossy(&bytes).into_owned() } else { format!("<{} bytes>", bytes.len()) },
	};
	let earlier = calls.lock().unwrap().clone();
	let reply = handler(&call, &earlier);
	calls.lock().unwrap().push(call);
	let mut res = Response::builder().status(reply.status);
	for (k, v) in reply.headers {
		res = res.header(k, v);
	}
	res.body(axum::body::Body::from(reply.body)).unwrap()
}

pub fn seed_media(app: &App, bytes: usize) -> String {
	let id = format!("m{}", publisher_core::crypto::random_id(11));
	let file = app.media_dir().join(format!("{id}.mp4"));
	std::fs::write(&file, vec![7u8; bytes]).unwrap();
	app.db()
		.execute(
			"INSERT INTO media (id, path, filename, mime, size, duration, width, height, video_codec, audio_codec, fps, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
			rusqlite::params![id, file.to_string_lossy(), "clip.mp4", "video/mp4", bytes as i64, 20.0, 1080, 1920, "h264", "aac", 30.0, now_ms()],
		)
		.unwrap();
	id
}

pub fn seed_account(app: &App, platform: Platform, demo: bool) -> AccountRow {
	let p = platform.as_str();
	upsert_account(
		app,
		platform,
		&Identity { external_id: format!("{p}-1"), display_name: format!("{p} acct"), handle: Some(format!("@{p}acct")), ..Default::default() },
		&TokenSet { access_token: format!("secret-access-{p}"), refresh_token: Some(format!("secret-refresh-{p}")), access_expires_at: Some(now_ms() + 30 * 86_400_000), ..Default::default() },
		demo,
	)
	.unwrap()
}

/// One post with one destination. Returns (post id, target id, account id).
pub fn new_target(app: &App, platform: Platform, demo: bool, caption: &str, settings: Value) -> (String, String, String) {
	let m = seed_media(app, 3 * 1024 * 1024);
	let a = seed_account(app, platform, demo);
	let key = format!("k-{}", publisher_core::crypto::random_id(8));
	let (post, _) = jobs::create_post(app, &key, &m, caption, demo, &[NewTarget { account_id: a.id.clone(), platform: platform.as_str().into(), settings }], None).unwrap();
	let target = jobs::post_view(app, &post).unwrap()["targets"][0]["id"].as_str().unwrap().to_string();
	(post, target, a.id)
}

pub fn target(app: &App, id: &str) -> TargetRow {
	jobs::get_target(app, id).unwrap()
}

pub fn rf(app: &App, id: &str) -> Value {
	serde_json::from_str(target(app, id).provider_ref.as_deref().unwrap_or("{}")).unwrap()
}

/// Puts a target in the state "something was sent last time and the outcome is unknown".
pub fn set_ref(app: &App, id: &str, provider_ref: Value, phase: &str) {
	app.db().execute("UPDATE targets SET provider_ref = ?, phase = ?, uncertain = 1 WHERE id = ?", rusqlite::params![provider_ref.to_string(), phase, id]).unwrap();
}

/// Makes a queued target due now and runs it, as the worker would.
pub async fn run_again(app: &Arc<App>, id: &str) -> TargetRow {
	app.db().execute("UPDATE targets SET next_run_at = 0 WHERE id = ?", [id]).unwrap();
	let t = jobs::claim_next(app, "w").expect("a target should be due");
	assert_eq!(t.id, id);
	runner::run_target(app, t, "w").await;
	target(app, id)
}
