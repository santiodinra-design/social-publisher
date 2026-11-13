//! Runs claimed targets and decides what each result means (port of `server/runner.ts` and
//! `server/worker.ts`). The worker lives in the same process as the API, as background tasks.
use crate::accounts::{get_account, mark_account};
use crate::db::{self, MediaRow, TargetRow};
use crate::jobs::{self, add_event, finish, heartbeat, schedule_retry, unknown_outcome_message, Finish, Patch};
use crate::platforms::{self, Ctx, Outcome, PubError, Reconciled};
use crate::util::now_ms;
use crate::App;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

/// Stops a helper task when its owner finishes, including when the owner panics. Without this a
/// crashed job would keep renewing its lease and never be picked up again.
struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop {
	fn drop(&mut self) {
		self.0.abort();
	}
}

/** Per-platform caption override, else the shared caption. */
pub fn caption_for(shared: &str, settings: &Value) -> String {
	match settings["captionOverride"].as_str() {
		Some(o) if !o.trim().is_empty() => o.to_string(),
		_ => shared.to_string(),
	}
}

/** Runs one claimed target to its next stable state. */
pub async fn run_target(app: &Arc<App>, t: TargetRow, owner: &str) {
	let post: Option<(String, String, bool, i64)> =
		app.db().query_row("SELECT media_id, caption, is_demo, created_at FROM posts WHERE id = ?", [&t.post_id], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0, r.get(3)?))).optional().ok().flatten();
	let Some((media_id, caption, post_demo, post_created_at)) = post else {
		return finish(app, &t.id, "failed", Finish { error: Some("Post no longer exists"), ..Default::default() });
	};
	let media: Option<MediaRow> = db::get_media(app, &media_id, false);
	let Some(media) = media else {
		return finish(app, &t.id, "failed", Finish { error: Some("Video record no longer exists"), ..Default::default() });
	};
	let Some(account) = get_account(app, &t.account_id) else {
		return finish(app, &t.id, "failed", Finish { error: Some("Account no longer exists"), ..Default::default() });
	};
	if account.is_demo != post_demo {
		return finish(app, &t.id, "failed", Finish { error: Some("Demo and real posts cannot be mixed"), ..Default::default() });
	}

	// Keep the lease alive on its own timer, so a long upload is not mistaken for a dead worker.
	let _beat = {
		let (app, id, owner) = (app.clone(), t.id.clone(), owner.to_string());
		AbortOnDrop(tokio::spawn(async move {
			let mut tick = tokio::time::interval(Duration::from_secs(15));
			tick.tick().await;
			loop {
				tick.tick().await;
				heartbeat(&app, &id, &owner);
			}
		}))
	};

	let settings: Value = serde_json::from_str(&t.settings).unwrap_or(Value::Null);
	let mut ctx = Ctx { app: app.clone(), owner: owner.to_string(), caption: caption_for(&caption, &settings), settings, media, account, post_created_at, target: t };
	let mut reconciling = false;
	let result = attempt(&mut ctx, &mut reconciling).await;

	let id = ctx.target.id.clone();
	match result {
		Ok(outcome) => match outcome {
			Outcome::Published { permalink, remote_id, message } => {
				finish(app, &id, "published", Finish { permalink: permalink.as_deref(), remote_id: remote_id.as_deref(), ..Default::default() });
				add_event(app, &id, message.as_deref().unwrap_or("Confirmed published by the platform."));
			}
			Outcome::NeedsAttention { message } => {
				finish(app, &id, "needs_attention", Finish { error: Some(&message), ..Default::default() });
				add_event(app, &id, &message);
			}
		},
		Err(e) => {
			let msg = e.message().to_string();
			let cur = &ctx.target;
			// If the platform may already hold something from this attempt, the next attempt must check first.
			let may_exist = reconciling || cur.uncertain || cur.phase.as_deref() == Some("publishing") || cur.provider_ref.is_some() || cur.remote_id.is_some();
			match e {
				PubError::Transient { retry_after_ms, .. } => {
					if may_exist {
						ctx.save(Patch::new().uncertain(true));
					}
					let text = if reconciling { format!("Status check failed: {msg}") } else { msg };
					schedule_retry(app, &ctx.target, &text, retry_after_ms);
				}
				PubError::Auth(_) => {
					if may_exist {
						ctx.save(Patch::new().uncertain(true));
					}
					mark_account(app, &ctx.account.id, "reconnect_required", Some(&msg));
					finish(app, &id, "needs_attention", Finish { error: Some(&format!("Reconnect {} in Connected accounts, then use Check again. ({msg})", ctx.account.display_name)), ..Default::default() });
				}
				PubError::Attention(_) => finish(app, &id, "needs_attention", Finish { error: Some(&msg), ..Default::default() }),
				// The platform itself confirmed the failure, so a later retry may safely upload afresh.
				PubError::Rejected(_) => finish(app, &id, "failed", Finish { error: Some(&msg), clear_ref: true, ..Default::default() }),
				PubError::Permanent(_) | PubError::MissingMedia(_) => {
					// A refused status lookup is not proof the earlier upload failed.
					if may_exist {
						ctx.save(Patch::new().uncertain(true));
						let detail = if matches!(e, PubError::MissingMedia(_)) { "the local video was cleaned up, so the upload cannot be continued".to_string() } else { msg };
						finish(app, &id, "needs_attention", Finish { error: Some(&unknown_outcome_message(ctx.target.platform, &detail)), ..Default::default() });
					} else {
						finish(app, &id, "failed", Finish { error: Some(&msg), ..Default::default() });
					}
				}
				// Unknown errors are treated as uncertain: check with the platform before retrying.
				PubError::Unexpected(_) => {
					ctx.save(Patch::new().uncertain(true));
					schedule_retry(app, &ctx.target, &format!("Unexpected error: {msg}"), None);
				}
			}
		}
	}
	crate::notify::after_target(app, &ctx.target.post_id);
}

async fn attempt(ctx: &mut Ctx, reconciling: &mut bool) -> Result<Outcome, PubError> {
	if ctx.target.uncertain {
		// Establish what happened last time before doing anything that could post a second copy.
		*reconciling = true;
		let r = platforms::reconcile(ctx).await?;
		*reconciling = false;
		match r {
			Reconciled::Done(outcome) => return Ok(outcome),
			Reconciled::Restart => {
				ctx.save(Patch::new().clear_ref().clear_phase().clear_remote_id().progress(0.0).uncertain(false));
				ctx.log("The platform confirmed nothing was posted last time; starting the upload again.");
			}
			Reconciled::Resume => {
				ctx.save(Patch::new().uncertain(false));
				ctx.log("Resuming where the last attempt stopped.");
			}
		}
	}
	platforms::run(ctx).await
}

/** Claims and runs up to `max_parallel` due targets, waiting for them to finish. Used by tests. */
pub async fn tick(app: &Arc<App>, owner: &str, max_parallel: usize) -> usize {
	let mut running = Vec::new();
	for _ in 0..max_parallel {
		let Some(t) = jobs::claim_next(app, owner) else { break };
		running.push(run_target(app, t, owner));
	}
	let n = running.len();
	futures_util::future::join_all(running).await;
	n
}

/** Deletes uploaded video files once every destination is finished and the retention period has passed. */
pub fn cleanup_media(app: &App) -> usize {
	let cutoff = now_ms() - (app.cfg.media_retention_hours * 3_600_000.0) as i64;
	let db = app.db();
	let rows: Vec<(String, String)> = db
		.prepare(
			"SELECT m.id, m.path FROM media m WHERE m.deleted_at IS NULL AND m.created_at < ?
			AND NOT EXISTS (SELECT 1 FROM posts p JOIN targets t ON t.post_id = p.id WHERE p.media_id = m.id AND t.state IN ('queued','uploading','processing'))
			AND NOT EXISTS (SELECT 1 FROM targets t WHERE t.state IN ('queued','uploading','processing') AND instr(t.settings, m.id) > 0)",
		)
		.and_then(|mut st| st.query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?))).map(|r| r.flatten().collect()))
		.unwrap_or_default();
	for (id, path) in &rows {
		let _ = std::fs::remove_file(path);
		let _ = db.execute("UPDATE media SET deleted_at = ? WHERE id = ?", params![now_ms(), id]);
	}
	rows.len()
}

pub fn new_owner() -> String {
	let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "pc".into());
	format!("{host}:{}:{}", std::process::id(), crate::crypto::random_id(4))
}

/// The background publisher. Up to three destinations run at once; a slot is refilled as soon as it
/// frees up, and a new post wakes the loop immediately instead of waiting for the next poll.
pub async fn worker_loop(app: Arc<App>, owner: String) {
	const PARALLEL: usize = 3;
	let started_at = now_ms();
	app.log.line(&format!("[worker] started as {owner}"));

	// Heartbeat on its own timer so a long upload does not make the worker look stopped.
	{
		let (app, owner) = (app.clone(), owner.clone());
		tokio::spawn(async move {
			let mut tick = tokio::time::interval(Duration::from_secs(10));
			loop {
				tick.tick().await;
				db::worker_beat(&app, &owner, started_at);
			}
		});
	}

	let slots = Arc::new(Semaphore::new(PARALLEL));
	let mut last_cleanup = 0i64;
	loop {
		let permit = match slots.clone().acquire_owned().await {
			Ok(p) => p,
			Err(_) => return,
		};
		if now_ms() - last_cleanup > 10 * 60_000 {
			let removed = cleanup_media(&app);
			if removed > 0 {
				app.log.line(&format!("[worker] removed {removed} old video file(s)"));
			}
			last_cleanup = now_ms();
		}
		match jobs::claim_next(&app, &owner) {
			Some(t) => {
				let (app, owner) = (app.clone(), owner.clone());
				tokio::spawn(async move {
					let label = format!("{} {}", t.platform.as_str(), t.id);
					app.log.line(&format!("[worker] running {label}"));
					run_target(&app, t, &owner).await;
					drop(permit);
					// A finished job may have freed a slot for one that was waiting.
					app.wake.notify_one();
				});
			}
			None => {
				drop(permit);
				let _ = tokio::time::timeout(Duration::from_millis(1500), app.wake.notified()).await;
			}
		}
	}
}
