//! SQLite store. Same schema as `server/db.ts`, so data folders are interchangeable.
use crate::util::now_ms;
use crate::App;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
	Tiktok,
	Instagram,
	Youtube,
}

pub const PLATFORMS: [Platform; 3] = [Platform::Tiktok, Platform::Instagram, Platform::Youtube];

impl Platform {
	pub fn as_str(self) -> &'static str {
		match self {
			Platform::Tiktok => "tiktok",
			Platform::Instagram => "instagram",
			Platform::Youtube => "youtube",
		}
	}
	pub fn parse(s: &str) -> Option<Platform> {
		match s {
			"tiktok" => Some(Platform::Tiktok),
			"instagram" => Some(Platform::Instagram),
			"youtube" => Some(Platform::Youtube),
			_ => None,
		}
	}
	pub fn label(self) -> &'static str {
		match self {
			Platform::Tiktok => "TikTok",
			Platform::Instagram => "Instagram",
			Platform::Youtube => "YouTube",
		}
	}
}

pub const ACTIVE_STATES: &str = "('queued','uploading','processing')";
pub fn is_terminal(state: &str) -> bool {
	matches!(state, "published" | "failed" | "needs_attention")
}

pub fn open(file: Option<&Path>) -> rusqlite::Result<Connection> {
	let c = match file {
		Some(p) => {
			if let Some(dir) = p.parent() {
				let _ = std::fs::create_dir_all(dir);
			}
			Connection::open(p)?
		}
		None => Connection::open_in_memory()?,
	};
	// Durability stays at SQLite's default (FULL): checkpoints such as "the last part is about to be
	// sent" must survive a power cut, or a restart could upload a second copy.
	c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")?;
	c.set_prepared_statement_cache_capacity(96);
	migrate(&c)?;
	Ok(c)
}

fn migrate(c: &Connection) -> rusqlite::Result<()> {
	c.execute_batch(
		r#"
	CREATE TABLE IF NOT EXISTS accounts (
		id TEXT PRIMARY KEY,
		platform TEXT NOT NULL,
		external_id TEXT NOT NULL,
		display_name TEXT NOT NULL,
		handle TEXT,
		avatar_url TEXT,
		is_demo INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'connected',
		status_detail TEXT,
		access_token TEXT,
		refresh_token TEXT,
		access_expires_at INTEGER,
		refresh_expires_at INTEGER,
		scopes TEXT,
		meta TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE(platform, external_id, is_demo)
	);
	CREATE TABLE IF NOT EXISTS media (
		id TEXT PRIMARY KEY,
		path TEXT NOT NULL,
		filename TEXT NOT NULL,
		mime TEXT NOT NULL,
		size INTEGER NOT NULL,
		duration REAL,
		width INTEGER,
		height INTEGER,
		video_codec TEXT,
		audio_codec TEXT,
		fps REAL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	CREATE TABLE IF NOT EXISTS posts (
		id TEXT PRIMARY KEY,
		idempotency_key TEXT NOT NULL UNIQUE,
		media_id TEXT NOT NULL REFERENCES media(id),
		caption TEXT NOT NULL DEFAULT '',
		is_demo INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS targets (
		id TEXT PRIMARY KEY,
		post_id TEXT NOT NULL REFERENCES posts(id),
		account_id TEXT NOT NULL REFERENCES accounts(id),
		platform TEXT NOT NULL,
		settings TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'queued',
		phase TEXT,
		progress REAL NOT NULL DEFAULT 0,
		provider_ref TEXT,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_run_at INTEGER NOT NULL,
		lease_owner TEXT,
		lease_until INTEGER,
		uncertain INTEGER NOT NULL DEFAULT 0,
		error TEXT,
		permalink TEXT,
		remote_id TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS targets_due ON targets(state, next_run_at);
	CREATE TABLE IF NOT EXISTS app_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		target_id TEXT NOT NULL,
		at INTEGER NOT NULL,
		message TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS worker_status (
		owner TEXT PRIMARY KEY,
		started_at INTEGER NOT NULL,
		beat_at INTEGER NOT NULL
	);
	"#,
	)?;
	// Added by the Windows app. Optional columns, so the Mac app can still open the same database.
	add_column(c, "posts", "scheduled_at", "INTEGER")?;
	add_column(c, "posts", "notified_at", "INTEGER")?;
	Ok(())
}

fn add_column(c: &Connection, table: &str, column: &str, kind: &str) -> rusqlite::Result<()> {
	let exists = c.prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?"))?.exists([column])?;
	if !exists {
		c.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"))?;
	}
	Ok(())
}

#[derive(Debug, Clone)]
pub struct AccountRow {
	pub id: String,
	pub platform: Platform,
	pub external_id: String,
	pub display_name: String,
	pub handle: Option<String>,
	pub avatar_url: Option<String>,
	pub is_demo: bool,
	pub status: String,
	pub status_detail: Option<String>,
	pub access_token: Option<String>,
	pub refresh_token: Option<String>,
	pub access_expires_at: Option<i64>,
	pub refresh_expires_at: Option<i64>,
	/// JSON with platform details, and `"via": "relay"` for accounts connected through the sign-in relay.
	pub meta: Option<String>,
	pub created_at: i64,
	pub updated_at: i64,
}

impl AccountRow {
	pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
		let platform: String = r.get("platform")?;
		Ok(AccountRow {
			id: r.get("id")?,
			platform: Platform::parse(&platform).unwrap_or(Platform::Youtube),
			external_id: r.get("external_id")?,
			display_name: r.get("display_name")?,
			handle: r.get("handle")?,
			avatar_url: r.get("avatar_url")?,
			is_demo: r.get::<_, i64>("is_demo")? != 0,
			status: r.get("status")?,
			status_detail: r.get("status_detail")?,
			access_token: r.get("access_token")?,
			refresh_token: r.get("refresh_token")?,
			access_expires_at: r.get("access_expires_at")?,
			refresh_expires_at: r.get("refresh_expires_at")?,
			meta: r.get("meta")?,
			created_at: r.get("created_at")?,
			updated_at: r.get("updated_at")?,
		})
	}
}

#[derive(Debug, Clone)]
pub struct MediaRow {
	pub id: String,
	pub path: String,
	pub filename: String,
	pub mime: String,
	pub size: i64,
	pub duration: Option<f64>,
	pub width: Option<i64>,
	pub height: Option<i64>,
	pub video_codec: Option<String>,
	pub audio_codec: Option<String>,
	pub fps: Option<f64>,
	pub created_at: i64,
}

impl MediaRow {
	pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
		Ok(MediaRow {
			id: r.get("id")?,
			path: r.get("path")?,
			filename: r.get("filename")?,
			mime: r.get("mime")?,
			size: r.get("size")?,
			duration: r.get("duration")?,
			width: r.get("width")?,
			height: r.get("height")?,
			video_codec: r.get("video_codec")?,
			audio_codec: r.get("audio_codec")?,
			fps: r.get("fps")?,
			created_at: r.get("created_at")?,
		})
	}
}

#[derive(Debug, Clone)]
pub struct TargetRow {
	pub id: String,
	pub post_id: String,
	pub account_id: String,
	pub platform: Platform,
	pub settings: String,
	pub state: String,
	pub phase: Option<String>,
	pub progress: f64,
	pub provider_ref: Option<String>,
	pub attempts: i64,
	pub next_run_at: i64,
	pub uncertain: bool,
	pub error: Option<String>,
	pub permalink: Option<String>,
	pub remote_id: Option<String>,
	pub created_at: i64,
	pub updated_at: i64,
}

impl TargetRow {
	pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
		let platform: String = r.get("platform")?;
		Ok(TargetRow {
			id: r.get("id")?,
			post_id: r.get("post_id")?,
			account_id: r.get("account_id")?,
			platform: Platform::parse(&platform).unwrap_or(Platform::Youtube),
			settings: r.get("settings")?,
			state: r.get("state")?,
			phase: r.get("phase")?,
			progress: r.get("progress")?,
			provider_ref: r.get("provider_ref")?,
			attempts: r.get("attempts")?,
			next_run_at: r.get("next_run_at")?,
			uncertain: r.get::<_, i64>("uncertain")? != 0,
			error: r.get("error")?,
			permalink: r.get("permalink")?,
			remote_id: r.get("remote_id")?,
			created_at: r.get("created_at")?,
			updated_at: r.get("updated_at")?,
		})
	}
}

pub fn get_media(app: &App, id: &str, live_only: bool) -> Option<MediaRow> {
	let sql = if live_only { "SELECT * FROM media WHERE id = ? AND deleted_at IS NULL" } else { "SELECT * FROM media WHERE id = ?" };
	app.db().prepare_cached(sql).ok()?.query_row([id], MediaRow::from_row).optional().ok().flatten()
}

/** The worker records a heartbeat here; the API only reads it. */
pub fn worker_beat(app: &App, owner: &str, started_at: i64) {
	let db = app.db();
	let _ = db.execute("INSERT INTO worker_status (owner, started_at, beat_at) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET beat_at = excluded.beat_at", params![owner, started_at, now_ms()]);
	let _ = db.execute("DELETE FROM worker_status WHERE beat_at < ?", [now_ms() - 86_400_000]);
}

pub const WORKER_STALE_MS: i64 = 45_000;

pub fn worker_status(app: &App) -> serde_json::Value {
	let row: Option<(i64, i64)> = app.db().query_row("SELECT started_at, beat_at FROM worker_status ORDER BY beat_at DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
	match row {
		None => serde_json::json!({ "state": "never", "lastSeenAt": null, "startedAt": null }),
		Some((started, beat)) => serde_json::json!({ "state": if now_ms() - beat < WORKER_STALE_MS { "running" } else { "stale" }, "lastSeenAt": beat, "startedAt": started }),
	}
}
