//! Finish notifications: when every destination of a post has reached its end state, tell the owner
//! once, with a Windows notification and the finish sound. A retry or a schedule change clears the
//! mark, so the post is announced again when it finishes the next time.
use crate::db::{is_terminal, Platform};
use crate::util::now_ms;
use crate::{settings, App, Notice};
use rusqlite::params;

/** Notifications are on unless the owner turned them off in the app. */
pub fn enabled(app: &App) -> bool {
	settings::get(app, "NOTIFY") != "off"
}

struct Row {
	platform: Platform,
	state: String,
	error: Option<String>,
}

/// Call after a destination of `post_id` reaches an end state. Announces the post if this was its
/// last open destination. Safe to call from several jobs at once: only one of them claims the post.
pub fn after_target(app: &App, post_id: &str) {
	let (rows, caption, filename, is_demo) = {
		let db = app.db();
		let rows: Vec<Row> = db
			.prepare_cached("SELECT platform, state, error FROM targets WHERE post_id = ? ORDER BY platform")
			.and_then(|mut st| st.query_map([post_id], |r| Ok(Row { platform: Platform::parse(&r.get::<_, String>(0)?).unwrap_or(Platform::Youtube), state: r.get(1)?, error: r.get(2)? })).map(|r| r.flatten().collect()))
			.unwrap_or_default();
		if rows.is_empty() || !rows.iter().all(|r| is_terminal(&r.state)) {
			return;
		}
		// Claim the announcement. A second job finishing at the same moment finds it already taken.
		let claimed = db.execute("UPDATE posts SET notified_at = ? WHERE id = ? AND notified_at IS NULL", params![now_ms(), post_id]).unwrap_or(0);
		if claimed == 0 {
			return;
		}
		let (caption, filename, is_demo): (String, String, bool) =
			match db.query_row("SELECT p.caption, m.filename, p.is_demo FROM posts p JOIN media m ON m.id = p.media_id WHERE p.id = ?", [post_id], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0))) {
				Ok(v) => v,
				Err(_) => return,
			};
		(rows, caption, filename, is_demo)
	};
	if !enabled(app) {
		return;
	}
	// TikTok drafts cannot carry a caption, so the finish notice hands it over for the clipboard.
	let own: String = app
		.db()
		.query_row("SELECT settings FROM targets WHERE post_id = ? AND platform = 'tiktok' LIMIT 1", [post_id], |r| r.get::<_, Option<String>>(0))
		.ok()
		.flatten()
		.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
		.map(|v| crate::util::js_str(&v["captionOverride"]).trim().to_string())
		.unwrap_or_default();
	let tiktok_caption = if own.is_empty() { caption.trim().to_string() } else { own };
	let notice = summarize(post_id, &rows, &caption, &filename, is_demo, &tiktok_caption);
	app.log.line(&format!("[notify] {} ({})", notice.title, if notice.ok { "ok" } else { "problem" }));
	if let Some(shell) = app.shell.get() {
		shell.notify(&notice);
	}
}

/** Forgets that a post was announced, so it is announced again when it next finishes. */
pub fn reset(app: &App, post_id: &str) {
	let _ = app.db().execute("UPDATE posts SET notified_at = NULL WHERE id = ?", [post_id]);
}

fn names(list: &[&Row]) -> String {
	let mut labels: Vec<&str> = list.iter().map(|r| r.platform.label()).collect();
	labels.dedup();
	match labels.len() {
		0 => String::new(),
		1 => labels[0].to_string(),
		n => format!("{} and {}", labels[..n - 1].join(", "), labels[n - 1]),
	}
}

fn short(text: &str, max: usize) -> String {
	let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
	if line.chars().count() <= max {
		line.to_string()
	} else {
		format!("{}…", line.chars().take(max - 1).collect::<String>().trim_end())
	}
}

fn summarize(post_id: &str, rows: &[Row], caption: &str, filename: &str, is_demo: bool, tiktok_caption: &str) -> Notice {
	let what = if caption.trim().is_empty() { filename.to_string() } else { short(caption, 80) };
	let inbox = |r: &Row| r.platform == Platform::Tiktok && r.state == "needs_attention" && r.error.as_deref().map(|e| e.contains("TikTok inbox")).unwrap_or(false);
	let published: Vec<&Row> = rows.iter().filter(|r| r.state == "published").collect();
	let drafts: Vec<&Row> = rows.iter().filter(|r| inbox(r)).collect();
	let problems: Vec<&Row> = rows.iter().filter(|r| r.state == "failed" || (r.state == "needs_attention" && !inbox(r))).collect();
	let notice = |title: String, body: String, ok: bool| Notice { post_id: post_id.to_string(), title, body, ok, copy: None };

	if is_demo {
		return notice("Simulation finished".into(), format!("Nothing was posted. {what}"), problems.is_empty());
	}
	if !problems.is_empty() {
		let first = problems[0].error.as_deref().map(|e| short(e, 140)).unwrap_or_default();
		let done = if published.is_empty() { String::new() } else { format!("Published to {}. ", names(&published)) };
		return notice(format!("Couldn't finish {}", names(&problems)), format!("{done}{first}"), false);
	}
	if !drafts.is_empty() {
		let done = if published.is_empty() { String::new() } else { format!("Published to {}. ", names(&published)) };
		if tiktok_caption.is_empty() {
			return notice("Sent to your TikTok inbox".into(), format!("{done}Open TikTok to finish posting: {what}"), true);
		}
		let mut n = notice("Sent to your TikTok inbox".into(), format!("{done}Caption copied. Open the TikTok draft and paste it."), true);
		n.copy = Some(tiktok_caption.chars().take(5000).collect());
		return n;
	}
	notice(format!("Published to {}", names(&published)), what, true)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn row(p: Platform, state: &str, error: Option<&str>) -> Row {
		Row { platform: p, state: state.into(), error: error.map(String::from) }
	}

	#[test]
	fn says_what_happened_in_one_line() {
		let all = [row(Platform::Instagram, "published", None), row(Platform::Youtube, "published", None)];
		assert_eq!(summarize("p", &all, "Summer trip\nmore", "a.mp4", false, ""), Notice { post_id: "p".into(), title: "Published to Instagram and YouTube".into(), body: "Summer trip".into(), ok: true, copy: None });

		let inbox = [row(Platform::Tiktok, "needs_attention", Some("Sent to your TikTok inbox. Open TikTok…")), row(Platform::Youtube, "published", None)];
		let n = summarize("p", &inbox, "", "clip.mp4", false, "");
		assert_eq!((n.title.as_str(), n.ok), ("Sent to your TikTok inbox", true));
		assert_eq!(n.body, "Published to YouTube. Open TikTok to finish posting: clip.mp4");
		// With a caption, the draft notice hands it over for the clipboard.
		let n = summarize("p", &inbox, "Hi #tag", "clip.mp4", false, "Hi #tag");
		assert_eq!((n.body.as_str(), n.copy.as_deref()), ("Published to YouTube. Caption copied. Open the TikTok draft and paste it.", Some("Hi #tag")));

		let bad = [row(Platform::Instagram, "failed", Some("Instagram could not process the video: bad codec")), row(Platform::Youtube, "published", None)];
		let n = summarize("p", &bad, "x", "a.mp4", false, "x");
		assert_eq!((n.title.as_str(), n.ok), ("Couldn't finish Instagram", false));
		assert!(n.body.starts_with("Published to YouTube. Instagram could not process"));

		let demo = summarize("p", &all, "hi", "a.mp4", true, "hi");
		assert_eq!((demo.title.as_str(), demo.body.as_str()), ("Simulation finished", "Nothing was posted. hi"));
		assert_eq!(short(&"word ".repeat(40), 20).chars().count(), 20);
	}
}
