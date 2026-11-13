//! Cover images: a YouTube thumbnail that may be refused without failing the video, and an
//! Instagram cover hosted next to the video.
mod common;
use common::*;
use publisher_core::db::Platform;
use publisher_core::util::now_ms;
use publisher_core::{covers, App};
use serde_json::{json, Value};

/// A tiny but valid-looking JPEG header (SOI, APP0, SOF0 1280x720).
fn jpeg() -> Vec<u8> {
	let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0x02, 0xD0, 0x05, 0x00, 3];
	b.resize(4096, 0);
	b
}

#[tokio::test]
async fn a_refused_youtube_thumbnail_never_fails_the_video() {
	let mock = Mock::start(|c, _| match c.path.as_str() {
		"/youtube-upload/thumbnails/set" => {
			json(403, json!({ "error": { "code": 403, "message": "The authenticated user doesn't have permissions to upload and set custom video thumbnails.", "errors": [{ "reason": "forbidden" }] } }))
		}
		"/youtube/videos" => json(200, json!({ "items": [{ "status": { "uploadStatus": "processed" } }] })),
		_ => json(404, json!({})),
	})
	.await;
	let app = App::for_tests(mock.endpoints());
	let cover = covers::save(&app, &jpeg()).unwrap();
	assert_eq!((cover["mime"].clone(), cover["width"].clone(), cover["height"].clone()), (json!("image/jpeg"), json!(1280), json!(720)));
	let id = cover["id"].as_str().unwrap();
	let (_, t, _) = new_target(&app, Platform::Youtube, false, "x", json!({ "title": "T", "privacy": "private", "madeForKids": false, "coverId": id }));
	// The video is already uploaded; only the thumbnail and the status check are left.
	app.db().execute("UPDATE targets SET remote_id = 'vid1', phase = 'processing', state = 'processing' WHERE id = ?", [&t]).unwrap();

	let done = run_again(&app, &t).await;
	assert_eq!(done.state, "published", "{:?}", done.error);
	let call = mock.calls().into_iter().find(|c| c.path == "/youtube-upload/thumbnails/set").unwrap();
	assert!(call.query.contains("videoId=vid1"));
	assert_eq!(call.body, "<4096 bytes>");
	let events: Vec<String> = app.db().prepare("SELECT message FROM events WHERE target_id = ?").unwrap().query_map([&t], |r| r.get(0)).unwrap().flatten().collect();
	assert!(events.iter().any(|e| e.contains("did not accept the thumbnail")), "{events:?}");
	assert_eq!(rf(&app, &t)["thumbDone"], true);
}

#[tokio::test]
async fn covers_are_checked_per_platform() {
	let app = App::for_tests(publisher_core::Endpoints::default());
	assert!(covers::save(&app, b"GIF89a....").is_err());
	assert!(covers::save(&app, &vec![0xFF; covers::MAX_BYTES + 1]).is_err());
	let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
	png.resize(100, 0);
	let png_id = covers::save(&app, &png).unwrap()["id"].as_str().unwrap().to_string();
	let jpg_id = covers::save(&app, &jpeg()).unwrap()["id"].as_str().unwrap().to_string();
	let issues = |p: Platform, id: &str| covers::issues(&app, p, &json!({ "coverId": id })).len();
	assert_eq!(issues(Platform::Instagram, &png_id), 1); // Instagram takes JPEG only
	assert_eq!(issues(Platform::Instagram, &jpg_id), 0);
	assert_eq!(issues(Platform::Youtube, &png_id), 0);
	assert_eq!(issues(Platform::Tiktok, &jpg_id), 1); // TikTok picks its cover in the app
	assert_eq!(issues(Platform::Youtube, "missing"), 1);
	assert_eq!(covers::issues(&app, Platform::Youtube, &json!({})).len(), 0);
}

#[tokio::test]
async fn an_instagram_cover_is_hosted_beside_the_video_and_both_are_deleted() {
	let mock = Mock::start(|c, earlier| {
		let p = c.path.as_str();
		let created = earlier.iter().filter(|e| e.method == "POST" && e.path == "/relay/media").count();
		match (c.method.as_str(), p) {
			(_, "/ig/v25.0/instagram-1/content_publishing_limit") => json(200, json!({ "data": [] })),
			// The first upload is the video, the second the cover.
			("POST", "/relay/media") => json(200, json!({ "id": format!("{:032x}", created + 1), "uploadId": "u", "key": "k", "partSize": 8 * 1024 * 1024 })),
			("PUT", _) if p.contains("/parts/") => json(200, json!({ "partNumber": 1, "etag": "e" })),
			("POST", _) if p.ends_with("/complete") => {
				let id = p.split('/').nth(3).unwrap();
				json(200, json!({ "url": format!("https://relay.example.test/m/{id}?exp=1&sig=s"), "expiresAt": now_ms() + 3_600_000 }))
			}
			("DELETE", _) => json(200, json!({ "ok": true })),
			("POST", "/ig/v25.0/instagram-1/media") => json(200, json!({ "id": "C1" })),
			(_, "/ig/v25.0/C1") => json(200, json!({ "status_code": "FINISHED" })),
			("POST", "/ig/v25.0/instagram-1/media_publish") => json(200, json!({ "id": "M1" })),
			(_, "/ig/v25.0/M1") => json(200, json!({ "permalink": "https://www.instagram.com/reel/x/" })),
			_ => json(404, json!({})),
		}
	})
	.await;
	let app = App::for_tests_with(mock.endpoints_with_relay(), |c| c.public_base_url = None);
	let cover = covers::save(&app, &jpeg()).unwrap()["id"].as_str().unwrap().to_string();
	let (_, t, _) = new_target(&app, Platform::Instagram, false, "with cover", json!({ "coverId": cover }));
	let done = run_again(&app, &t).await;
	assert_eq!(done.state, "published", "{:?}", done.error);
	let calls = mock.calls();
	let container = calls.iter().find(|c| c.path == "/ig/v25.0/instagram-1/media").unwrap();
	assert!(container.body.contains(&format!("cover_url=https%3A%2F%2Frelay.example.test%2Fm%2F{:032x}", 2)), "{}", container.body);
	assert_eq!(calls.iter().filter(|c| c.method == "DELETE").count(), 2);
	let r: Value = rf(&app, &t);
	assert!(r.get("hostedCoverKey").is_none() && r.get("hostedKey").is_none(), "{r}");
}
