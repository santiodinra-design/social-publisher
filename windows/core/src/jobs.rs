//! The persistent job queue (port of `server/jobs.ts`). One `targets` row per destination, claimed
//! with a lease so work interrupted by a crash is found again and checked with the platform first.
use crate::crypto::{random_id, random_unit, redact};
use crate::db::{is_terminal, TargetRow, ACTIVE_STATES};
use crate::util::now_ms;
use crate::App;
use rusqlite::{named_params, params, params_from_iter, types::Value as Sql, OptionalExtension};
use serde_json::{json, Value};

pub const MAX_ATTEMPTS: i64 = 5;
pub const LEASE_MS: i64 = 60_000;

pub fn backoff_ms(attempt: i64, hint: Option<u64>) -> i64 {
	let base = (15_000f64 * 2f64.powi((attempt - 1).max(0) as i32)).min(15.0 * 60_000.0);
	let jittered = (base * (0.8 + random_unit() * 0.4)).round() as i64;
	jittered.max(hint.unwrap_or(0) as i64)
}

pub struct NewTarget {
	pub account_id: String,
	pub platform: String,
	pub settings: Value,
}

fn post_by_key(app: &App, key: &str) -> Option<String> {
	app.db().query_row("SELECT id FROM posts WHERE idempotency_key = ?", [key], |r| r.get(0)).optional().ok().flatten()
}

/// Creates a post once. Submitting the same idempotency key again returns the original post.
/// With `scheduled_at`, every destination waits in the queue until that time.
pub fn create_post(app: &App, idempotency_key: &str, media_id: &str, caption: &str, is_demo: bool, targets: &[NewTarget], scheduled_at: Option<i64>) -> Result<(String, bool), String> {
	if let Some(id) = post_by_key(app, idempotency_key) {
		return Ok((id, true));
	}
	let db = app.db();
	let id = random_id(10);
	let t = now_ms();
	let due = scheduled_at.unwrap_or(t);
	db.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
	let run = || -> rusqlite::Result<()> {
		db.execute(
			"INSERT INTO posts (id, idempotency_key, media_id, caption, is_demo, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			params![id, idempotency_key, media_id, caption, is_demo as i64, t, scheduled_at],
		)?;
		let mut ins = db.prepare_cached("INSERT INTO targets (id, post_id, account_id, platform, settings, state, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)")?;
		for tg in targets {
			ins.execute(params![random_id(10), id, tg.account_id, tg.platform, tg.settings.to_string(), due, t, t])?;
		}
		Ok(())
	};
	match run() {
		Ok(()) => {
			db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
			Ok((id, false))
		}
		Err(e) => {
			let _ = db.execute_batch("ROLLBACK");
			match post_by_key(app, idempotency_key) {
				Some(again) => Ok((again, true)),
				None => Err(e.to_string()),
			}
		}
	}
}

/// Takes the next due target. A target whose worker died mid-run (lease expired) is picked up again
/// and flagged uncertain, so the adapter checks with the platform before doing anything.
pub fn claim_next(app: &App, owner: &str) -> Option<TargetRow> {
	let db = app.db();
	let t = now_ms();
	db.execute_batch("BEGIN IMMEDIATE").ok()?;
	let row = db
		.prepare_cached(
			"SELECT * FROM targets WHERE
			(state = 'queued' AND next_run_at <= ?1 AND (lease_until IS NULL OR lease_until < ?1))
			OR (state IN ('uploading','processing') AND (lease_until IS NULL OR lease_until < ?1))
			ORDER BY next_run_at LIMIT 1",
		)
		.and_then(|mut st| st.query_row([t], TargetRow::from_row).optional());
	let row = match row {
		Ok(Some(r)) => r,
		_ => {
			let _ = db.execute_batch("COMMIT");
			return None;
		}
	};
	let recovered = row.state != "queued";
	let updated =
		db.execute("UPDATE targets SET lease_owner = ?, lease_until = ?, uncertain = CASE WHEN ? THEN 1 ELSE uncertain END, updated_at = ? WHERE id = ?", params![owner, t + LEASE_MS, recovered as i64, t, row.id]);
	if updated.is_err() {
		let _ = db.execute_batch("ROLLBACK");
		return None;
	}
	let _ = db.execute_batch("COMMIT");
	if recovered {
		add_event(app, &row.id, "Worker restarted during this step; checking with the platform before continuing.");
	}
	get_target(app, &row.id)
}

pub fn get_target(app: &App, id: &str) -> Option<TargetRow> {
	app.db().prepare_cached("SELECT * FROM targets WHERE id = ?").ok()?.query_row([id], TargetRow::from_row).optional().ok().flatten()
}

pub fn heartbeat(app: &App, id: &str, owner: &str) {
	let _ = app.db().execute("UPDATE targets SET lease_until = ? WHERE id = ? AND lease_owner = ?", params![now_ms() + LEASE_MS, id, owner]);
}

/// A partial update to a target. `None` leaves a column alone; `Some(None)` clears it.
#[derive(Default, Debug, Clone)]
pub struct Patch {
	pub state: Option<&'static str>,
	pub phase: Option<Option<String>>,
	pub progress: Option<f64>,
	pub provider_ref: Option<Option<Value>>,
	pub remote_id: Option<Option<String>>,
	pub uncertain: Option<bool>,
}

impl Patch {
	pub fn new() -> Self {
		Patch::default()
	}
	pub fn state(mut self, s: &'static str) -> Self {
		self.state = Some(s);
		self
	}
	pub fn phase(mut self, p: &str) -> Self {
		self.phase = Some(Some(p.to_string()));
		self
	}
	pub fn clear_phase(mut self) -> Self {
		self.phase = Some(None);
		self
	}
	pub fn progress(mut self, p: f64) -> Self {
		self.progress = Some(p);
		self
	}
	pub fn rf(mut self, r: Value) -> Self {
		self.provider_ref = Some(Some(r));
		self
	}
	pub fn clear_ref(mut self) -> Self {
		self.provider_ref = Some(None);
		self
	}
	pub fn remote_id(mut self, id: impl Into<String>) -> Self {
		self.remote_id = Some(Some(id.into()));
		self
	}
	pub fn clear_remote_id(mut self) -> Self {
		self.remote_id = Some(None);
		self
	}
	pub fn uncertain(mut self, u: bool) -> Self {
		self.uncertain = Some(u);
		self
	}
}

pub fn patch_target(app: &App, id: &str, p: &Patch) {
	let mut sets = vec!["updated_at = ?".to_string()];
	let mut vals: Vec<Sql> = vec![Sql::Integer(now_ms())];
	let text = |s: &Option<String>| s.clone().map(Sql::Text).unwrap_or(Sql::Null);
	if let Some(s) = p.state {
		sets.push("state = ?".into());
		vals.push(Sql::Text(s.to_string()));
	}
	if let Some(ph) = &p.phase {
		sets.push("phase = ?".into());
		vals.push(text(ph));
	}
	if let Some(pr) = p.progress {
		sets.push("progress = ?".into());
		vals.push(Sql::Real(if pr.is_nan() { 0.0 } else { pr.clamp(0.0, 1.0) }));
	}
	if let Some(r) = &p.provider_ref {
		sets.push("provider_ref = ?".into());
		// A falsy reference (null) clears the column, as in the original.
		vals.push(r.as_ref().filter(|v| !v.is_null()).map(|v| Sql::Text(v.to_string())).unwrap_or(Sql::Null));
	}
	if let Some(r) = &p.remote_id {
		sets.push("remote_id = ?".into());
		vals.push(text(r));
	}
	if let Some(u) = p.uncertain {
		sets.push("uncertain = ?".into());
		vals.push(Sql::Integer(u as i64));
	}
	vals.push(Sql::Text(id.to_string()));
	let _ = app.db().execute(&format!("UPDATE targets SET {} WHERE id = ?", sets.join(", ")), params_from_iter(vals));
}

pub fn add_event(app: &App, target_id: &str, message: &str) {
	let _ = app.db().prepare_cached("INSERT INTO events (target_id, at, message) VALUES (?, ?, ?)").and_then(|mut st| st.execute(params![target_id, now_ms(), redact(message)]));
}

#[derive(Default)]
pub struct Finish<'a> {
	pub permalink: Option<&'a str>,
	pub error: Option<&'a str>,
	pub remote_id: Option<&'a str>,
	pub clear_ref: bool,
}

/// Ends an attempt. The "outcome unknown" flag and provider references are kept unless the post is
/// confirmed published or `clear_ref` says the platform confirmed nothing was posted.
pub fn finish(app: &App, id: &str, state: &str, f: Finish) {
	let _ = app.db().execute(
		"UPDATE targets SET state = :state, permalink = COALESCE(:permalink, permalink), error = :error, remote_id = CASE WHEN :clear = 1 THEN NULL ELSE COALESCE(:rid, remote_id) END,
		provider_ref = CASE WHEN :clear = 1 THEN NULL ELSE provider_ref END, phase = CASE WHEN :clear = 1 THEN NULL ELSE phase END,
		lease_owner = NULL, lease_until = NULL, uncertain = CASE WHEN :state = 'published' OR :clear = 1 THEN 0 ELSE uncertain END,
		progress = CASE WHEN :state = 'published' THEN 1 ELSE progress END, updated_at = :t WHERE id = :id",
		named_params! { ":state": state, ":permalink": f.permalink, ":error": f.error.map(redact), ":rid": f.remote_id, ":clear": f.clear_ref as i64, ":t": now_ms(), ":id": id },
	);
}

/// Called when the app quits. Hands in-flight targets back to the queue, marked so the next start
/// checks with the platform before sending anything again.
pub fn release_leases(app: &App, owner: &str) -> usize {
	let db = app.db();
	let ids: Vec<String> =
		db.prepare(&format!("SELECT id FROM targets WHERE lease_owner = ? AND state IN {ACTIVE_STATES}")).and_then(|mut st| st.query_map([owner], |r| r.get(0)).map(|rows| rows.flatten().collect())).unwrap_or_default();
	for id in &ids {
		let _ = db.execute(
			"UPDATE targets SET state = 'queued', uncertain = CASE WHEN provider_ref IS NOT NULL OR remote_id IS NOT NULL OR phase IS NOT NULL THEN 1 ELSE uncertain END, lease_owner = NULL, lease_until = NULL, next_run_at = ?, updated_at = ? WHERE id = ?",
			params![now_ms(), now_ms(), id],
		);
		add_event(app, id, "Paused because the app quit. It will check with the platform and continue on the next start.");
	}
	ids.len()
}

/// At startup only one copy of the app runs, so any lease still on record belongs to a process that
/// is gone. Expiring those now means interrupted jobs resume at once instead of after the lease runs out.
pub fn expire_stale_leases(app: &App) -> usize {
	app.db().execute("UPDATE targets SET lease_until = 0 WHERE lease_owner IS NOT NULL AND lease_until IS NOT NULL", []).unwrap_or(0)
}

/** Where the owner should look when the app cannot tell whether a post went through. */
pub fn check_where(platform: &str) -> &'static str {
	match platform {
		"youtube" => "YouTube Studio → Content",
		"instagram" => "your Instagram profile (Reels tab)",
		"tiktok" => "your TikTok inbox notifications and profile",
		_ => "the platform",
	}
}

pub fn unknown_outcome_message(platform: crate::db::Platform, detail: &str) -> String {
	format!(
		"The app could not confirm whether this reached {}. Check {} before posting it again. \"Check again\" only asks the platform; it never uploads a second copy. ({detail})",
		platform.label(),
		check_where(platform.as_str())
	)
}

/** Schedules another attempt, or ends the target after MAX_ATTEMPTS. */
pub fn schedule_retry(app: &App, t: &TargetRow, message: &str, hint_ms: Option<u64>) -> bool {
	let attempts = t.attempts + 1;
	if attempts >= MAX_ATTEMPTS {
		// If the platform may already have the post, "failed" would be misleading and a blind retry unsafe.
		if t.uncertain {
			let msg = unknown_outcome_message(t.platform, &format!("{message}; stopped checking after {attempts} attempts"));
			finish(app, &t.id, "needs_attention", Finish { error: Some(&msg), ..Default::default() });
		} else {
			finish(app, &t.id, "failed", Finish { error: Some(&format!("{message} (gave up after {attempts} attempts)")), ..Default::default() });
		}
		return false;
	}
	let wait = backoff_ms(attempts, hint_ms);
	let _ = app.db().execute(
		"UPDATE targets SET state = 'queued', attempts = ?, next_run_at = ?, error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?",
		params![attempts, now_ms() + wait, redact(message), now_ms(), t.id],
	);
	add_event(app, &t.id, &format!("Temporary problem: {message}. Retrying in {} s.", (wait as f64 / 1000.0).round()));
	true
}

/** Re-queues only the failed (or attention-needed) destinations of a post. */
pub fn retry_targets(app: &App, post_id: &str, target_ids: Option<&[String]>) -> Vec<String> {
	let db = app.db();
	let rows: Vec<TargetRow> = db.prepare("SELECT * FROM targets WHERE post_id = ?").and_then(|mut st| st.query_map([post_id], TargetRow::from_row).map(|r| r.flatten().collect())).unwrap_or_default();
	let mut picked = Vec::new();
	for r in rows {
		if !(r.state == "failed" || r.state == "needs_attention") || target_ids.map(|ids| !ids.contains(&r.id)).unwrap_or(false) {
			continue;
		}
		// Keep provider_ref and mark uncertain so the adapter reconciles before posting again.
		let _ = db.execute(
			"UPDATE targets SET state = 'queued', attempts = 0, next_run_at = ?, error = NULL, uncertain = CASE WHEN uncertain = 1 OR provider_ref IS NOT NULL OR remote_id IS NOT NULL THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?",
			params![now_ms(), now_ms(), r.id],
		);
		add_event(app, &r.id, "Retry requested.");
		picked.push(r.id);
	}
	if !picked.is_empty() {
		crate::notify::reset(app, post_id);
	}
	picked
}

/// Destinations that are still only waiting for their scheduled time: never started, nothing sent.
const WAITING: &str = "state = 'queued' AND attempts = 0 AND uncertain = 0 AND provider_ref IS NULL AND remote_id IS NULL AND lease_owner IS NULL";

/// Moves a scheduled post to another time, or to now when `at` is `None`. Only destinations that
/// have not started are moved. Returns how many moved.
pub fn reschedule(app: &App, post_id: &str, at: Option<i64>) -> usize {
	let db = app.db();
	let when = at.unwrap_or_else(now_ms);
	let ids: Vec<String> = db.prepare(&format!("SELECT id FROM targets WHERE post_id = ? AND {WAITING}")).and_then(|mut st| st.query_map([post_id], |r| r.get(0)).map(|r| r.flatten().collect())).unwrap_or_default();
	for id in &ids {
		let _ = db.execute("UPDATE targets SET next_run_at = ?, updated_at = ? WHERE id = ?", params![when, now_ms(), id]);
		add_event(app, id, &if at.is_some() { "Schedule changed.".to_string() } else { "Publishing now instead of at the scheduled time.".to_string() });
	}
	if !ids.is_empty() {
		let _ = db.execute("UPDATE posts SET scheduled_at = ? WHERE id = ?", params![at, post_id]);
	}
	ids.len()
}

/// Cancels the destinations of a scheduled post that have not started. They end as failed with a
/// clear reason, so "Retry" can still post them later.
pub fn cancel_scheduled(app: &App, post_id: &str) -> usize {
	let db = app.db();
	let ids: Vec<String> = db
		.prepare(&format!("SELECT id FROM targets WHERE post_id = ? AND next_run_at > ? AND {WAITING}"))
		.and_then(|mut st| st.query_map(params![post_id, now_ms()], |r| r.get(0)).map(|r| r.flatten().collect()))
		.unwrap_or_default();
	for id in &ids {
		finish(app, id, "failed", Finish { error: Some("Cancelled before the scheduled time. Retry posts it now."), ..Default::default() });
		add_event(app, id, "Schedule cancelled.");
	}
	ids.len()
}

/// TikTok only takes videos into the creator's inbox, so the app never learns when the owner posts
/// it there. The owner can say so by hand, which turns the destination into "published".
pub fn can_mark_posted(t: &TargetRow) -> bool {
	t.platform == crate::db::Platform::Tiktok && t.state == "needs_attention"
}

/** A TikTok address, if one was given. Anything else is refused rather than stored. */
pub fn tiktok_link(raw: &str) -> Result<Option<String>, &'static str> {
	let raw = raw.trim();
	if raw.is_empty() {
		return Ok(None);
	}
	let ok = url::Url::parse(raw).ok().filter(|u| u.scheme() == "https").and_then(|u| u.host_str().map(|h| h == "tiktok.com" || h.ends_with(".tiktok.com"))).unwrap_or(false);
	if ok {
		Ok(Some(raw.to_string()))
	} else {
		Err("Paste the post's TikTok link (https://www.tiktok.com/…), or leave it empty.")
	}
}

pub fn mark_posted(app: &App, target_id: &str, permalink: Option<&str>) -> Result<String, &'static str> {
	let t = get_target(app, target_id).ok_or("Not found")?;
	if !can_mark_posted(&t) {
		return Err("Only TikTok drafts waiting in the inbox can be marked as posted.");
	}
	finish(app, &t.id, "published", Finish { permalink, ..Default::default() });
	let _ = app.db().execute("UPDATE targets SET error = NULL WHERE id = ?", [&t.id]);
	add_event(app, &t.id, "Marked as posted by hand in TikTok.");
	Ok(t.post_id)
}

pub fn active_jobs(app: &App) -> i64 {
	app.db().query_row(&format!("SELECT COUNT(*) FROM targets WHERE state IN {ACTIVE_STATES}"), [], |r| r.get(0)).unwrap_or(0)
}

pub fn post_view(app: &App, post_id: &str) -> Option<Value> {
	let db = app.db();
	struct P {
		caption: String,
		is_demo: bool,
		created_at: i64,
		filename: String,
		duration: Option<f64>,
		width: Option<i64>,
		height: Option<i64>,
		size: i64,
		deleted: bool,
		media_id: String,
		scheduled_at: Option<i64>,
	}
	let post = db
		.prepare_cached("SELECT p.caption, p.is_demo, p.created_at, m.filename, m.duration, m.width, m.height, m.size, m.deleted_at, m.id, p.scheduled_at FROM posts p JOIN media m ON m.id = p.media_id WHERE p.id = ?")
		.ok()?
		.query_row([post_id], |r| {
			Ok(P {
				caption: r.get(0)?,
				is_demo: r.get::<_, i64>(1)? != 0,
				created_at: r.get(2)?,
				filename: r.get(3)?,
				duration: r.get(4)?,
				width: r.get(5)?,
				height: r.get(6)?,
				size: r.get(7)?,
				deleted: r.get::<_, Option<i64>>(8)?.is_some(),
				media_id: r.get(9)?,
				scheduled_at: r.get(10)?,
			})
		})
		.optional()
		.ok()
		.flatten()?;

	struct T {
		row: TargetRow,
		name: String,
		handle: Option<String>,
		avatar: Option<String>,
		account_demo: bool,
		account_status: String,
	}
	let targets: Vec<T> = db
		.prepare_cached(
			"SELECT t.*, a.display_name, a.handle, a.avatar_url, a.is_demo AS account_demo, a.status AS account_status FROM targets t JOIN accounts a ON a.id = t.account_id WHERE t.post_id = ? ORDER BY t.platform",
		)
		.and_then(|mut st| {
			st.query_map([post_id], |r| {
				Ok(T {
					row: TargetRow::from_row(r)?,
					name: r.get("display_name")?,
					handle: r.get("handle")?,
					avatar: r.get("avatar_url")?,
					account_demo: r.get::<_, i64>("account_demo")? != 0,
					account_status: r.get("account_status")?,
				})
			})
			.map(|rows| rows.flatten().collect())
		})
		.unwrap_or_default();

	let mut events: Vec<(String, i64, String)> = Vec::new();
	if !targets.is_empty() {
		let marks = vec!["?"; targets.len()].join(",");
		let sql = format!("SELECT target_id, at, message FROM events WHERE target_id IN ({marks}) ORDER BY id DESC LIMIT 60");
		if let Ok(mut st) = db.prepare(&sql) {
			if let Ok(rows) = st.query_map(params_from_iter(targets.iter().map(|t| t.row.id.as_str())), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))) {
				events = rows.flatten().collect();
			}
		}
	}

	let done = targets.iter().all(|t| is_terminal(&t.row.state));
	let now = now_ms();
	let waiting = |r: &TargetRow| post.scheduled_at.is_some() && r.state == "queued" && r.attempts == 0 && !r.uncertain && r.provider_ref.is_none() && r.remote_id.is_none() && r.next_run_at > now;
	let scheduled = targets.iter().any(|t| waiting(&t.row));
	let target_views: Vec<Value> = targets
		.iter()
		.map(|t| {
			let r = &t.row;
			json!({
				"scheduled": waiting(r),
				"id": r.id,
				"platform": r.platform.as_str(),
				"account": { "name": t.name, "handle": t.handle, "avatarUrl": t.avatar, "isDemo": t.account_demo },
				"settings": serde_json::from_str::<Value>(&r.settings).unwrap_or_else(|_| json!({})),
				"state": r.state,
				"phase": r.phase,
				"progress": r.progress,
				"attempts": r.attempts,
				"outcomeUnknown": r.uncertain && r.state != "published",
				"accountStatus": t.account_status,
				"nextRunAt": if r.state == "queued" { Value::from(r.next_run_at) } else { Value::Null },
				"canMarkPosted": can_mark_posted(r),
				"accountId": r.account_id,
				"error": r.error,
				"permalink": if post.is_demo { None } else { r.permalink.clone() },
				"updatedAt": r.updated_at,
				"events": events.iter().filter(|e| e.0 == r.id).take(8).map(|e| json!({ "at": e.1, "message": e.2 })).collect::<Vec<_>>(),
			})
		})
		.collect();

	Some(json!({
		"id": post_id,
		"caption": post.caption,
		"isDemo": post.is_demo,
		"createdAt": post.created_at,
		"media": { "id": post.media_id, "filename": post.filename, "duration": post.duration, "width": post.width, "height": post.height, "size": post.size, "deleted": post.deleted },
		"scheduledAt": post.scheduled_at,
		"scheduled": scheduled,
		"targets": target_views,
		"done": done,
	}))
}

pub fn list_posts(app: &App, limit: i64) -> Value {
	let ids: Vec<String> = {
		let db = app.db();
		db.prepare_cached("SELECT id FROM posts ORDER BY created_at DESC LIMIT ?").and_then(|mut st| st.query_map([limit], |r| r.get(0)).map(|r| r.flatten().collect())).unwrap_or_default()
	};
	Value::from(ids.iter().filter_map(|id| post_view(app, id)).collect::<Vec<_>>())
}
