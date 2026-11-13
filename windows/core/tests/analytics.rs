//! Account stats against stand-ins for the platforms' analytics APIs.
mod common;
use common::*;
use publisher_core::analytics::report;
use publisher_core::db::Platform;
use publisher_core::App;
use serde_json::{json, Value};

fn table(headers: &[&str], rows: Value) -> Value {
	json!({ "columnHeaders": headers.iter().map(|h| json!({ "name": h })).collect::<Vec<_>>(), "rows": rows })
}

#[tokio::test]
async fn youtube_stats_come_from_the_analytics_reports() {
	let mock = Mock::start(|c, _| {
		let q = c.query.as_str();
		match c.path.as_str() {
			"/youtube/channels" => json(200, json!({ "items": [{ "statistics": { "subscriberCount": "1234" } }] })),
			"/yt-analytics/reports" if q.contains("dimensions=day") => json(
				200,
				table(
					&["day", "views", "likes", "comments", "shares", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"],
					json!([["2026-11-01", 100, 10, 2, 3, 250, 5, 1], ["2026-11-02", 50, 4, 1, 0, 90, 2, 0]]),
				),
			),
			"/yt-analytics/reports" if q.contains("dimensions=country") => json(200, table(&["country", "views"], json!([["US", 90], ["BR", 60]]))),
			"/yt-analytics/reports" if q.contains("dimensions=ageGroup") => {
				json(200, table(&["ageGroup", "gender", "viewerPercentage"], json!([["age18-24", "female", 30.0], ["age18-24", "male", 20.0], ["age25-34", "male", 50.0]])))
			}
			"/yt-analytics/reports" if q.contains("dimensions=video") => json(200, table(&["video", "views", "likes", "comments", "shares"], json!([["v1", 120, 12, 3, 2]]))),
			"/youtube/videos" => {
				json(200, json!({ "items": [{ "id": "v1", "snippet": { "title": "My best video", "publishedAt": "2026-11-01T10:00:00Z", "thumbnails": { "medium": { "url": "https://i.ytimg.com/vi/v1/mq.jpg" } } } }] }))
			}
			_ => json(404, json!({})),
		}
	})
	.await;
	let app = App::for_tests(mock.endpoints());
	let a = seed_account(&app, Platform::Youtube, false);
	let r = report(&app, 28, None, false).await;
	let s = &r["accounts"][0];
	assert_eq!((s["status"].clone(), s["accountId"].clone()), (json!("ok"), json!(a.id)), "{s}");
	assert_eq!(s["followers"], 1234.0);
	assert_eq!(s["totals"], json!({ "views": 150.0, "likes": 14.0, "comments": 3.0, "shares": 3.0, "watchMinutes": 340.0, "followersGained": 6.0 }));
	assert_eq!(s["daily"][0], json!({ "views": 100.0, "likes": 10.0, "comments": 2.0, "shares": 3.0, "watchMinutes": 250.0, "date": "2026-11-01" }));
	assert_eq!(s["countries"], json!([{ "code": "US", "value": 90.0, "share": 0.6 }, { "code": "BR", "value": 60.0, "share": 0.4 }]));
	assert_eq!(s["ages"], json!([{ "age": "18-24", "female": 30.0, "male": 20.0, "other": 0.0 }, { "age": "25-34", "female": 0.0, "male": 50.0, "other": 0.0 }]));
	assert_eq!((s["top"][0]["title"].clone(), s["top"][0]["views"].clone()), (json!("My best video"), json!(120)));
	// The channel's own reports, for exactly the chosen period.
	let daily = mock.calls().into_iter().find(|c| c.query.contains("dimensions=day")).unwrap();
	assert!(daily.query.contains("ids=channel%3D%3DMINE") && daily.query.contains("startDate=") && daily.query.contains("endDate="));

	// Cached for a few minutes: a second look asks nothing.
	let before = mock.calls().len();
	report(&app, 28, None, false).await;
	assert_eq!(mock.calls().len(), before);
	report(&app, 28, None, true).await;
	assert!(mock.calls().len() > before);
}

#[tokio::test]
async fn an_account_connected_before_stats_existed_is_asked_to_reconnect() {
	let mock = Mock::start(|c, _| match c.path.as_str() {
		"/youtube/channels" => json(200, json!({ "items": [{ "statistics": {} }] })),
		_ => json(403, json!({ "error": { "code": 403, "message": "Request had insufficient authentication scopes.", "errors": [{ "reason": "insufficientPermissions" }] } })),
	})
	.await;
	let app = App::for_tests(mock.endpoints());
	seed_account(&app, Platform::Youtube, false);
	let s = &report(&app, 7, None, false).await["accounts"][0];
	assert_eq!(s["status"], "reconnect");
	assert!(s["message"].as_str().unwrap().contains("Reconnect"));
	// Asking for stats never marks the account itself as broken.
	let status: String = app.db().query_row("SELECT status FROM accounts", [], |r| r.get(0)).unwrap();
	assert_eq!(status, "connected");
}

#[tokio::test]
async fn tiktok_stats_cover_recent_videos_and_say_what_tiktok_does_not_share() {
	let now = publisher_core::util::now_ms() / 1000;
	let mock = Mock::start(move |c, _| match c.path.as_str() {
		"/tiktok/v2/user/info/" => json(200, json!({ "data": { "user": { "follower_count": 500, "likes_count": 9000, "video_count": 3 } }, "error": { "code": "ok" } })),
		"/tiktok/v2/video/list/" => json(
			200,
			json!({ "data": { "videos": [
				{ "id": "a", "title": "New one", "view_count": 300, "like_count": 30, "comment_count": 3, "share_count": 1, "create_time": now - 3600, "share_url": "https://www.tiktok.com/@me/video/a" },
				{ "id": "b", "title": "Old one", "view_count": 9999, "like_count": 1, "comment_count": 0, "share_count": 0, "create_time": now - 400 * 86400 }
			], "has_more": false }, "error": { "code": "ok" } }),
		),
		_ => json(404, json!({})),
	})
	.await;
	let app = App::for_tests(mock.endpoints());
	seed_account(&app, Platform::Tiktok, false);
	let s = &report(&app, 28, None, false).await["accounts"][0];
	assert_eq!(s["status"], "ok", "{s}");
	assert_eq!(s["followers"], 500.0);
	// Only videos from this period count.
	assert_eq!(s["totals"], json!({ "allTimeLikes": 9000.0, "views": 300.0, "likes": 30.0, "comments": 3.0, "shares": 1.0 }));
	assert_eq!(s["top"].as_array().unwrap().len(), 1);
	assert_eq!(s["countries"], json!([]));
	assert!(s["notes"][0].as_str().unwrap().contains("does not give apps"));
}

#[tokio::test]
async fn demo_accounts_get_steady_made_up_numbers() {
	let app = App::for_tests(publisher_core::Endpoints::default());
	for p in [Platform::Youtube, Platform::Instagram, Platform::Tiktok] {
		seed_account(&app, p, true);
	}
	let a = report(&app, 28, None, false).await;
	let b = report(&app, 28, None, true).await;
	for i in 0..3 {
		let (x, y) = (&a["accounts"][i], &b["accounts"][i]);
		assert_eq!(x["status"], "ok");
		assert_eq!(x["totals"], y["totals"], "demo numbers are the same every time");
		assert!(x["notes"][0].as_str().unwrap().starts_with("Demo data"));
	}
	let yt = a["accounts"].as_array().unwrap().iter().find(|s| s["platform"] == "youtube").unwrap();
	assert_eq!(yt["daily"].as_array().unwrap().len(), 28);
	assert_eq!(yt["countries"].as_array().unwrap().len(), 10);
	let share: f64 = yt["countries"].as_array().unwrap().iter().map(|c| c["share"].as_f64().unwrap()).sum();
	assert!((share - 1.0).abs() < 1e-9);
	// One account only.
	let one = report(&app, 7, Some(yt["accountId"].as_str().unwrap()), false).await;
	assert_eq!(one["accounts"].as_array().unwrap().len(), 1);
	assert_eq!(one["accounts"][0]["daily"].as_array().unwrap().len(), 7);
}
