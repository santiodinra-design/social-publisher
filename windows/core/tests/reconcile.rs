//! Regression tests for the safety rule: an upload that may have succeeded, followed by status
//! checks that fail, must never start a second upload or publish. Ported from tests/reconcile.test.ts.
mod common;
use common::*;
use publisher_core::accounts::get_account;
use publisher_core::db::Platform;
use publisher_core::jobs;
use publisher_core::App;
use serde_json::json;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

const YT: fn() -> serde_json::Value = || json!({ "title": "T", "privacy": "private", "madeForKids": false });

fn uploads(m: &Mock) -> usize {
	m.count(|c| c.method == "PUT" && !c.is_status_query())
}
fn sessions(m: &Mock) -> usize {
	m.count(|c| c.query.contains("uploadType=resumable"))
}
fn processed() -> Reply {
	json(200, json!({ "items": [{ "status": { "uploadStatus": "processed" } }] }))
}

#[tokio::test]
async fn youtube_keeps_the_upload_session_and_never_starts_a_second_upload() {
	// 0 = lost, 1 = outage, 2 = sign-in refused, 3 = done
	let mode = Arc::new(AtomicU8::new(0));
	let m = {
		let mode = mode.clone();
		let base = Arc::new(std::sync::OnceLock::<String>::new());
		let b = base.clone();
		let mock = Mock::start(move |c, earlier| {
			if c.query.contains("uploadType=resumable") {
				return Reply { status: 200, headers: vec![("location", format!("{}/session/s1", b.get().unwrap()))], body: String::new() };
			}
			if c.path == "/session/s1" {
				if !c.is_status_query() {
					// YouTube received every byte, but its reply never arrives.
					return empty(502);
				}
				if earlier.iter().filter(|e| e.is_status_query()).count() == 0 {
					return empty(308);
				}
				return match mode.load(Ordering::SeqCst) {
					1 => json(503, json!({ "error": { "code": 503, "message": "backendError" } })),
					2 => json(401, json!({ "error": "invalid_grant" })),
					_ => json(200, json!({ "id": "vid1" })),
				};
			}
			if c.query.contains("part=status") {
				return processed();
			}
			empty(500)
		})
		.await;
		base.set(mock.base.clone()).unwrap();
		mock
	};
	let app = App::for_tests(m.endpoints());
	let (post, id, account) = new_target(&app, Platform::Youtube, false, "same caption", YT());

	let t = run_again(&app, &id).await;
	assert_eq!((t.state.as_str(), t.uncertain), ("queued", true));
	assert_eq!(rf(&app, &id)["sessionUrl"], format!("{}/session/s1", m.base));
	assert_eq!(rf(&app, &id)["finalSent"], true);

	mode.store(1, Ordering::SeqCst);
	let t = run_again(&app, &id).await;
	assert_eq!((t.state.as_str(), t.uncertain), ("queued", true));
	assert!(t.error.unwrap().starts_with("Status check failed"));
	assert_eq!(rf(&app, &id)["sessionUrl"], format!("{}/session/s1", m.base));

	mode.store(2, Ordering::SeqCst);
	let t = run_again(&app, &id).await;
	assert_eq!((t.state.as_str(), t.uncertain), ("needs_attention", true));
	assert_eq!(get_account(&app, &account).unwrap().status, "reconnect_required");
	assert_eq!(jobs::post_view(&app, &post).unwrap()["targets"][0]["outcomeUnknown"], true);
	assert_eq!((sessions(&m), uploads(&m)), (1, 1));

	// The owner reconnects and presses "Check again": the same session reports the finished video.
	app.db().execute("UPDATE accounts SET status = 'connected' WHERE id = ?", [&account]).unwrap();
	app.db().execute("UPDATE targets SET state = 'queued' WHERE id = ?", [&id]).unwrap();
	mode.store(3, Ordering::SeqCst);
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "published");
	assert_eq!(t.remote_id.as_deref(), Some("vid1"));
	assert_eq!(t.permalink.as_deref(), Some("https://www.youtube.com/shorts/vid1"));
	assert!(!t.uncertain);
	assert_eq!((sessions(&m), uploads(&m)), (1, 1));
}

#[tokio::test]
async fn youtube_a_refused_status_lookup_is_not_treated_as_a_failed_upload() {
	let m = Mock::start(|_, _| json(400, json!({ "error": { "code": 400, "message": "badRequest" } }))).await;
	let app = App::for_tests(m.endpoints());
	let (_, id, _) = new_target(&app, Platform::Youtube, false, "c", YT());
	set_ref(&app, &id, json!({ "sessionUrl": format!("{}/session/s2", m.base), "finalSent": true }), "upload");
	let t = run_again(&app, &id).await;
	assert_eq!((t.state.as_str(), t.uncertain), ("needs_attention", true));
	assert!(t.error.unwrap().contains("YouTube Studio"));
	assert!(m.calls().iter().all(|c| c.is_status_query()), "only status queries may be sent");
}

#[tokio::test]
async fn youtube_an_expired_session_after_the_last_part_needs_the_owner_not_a_new_upload() {
	let m = Mock::start(|_, _| empty(404)).await;
	let app = App::for_tests(m.endpoints());
	let (_, id, _) = new_target(&app, Platform::Youtube, false, "c", json!({ "title": "Holiday", "privacy": "private", "madeForKids": false }));
	set_ref(&app, &id, json!({ "sessionUrl": format!("{}/session/s3", m.base), "finalSent": true }), "upload");
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "needs_attention");
	assert!(t.error.unwrap().contains("Holiday"));
	assert_eq!(sessions(&m), 0);
}

#[tokio::test]
async fn youtube_an_expired_session_before_the_last_part_is_safe_to_restart() {
	let base = Arc::new(std::sync::OnceLock::<String>::new());
	let b = base.clone();
	let m = Mock::start(move |c, _| {
		if c.path == "/session/old" {
			return empty(404);
		}
		if c.query.contains("uploadType=resumable") {
			return Reply { status: 200, headers: vec![("location", format!("{}/session/new", b.get().unwrap()))], body: String::new() };
		}
		if c.path == "/session/new" {
			return if c.is_status_query() { empty(308) } else { json(200, json!({ "id": "v2" })) };
		}
		if c.query.contains("part=status") {
			return processed();
		}
		empty(500)
	})
	.await;
	base.set(m.base.clone()).unwrap();
	let app = App::for_tests(m.endpoints());
	let (_, id, _) = new_target(&app, Platform::Youtube, false, "c", YT());
	set_ref(&app, &id, json!({ "sessionUrl": format!("{}/session/old", m.base) }), "upload");

	// The session is gone and nothing was created: the reference is cleared and the job is retried.
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "queued");
	assert!(t.provider_ref.is_none());
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "published");
	assert_eq!(t.remote_id.as_deref(), Some("v2"));
	assert_eq!((sessions(&m), uploads(&m)), (1, 1));
}

#[tokio::test]
async fn youtube_a_video_youtube_rejected_may_be_uploaded_afresh() {
	let m = Mock::start(|c, _| {
		if c.query.contains("part=status") {
			return json(200, json!({ "items": [{ "status": { "uploadStatus": "rejected", "rejectionReason": "duplicate" } }] }));
		}
		empty(500)
	})
	.await;
	let app = App::for_tests(m.endpoints());
	let (_, id, _) = new_target(&app, Platform::Youtube, false, "c", YT());
	app.db().execute("UPDATE targets SET remote_id = 'vidGone', phase = 'processing', uncertain = 1, provider_ref = '{\"sessionUrl\":\"x\",\"finalSent\":true}' WHERE id = ?", [&id]).unwrap();
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "failed");
	assert!(t.error.unwrap().contains("duplicate"));
	// The platform confirmed the failure, so the references are cleared and a retry starts clean.
	assert!(t.provider_ref.is_none() && t.remote_id.is_none() && !t.uncertain);
}

#[tokio::test]
async fn instagram_a_lost_publish_reply_is_matched_to_exactly_one_reel_or_left_to_the_owner() {
	let recent = chrono_now();
	let listed = Arc::new(AtomicU8::new(1));
	let l = listed.clone();
	let m = Mock::start(move |c, _| {
		if c.path.ends_with("/container1") {
			return json(200, json!({ "status_code": "PUBLISHED" }));
		}
		if c.path.ends_with("/media") && c.method == "GET" {
			let reel = |id: &str| json!({ "id": id, "permalink": format!("https://www.instagram.com/reel/{id}/"), "timestamp": recent, "caption": "same caption", "media_product_type": "REELS" });
			let data: Vec<_> = (0..l.load(Ordering::SeqCst)).map(|i| reel(&format!("reel{i}"))).collect();
			return json(200, json!({ "data": data }));
		}
		empty(500)
	})
	.await;
	let app = App::for_tests(m.endpoints());

	let (_, id, _) = new_target(&app, Platform::Instagram, false, "same caption", json!({}));
	set_ref(&app, &id, json!({ "containerId": "container1", "publishAt": publisher_core::util::now_ms() }), "publishing");
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "published");
	assert_eq!(t.permalink.as_deref(), Some("https://www.instagram.com/reel/reel0/"));

	// Two recent Reels with the same caption: the app cannot tell which one it is.
	listed.store(2, Ordering::SeqCst);
	let (_, id, _) = new_target(&app, Platform::Instagram, false, "same caption", json!({}));
	set_ref(&app, &id, json!({ "containerId": "container1", "publishAt": publisher_core::util::now_ms() }), "publishing");
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "needs_attention");
	assert!(t.error.unwrap().contains("2 recent posts have the same caption"));

	// Published but not listed yet: check again later, never publish again.
	listed.store(0, Ordering::SeqCst);
	let (_, id, _) = new_target(&app, Platform::Instagram, false, "same caption", json!({}));
	set_ref(&app, &id, json!({ "containerId": "container1", "publishAt": publisher_core::util::now_ms() }), "publishing");
	let t = run_again(&app, &id).await;
	assert_eq!((t.state.as_str(), t.uncertain), ("queued", true));
	assert_eq!(m.count(|c| c.path.ends_with("/media_publish")), 0, "media_publish must not be called again");
	assert_eq!(m.count(|c| c.method == "POST"), 0);
}

#[tokio::test]
async fn instagram_a_failed_status_check_keeps_the_container() {
	let m = Mock::start(|_, _| json(500, json!({ "error": { "message": "temporarily unavailable" } }))).await;
	let app = App::for_tests(m.endpoints());
	let (_, id, _) = new_target(&app, Platform::Instagram, false, "c", json!({}));
	set_ref(&app, &id, json!({ "containerId": "container9" }), "publishing");
	let t = run_again(&app, &id).await;
	assert_eq!((t.state.as_str(), t.uncertain), ("queued", true));
	assert_eq!(rf(&app, &id)["containerId"], "container9");
	assert_eq!(m.count(|c| c.method == "POST"), 0);
}

#[tokio::test]
async fn tiktok_restarts_only_when_the_last_part_was_never_sent() {
	let m = Mock::start(|c, _| {
		if c.path.ends_with("/status/fetch/") {
			return json(200, json!({ "data": { "status": "PROCESSING_UPLOAD" }, "error": { "code": "ok" } }));
		}
		// Anything else would be a new upload.
		json(500, json!({ "error": { "code": "internal", "message": "unexpected" } }))
	})
	.await;
	let app = App::for_tests(m.endpoints());

	// Last part sent but not acknowledged: wait and check again; do not start over.
	let (_, id, _) = new_target(&app, Platform::Tiktok, false, "c", json!({}));
	set_ref(&app, &id, json!({ "publishId": "p1", "uploaded": false, "finalSent": true }), "upload");
	let t = run_again(&app, &id).await;
	assert_eq!((t.state.as_str(), t.uncertain), ("queued", true));
	assert_eq!(rf(&app, &id)["publishId"], "p1");
	assert_eq!(m.count(|c| c.path.contains("/init/")), 0);

	// The last part never went out, so that upload cannot complete: a new one is safe.
	let (_, id, _) = new_target(&app, Platform::Tiktok, false, "c", json!({}));
	set_ref(&app, &id, json!({ "publishId": "p2", "uploaded": false }), "upload");
	run_again(&app, &id).await;
	assert_eq!(m.count(|c| c.path.contains("/inbox/video/init/")), 1);
}

#[tokio::test]
async fn tiktok_inbox_delivery_is_reported_as_needing_the_owner_never_as_published() {
	let m = Mock::start(|c, _| {
		if c.path.ends_with("/status/fetch/") {
			return json(200, json!({ "data": { "status": "SEND_TO_USER_INBOX" }, "error": { "code": "ok" } }));
		}
		empty(500)
	})
	.await;
	let app = App::for_tests(m.endpoints());
	let (_, id, _) = new_target(&app, Platform::Tiktok, false, "c", json!({}));
	set_ref(&app, &id, json!({ "publishId": "p3", "uploaded": true }), "poll");
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "needs_attention");
	assert!(t.error.unwrap().contains("TikTok inbox"));
	assert!(t.permalink.is_none());
}

#[tokio::test]
async fn status_checks_work_after_the_local_video_was_cleaned_up() {
	let m = Mock::start(|c, _| if c.query.contains("part=status") { processed() } else { empty(500) }).await;
	let app = App::for_tests(m.endpoints());
	let (_, id, _) = new_target(&app, Platform::Youtube, false, "c", YT());
	let path: String = app.db().query_row("SELECT path FROM media", [], |r| r.get(0)).unwrap();
	std::fs::remove_file(path).unwrap();
	app.db().execute("UPDATE targets SET remote_id = 'vid7', phase = 'processing', uncertain = 1 WHERE id = ?", [&id]).unwrap();
	let t = run_again(&app, &id).await;
	assert_eq!(t.state, "published");
}

fn chrono_now() -> String {
	// Instagram's timestamp format, a few seconds in the future so it is after the publish call.
	let secs = publisher_core::util::now_ms() / 1000 + 5;
	let (d, s) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
	// Civil-from-days (Howard Hinnant's algorithm), to avoid a date dependency in tests.
	let z = d + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let day = doy - (153 * mp + 2) / 5 + 1;
	let month = if mp < 10 { mp + 3 } else { mp - 9 };
	let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
	format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}+0000", s / 3600, (s % 3600) / 60, s % 60)
}
