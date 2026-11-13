//! Shared state for the API and the worker. Both run inside one process, so they share one SQLite
//! connection, one HTTP client and one settings cache.
use crate::logging::Logger;
use parking_lot::{Mutex, ReentrantMutex, ReentrantMutexGuard};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

pub struct Config {
	pub version: String,
	pub port: u16,
	/// Origin of the local server, for example `http://127.0.0.1:8787`.
	pub app_url: String,
	pub data_dir: PathBuf,
	pub logs_dir: PathBuf,
	pub session_secret: String,
	pub token_key: [u8; 32],
	/// Per-launch secret that only the app's own window holds, as a cookie.
	pub desktop_token: String,
	pub demo_mode: bool,
	pub media_retention_hours: f64,
	pub max_upload_bytes: u64,
	/// Public HTTPS address from settings.json. A value saved in the app takes priority.
	pub public_base_url: Option<String>,
	pub instagram_api_version: String,
	pub tiktok_direct_post: bool,
	/// Optional ffprobe used only when the built-in reader cannot understand a file.
	pub ffprobe: Option<PathBuf>,
}

/** Base addresses of the platform APIs. Tests point these at a local mock server. */
#[derive(Clone)]
pub struct Endpoints {
	pub google_token: String,
	pub google_revoke: String,
	pub youtube_api: String,
	pub youtube_upload: String,
	pub youtube_analytics: String,
	pub instagram_graph: String,
	pub instagram_api: String,
	pub tiktok_api: String,
	/// The operator's sign-in relay (see `relay.rs`). `None` means customers bring their own developer keys.
	pub relay: Option<String>,
	/// Platforms the relay is set up for.
	pub relay_platforms: Vec<crate::db::Platform>,
}

/** The relay address built into this copy of the app: `PUBLISHER_RELAY_URL` at build time. */
pub fn built_in_relay() -> Option<String> {
	option_env!("PUBLISHER_RELAY_URL").map(str::trim).filter(|s| s.starts_with("https://")).map(String::from)
}

/** `PUBLISHER_RELAY_PLATFORMS` at build time, for example `youtube,tiktok`. All three when unset. */
pub fn built_in_relay_platforms() -> Vec<crate::db::Platform> {
	match option_env!("PUBLISHER_RELAY_PLATFORMS").map(str::trim).filter(|s| !s.is_empty()) {
		Some(list) => list.split(',').filter_map(|p| crate::db::Platform::parse(p.trim())).collect(),
		None => crate::db::PLATFORMS.to_vec(),
	}
}

impl Default for Endpoints {
	fn default() -> Self {
		Endpoints {
			relay: built_in_relay(),
			relay_platforms: built_in_relay_platforms(),
			google_token: "https://oauth2.googleapis.com/token".into(),
			google_revoke: "https://oauth2.googleapis.com/revoke".into(),
			youtube_api: "https://www.googleapis.com/youtube/v3".into(),
			youtube_upload: "https://www.googleapis.com/upload/youtube/v3".into(),
			youtube_analytics: "https://youtubeanalytics.googleapis.com/v2".into(),
			instagram_graph: "https://graph.instagram.com".into(),
			instagram_api: "https://api.instagram.com".into(),
			tiktok_api: "https://open.tiktokapis.com".into(),
		}
	}
}

/** What the backend needs from the desktop shell. Calls may block; they run off the async threads. */
pub trait Shell: Send + Sync {
	fn pick_video(&self) -> Option<PathBuf>;
	fn open_url(&self, url: &str);
	fn reveal(&self, path: &Path);
	/// A post finished: show a Windows notification and play the finish sound. Called at most once
	/// per finished post (again only after a retry).
	fn notify(&self, _notice: &Notice) {}
}

/** What a finish notification says. `ok` is false when any destination failed or needs the owner. */
#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
	pub post_id: String,
	pub title: String,
	pub body: String,
	pub ok: bool,
}

pub struct PendingOAuth {
	pub verifier: String,
	pub platform: crate::db::Platform,
	pub exp: i64,
	/// Started through the sign-in relay, so the code must be exchanged there.
	pub via_relay: bool,
}

pub struct App {
	pub cfg: Config,
	db: ReentrantMutex<Connection>,
	pub http: reqwest::Client,
	pub endpoints: Endpoints,
	pub log: Logger,
	pub shell: OnceLock<Box<dyn Shell>>,
	pub(crate) settings_cache: Mutex<Option<(Instant, Arc<HashMap<String, String>>)>>,
	/// Account stats by "account:days", kept for a few minutes (see `analytics.rs`).
	pub(crate) analytics_cache: Mutex<HashMap<String, (Instant, serde_json::Value)>>,
	pub(crate) pending_oauth: Mutex<HashMap<String, PendingOAuth>>,
	pub(crate) refresh_lock: tokio::sync::Mutex<()>,
	/// Wakes the worker as soon as a post is created or retried, instead of waiting for its next poll.
	pub wake: tokio::sync::Notify,
	/// One-use key that lets the app window collect its cookie on first load.
	pub enter_nonce: Mutex<Option<String>>,
	/// Progress of a native-picker import, in thousandths.
	pub(crate) upload_progress: AtomicU32,
	pub(crate) picking: AtomicBool,
	/// Tests skip the adapters' waits.
	pub fast_sleep: AtomicBool,
}

impl App {
	pub fn new(cfg: Config, db: Connection, endpoints: Endpoints, log: Logger) -> Arc<App> {
		let http = reqwest::Client::builder().user_agent(format!("Publisher/{}", cfg.version)).connect_timeout(Duration::from_secs(20)).pool_idle_timeout(Duration::from_secs(90)).build().expect("HTTP client");
		Arc::new(App {
			cfg,
			db: ReentrantMutex::new(db),
			http,
			endpoints,
			log,
			shell: OnceLock::new(),
			settings_cache: Mutex::new(None),
			analytics_cache: Mutex::new(HashMap::new()),
			pending_oauth: Mutex::new(HashMap::new()),
			refresh_lock: tokio::sync::Mutex::new(()),
			wake: tokio::sync::Notify::new(),
			enter_nonce: Mutex::new(None),
			upload_progress: AtomicU32::new(0),
			picking: AtomicBool::new(false),
			fast_sleep: AtomicBool::new(false),
		})
	}

	/// The connection. The lock is re-entrant, so helpers can call each other freely; the guard
	/// cannot be held across an `.await`, which the compiler enforces.
	pub fn db(&self) -> ReentrantMutexGuard<'_, Connection> {
		self.db.lock()
	}

	pub fn media_dir(&self) -> PathBuf {
		self.cfg.data_dir.join("media")
	}

	/// An app on an in-memory database with demo mode on, for tests.
	#[doc(hidden)]
	pub fn for_tests(endpoints: Endpoints) -> Arc<App> {
		Self::for_tests_with(endpoints, |_| {})
	}

	/// Like `for_tests`, with a chance to change the configuration first.
	#[doc(hidden)]
	pub fn for_tests_with(endpoints: Endpoints, change: impl FnOnce(&mut Config)) -> Arc<App> {
		let dir = std::env::temp_dir().join(format!("sp-test-{}", crate::crypto::random_id(6)));
		std::fs::create_dir_all(dir.join("media")).unwrap();
		let mut cfg = Config {
			version: "test".into(),
			port: 8787,
			app_url: "http://127.0.0.1:8787".into(),
			data_dir: dir.clone(),
			logs_dir: dir,
			session_secret: crate::crypto::b64(&crate::crypto::random_bytes(32)),
			token_key: [9u8; 32],
			desktop_token: "test-desktop-token-0123456789".into(),
			demo_mode: true,
			media_retention_hours: 72.0,
			max_upload_bytes: 4096 * 1024 * 1024,
			public_base_url: Some("https://public.example.test".into()),
			instagram_api_version: "v25.0".into(),
			tiktok_direct_post: false,
			ffprobe: None,
		};
		change(&mut cfg);
		let app = App::new(cfg, crate::db::open(None).unwrap(), endpoints, Logger::none());
		app.fast_sleep.store(true, std::sync::atomic::Ordering::Relaxed);
		app
	}
}
