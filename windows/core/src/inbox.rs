//! Inbox folder (port of `server/inbox.ts`): the owner's Claude sessions (or the owner) drop a finished
//! video plus a small JSON file here, and Publisher sends it: YouTube with the chosen visibility
//! (Public unless the JSON says otherwise) and TikTok to the inbox, where the owner adds the caption
//! and posts. Instagram is never used from the inbox.
//!
//! A drop goes through the same import and publish code as the window, so every normal check applies.
use crate::accounts::list_accounts;
use crate::util::{js_str, now_ms};
use crate::App;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const VIDEO_EXT: [&str; 4] = ["mp4", "m4v", "mov", "webm"];
const SENT: &str = "Sent";
const FAILED: &str = "Needs attention";

static RUNNING: AtomicBool = AtomicBool::new(false);
static RECENT: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/** `%USERPROFILE%\Videos\Publisher Inbox`, or `INBOX_DIR` when set (tests, a second copy). */
pub fn dir(app: &App) -> PathBuf {
	if let Some(d) = std::env::var_os("INBOX_DIR").filter(|d| !d.is_empty()) {
		return PathBuf::from(d);
	}
	match std::env::var_os("USERPROFILE").filter(|d| !d.is_empty()) {
		Some(home) => PathBuf::from(home).join("Videos").join("Publisher Inbox"),
		None => app.cfg.data_dir.join("Publisher Inbox"),
	}
}

pub fn status(app: &App) -> Value {
	json!({ "enabled": RUNNING.load(Ordering::Relaxed), "dir": dir(app).to_string_lossy(), "recent": RECENT.lock().iter().take(20).cloned().collect::<Vec<_>>() })
}

fn note(name: &str, status: &str, message: &str, post_id: Option<&str>) {
	let mut r = RECENT.lock();
	r.retain(|e| !(e["name"] == name && e["status"] == "working"));
	let mut e = json!({ "name": name, "at": now_ms(), "status": status, "message": message });
	if let Some(id) = post_id {
		e["postId"] = Value::from(id);
	}
	r.insert(0, e);
	r.truncate(50);
}

fn bare(s: &str) -> String {
	s.trim().to_lowercase().trim_start_matches('@').to_string()
}

/** Which connected accounts a drop goes to. Only YouTube and TikTok: both have drafts. */
pub fn pick_accounts(app: &App, drop: &Value) -> Result<Vec<Value>, String> {
	let live: Vec<Value> = list_accounts(app)
		.as_array()
		.cloned()
		.unwrap_or_default()
		.into_iter()
		.filter(|a| a["status"] == "connected" && a["isDemo"] != true && matches!(a["platform"].as_str(), Some("youtube" | "tiktok")))
		.collect();
	if let Some(g) = drop["group"].as_str().filter(|g| !g.is_empty()) {
		let groups = crate::groups::list(app);
		let all = groups.as_array().cloned().unwrap_or_default();
		let Some(found) = all.iter().find(|x| x["name"].as_str().map(|n| n.trim().to_lowercase()) == Some(g.trim().to_lowercase())) else {
			let names: Vec<String> = all.iter().map(|x| js_str(&x["name"])).collect();
			return Err(format!("There is no group called \"{g}\" in Publisher. Groups: {}.", if names.is_empty() { "none yet".into() } else { names.join(", ") }));
		};
		let ids: Vec<&Value> = found["accountIds"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
		return Ok(live.into_iter().filter(|a| ids.contains(&&a["id"])).collect());
	}
	// A name that is blank or not text matches no account, so it is reported instead of meaning "all".
	let wanted: Vec<String> = drop["accounts"].as_array().into_iter().flatten().map(|v| v.as_str().map(bare).unwrap_or_default()).collect();
	if wanted.is_empty() {
		return Ok(live);
	}
	let is = |a: &Value, w: &str| js_str(&a["displayName"]).to_lowercase() == w || bare(&js_str(&a["handle"])) == w;
	let missing: Vec<String> = wanted.iter().filter(|w| !live.iter().any(|a| is(a, w))).map(|w| format!("\"{w}\"")).collect();
	if !missing.is_empty() {
		return Err(format!("No connected YouTube or TikTok account called {}.", missing.join(", ")));
	}
	Ok(live.into_iter().filter(|a| wanted.iter().any(|w| is(a, w))).collect())
}

fn youtube_privacy(drop: &Value) -> &'static str {
	match drop["privacy"].as_str() {
		Some("unlisted") => "unlisted",
		Some("private") => "private",
		_ => "public",
	}
}

fn settings_for(platform: &str, drop: &Value, filename: &str) -> Value {
	let caption = js_str(&drop["caption"]).trim().to_string();
	if platform == "tiktok" {
		return json!({ "captionOverride": "", "mode": "inbox", "privacy": "SELF_ONLY", "allowComments": true, "allowDuet": false, "allowStitch": false });
	}
	let stem = filename.rsplit_once('.').map(|(s, _)| s).unwrap_or(filename).replace(['_', '-'], " ");
	let title = [js_str(&drop["title"]).trim().to_string(), caption.lines().next().unwrap_or("").trim().to_string(), stem].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
	let description = if drop["description"].is_string() { js_str(&drop["description"]) } else { caption };
	json!({
		"title": title.chars().take(100).collect::<String>(),
		"description": description.chars().take(5000).collect::<String>(),
		"privacy": youtube_privacy(drop),
		"madeForKids": drop["madeForKids"].as_bool().unwrap_or(false),
		"categoryId": drop["categoryId"].as_str().unwrap_or("20"),
	})
}

async fn body_json(res: axum::response::Response) -> (u16, Value) {
	let status = res.status().as_u16();
	let bytes = axum::body::to_bytes(res.into_body(), 4 * 1024 * 1024).await.unwrap_or_default();
	(status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/** Sends one drop. Returns the new post's ID and where it went. */
pub async fn send_drop(app: &Arc<App>, video: &Path, drop: &Value) -> Result<(String, Vec<String>), String> {
	let filename = video.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
	let accounts = pick_accounts(app, drop)?;
	if accounts.is_empty() {
		return Err("No connected YouTube or TikTok account to send it to.".into());
	}
	let (_, up) = body_json(crate::server::import_picked(app, video.to_path_buf()).await).await;
	if let Some(e) = up["error"].as_str() {
		return Err(format!("Upload failed: {e}"));
	}
	let media_id = js_str(&up["media"]["id"]);
	if media_id.is_empty() {
		return Err("Upload failed.".into());
	}
	let body = json!({
		"idempotencyKey": format!("inbox-{media_id}"),
		"mediaId": media_id,
		"caption": js_str(&drop["caption"]).trim(),
		"targets": accounts.iter().map(|a| json!({ "accountId": a["id"], "settings": settings_for(a["platform"].as_str().unwrap_or(""), drop, &filename) })).collect::<Vec<_>>(),
	});
	let (code, res) = body_json(crate::server::create_post(app, &body).await).await;
	if code != 200 {
		let mut parts: Vec<String> = res["error"].as_str().map(|e| vec![e.to_string()]).unwrap_or_default();
		parts.extend(res["issues"].as_array().into_iter().flatten().map(|i| js_str(&i["message"])));
		return Err(parts.join(" "));
	}
	let to = accounts
		.iter()
		.map(|a| if a["platform"] == "youtube" { format!("{} (YouTube, {})", js_str(&a["displayName"]), youtube_privacy(drop)) } else { format!("{} (TikTok inbox)", js_str(&a["displayName"])) })
		.collect();
	Ok((js_str(&res["post"]["id"]), to))
}

const README: &str = "Publisher inbox
===============

Put a finished video here and Publisher sends it:
  - YouTube: posted with the visibility in the JSON (\"privacy\"), Public if left out.
  - TikTok: sent to your TikTok inbox. Publisher copies the caption to the clipboard:
    open the draft in TikTok, paste it, add a sound, post.
  - Instagram: never from this folder.

How to drop a video
-------------------
1. Copy the video in first, for example  my-story.mp4  (MP4, MOV, M4V or WebM).
2. THEN write a JSON file with the same name:  my-story.json
   Publisher starts only when the JSON file is there, so always write it last.

my-story.json
{
  \"title\": \"YouTube title (100 characters max)\",
  \"caption\": \"Caption with #hashtags. Used for TikTok and as the YouTube description.\",
  \"description\": \"Optional: a different YouTube description\",
  \"group\": \"Optional: a saved group name in Publisher, for example Roblox\",
  \"accounts\": [\"Optional: account names or handles, for example Voltsys or @voltsysan\"],
  \"privacy\": \"public\",
  \"madeForKids\": false
}

Leave out \"group\" and \"accounts\" to send to every connected YouTube and TikTok account.
Never send the same video to two accounts on the same platform: YouTube and TikTok push reused videos down.

After sending, both files move to \"Sent\" with a .result.json next to them.
If something is wrong they move to \"Needs attention\" with a .error.txt that says why.
Publisher must be open for this to work (it can stay in the notification area).
";

/** Moves the files into `dir\sub`. False when any could not be moved (it is still in the inbox). */
fn move_to(dir: &Path, sub: &str, files: &[&Path]) -> (PathBuf, bool) {
	let to = dir.join(sub);
	let mut all = std::fs::create_dir_all(&to).is_ok();
	for f in files.iter().filter(|f| f.exists()) {
		let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
		let mut dest = to.join(&name);
		if dest.exists() {
			dest = to.join(format!("{}-{name}", now_ms()));
		}
		all &= std::fs::rename(f, dest).is_ok();
	}
	(to, all)
}

/// Looks at the folder once. A drop is taken once its JSON exists and the video's size stayed the
/// same since the previous look (so a video still being copied is left alone).
pub async fn scan(app: &Arc<App>, sizes: &mut HashMap<String, u64>, busy: &mut HashSet<String>) {
	let dir = dir(app);
	let Ok(entries) = std::fs::read_dir(&dir) else { return };
	let names: Vec<String> = entries.flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
	for j in names.iter().filter(|n| n.to_lowercase().ends_with(".json") && !n.to_lowercase().ends_with(".result.json")) {
		let base = &j[..j.len() - 5];
		let Some(vid) = names.iter().find(|n| *n != j && n.rsplit_once('.').map(|(b, e)| b == base && VIDEO_EXT.contains(&e.to_lowercase().as_str())).unwrap_or(false)) else { continue };
		if busy.contains(base) {
			continue;
		}
		let (video, json_file) = (dir.join(vid), dir.join(j));
		let size = std::fs::metadata(&video).map(|m| m.len()).unwrap_or(0);
		if sizes.get(base) != Some(&size) {
			sizes.insert(base.to_string(), size); // still copying, or first sight: check again next round
			continue;
		}
		busy.insert(base.to_string());
		note(vid, "working", "Sending as drafts…", None);
		let result = match std::fs::read_to_string(&json_file).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("{j} is not valid JSON: {e}"))) {
			Ok(drop) if drop.is_object() => send_drop(app, &video, &drop).await,
			Ok(_) => Err(format!("{j} must hold a JSON object.")),
			Err(e) => Err(e),
		};
		let moved = match result {
			Ok((post_id, to)) => {
				let (dest, moved) = move_to(&dir, SENT, &[&video, &json_file]);
				let receipt = json!({ "sentAt": chrono::Utc::now().to_rfc3339(), "postId": post_id, "to": to });
				let _ = std::fs::write(dest.join(format!("{base}.result.json")), serde_json::to_string_pretty(&receipt).unwrap_or_default());
				note(vid, "sent", &format!("Sent as drafts to {}", to.join(", ")), Some(&post_id));
				app.log.line(&format!("[inbox] sent {vid}"));
				moved
			}
			Err(msg) => {
				let (dest, moved) = move_to(&dir, FAILED, &[&video, &json_file]);
				let _ = std::fs::write(dest.join(format!("{base}.error.txt")), format!("{msg}\n\nFix it and put both files back in the inbox folder.\n"));
				note(vid, "failed", &msg, None);
				app.log.line(&format!("[inbox] {vid} needs attention"));
				moved
			}
		};
		if !moved {
			// The files are still here (a file in use, a locked folder). Keep this drop marked as handled
			// until Publisher restarts, so it can never be sent a second time.
			note(vid, "failed", "Handled, but its files could not be moved out of the inbox. Move them by hand.", None);
			app.log.line(&format!("[inbox] could not move {vid}; it will not be sent again"));
			continue;
		}
		sizes.remove(base);
		busy.remove(base);
	}
}

/** Creates the folder and its README, then looks at it every few seconds while the app runs. */
pub fn start(app: Arc<App>) {
	let dir = dir(&app);
	let _ = std::fs::create_dir_all(&dir);
	let readme = dir.join("README.txt");
	if std::fs::read_to_string(&readme).ok().as_deref() != Some(README) {
		let _ = std::fs::write(&readme, README);
	}
	RUNNING.store(true, Ordering::Relaxed);
	app.log.line(&format!("[inbox] watching {}", dir.display()));
	tokio::spawn(async move {
		let (mut sizes, mut busy) = (HashMap::new(), HashSet::new());
		loop {
			tokio::time::sleep(Duration::from_secs(4)).await;
			scan(&app, &mut sizes, &mut busy).await;
		}
	});
}
