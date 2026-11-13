//! Upload requirements per platform and the checks made against them (port of `server/media.ts`).
use crate::db::{MediaRow, Platform, PLATFORMS};
use crate::probe::MediaInfo;
use serde_json::{json, Value};

pub const VIDEO_MIME: [&str; 3] = ["video/mp4", "video/quicktime", "video/webm"];

pub struct Limits {
	pub formats: &'static [&'static str],
	pub min_sec: f64,
	pub max_sec: f64,
	pub max_bytes: u64,
	pub codecs: &'static [&'static str],
	pub note: &'static str,
}

const GB: u64 = 1024 * 1024 * 1024;
const MB: u64 = 1024 * 1024;

/// From each platform's documentation (checked Nov 2026). They change; PROJECT.md lists the sources.
pub fn limits(p: Platform) -> Limits {
	match p {
		Platform::Tiktok => Limits { formats: &["mp4", "mov", "webm"], min_sec: 3.0, max_sec: 600.0, max_bytes: 4 * GB, codecs: &["h264", "hevc", "vp8", "vp9"], note: "MP4/MOV/WebM, up to 10 minutes and 4 GB." },
		Platform::Instagram => Limits { formats: &["mp4", "mov"], min_sec: 3.0, max_sec: 900.0, max_bytes: 300 * MB, codecs: &["h264", "hevc"], note: "Reels: MP4/MOV, H.264 or HEVC, 3 s to 15 min, up to 300 MB." },
		Platform::Youtube => {
			Limits { formats: &["mp4", "mov", "webm"], min_sec: 1.0, max_sec: 12.0 * 3600.0, max_bytes: 256 * GB, codecs: &["h264", "hevc", "vp8", "vp9", "av1"], note: "Most video formats; up to 12 hours." }
		}
	}
}

pub fn limits_json(p: Platform) -> Value {
	let l = limits(p);
	json!({ "formats": l.formats, "minSec": l.min_sec, "maxSec": l.max_sec, "maxBytes": l.max_bytes, "codecs": l.codecs, "note": l.note })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
	pub field: String,
	pub message: String,
}

impl Issue {
	pub fn new(field: impl Into<String>, message: impl Into<String>) -> Self {
		Issue { field: field.into(), message: message.into() }
	}
	pub fn json(&self) -> Value {
		json!({ "field": self.field, "message": self.message })
	}
}

pub fn info_of(m: &MediaRow) -> MediaInfo {
	MediaInfo { size: m.size.max(0) as u64, duration: m.duration, width: m.width, height: m.height, video_codec: m.video_codec.clone(), audio_codec: m.audio_codec.clone(), fps: m.fps, container: None }
}

fn ext_of(filename: &str) -> String {
	filename.rsplit('.').next().unwrap_or("").to_lowercase()
}

pub fn validate_media(platform: Platform, m: &MediaInfo, mime: &str, filename: &str) -> Vec<Issue> {
	let l = limits(platform);
	let name = platform.label();
	let mut out = Vec::new();
	let ext = ext_of(filename);
	let as_format = if ext == "m4v" { "mp4" } else { ext.as_str() };
	if !VIDEO_MIME.contains(&mime) && !l.formats.contains(&ext.as_str()) {
		out.push(Issue::new("media", "This file is not a supported video."));
	} else if !l.formats.contains(&as_format) {
		out.push(Issue::new("media", format!("{name} accepts {}.", l.formats.join(", ").to_uppercase())));
	}
	if m.size > l.max_bytes {
		out.push(Issue::new("media", format!("File is {}; {name} allows up to {}.", fmt_bytes(m.size), fmt_bytes(l.max_bytes))));
	}
	if let Some(d) = m.duration {
		if d < l.min_sec {
			out.push(Issue::new("media", format!("Video is {d:.1} s; {name} needs at least {} s.", l.min_sec)));
		}
		if d > l.max_sec {
			out.push(Issue::new("media", format!("Video is {}; {name} allows up to {}.", fmt_dur(d), fmt_dur(l.max_sec))));
		}
	}
	if let Some(c) = &m.video_codec {
		if !l.codecs.contains(&c.as_str()) {
			out.push(Issue::new("media", format!("{name} does not accept {} video. Re-export as H.264.", c.to_uppercase())));
		}
	}
	if m.video_codec.is_none() && m.duration.is_none() {
		out.push(Issue::new("media", "Could not read this video. Check that it plays and re-export it as MP4 (H.264)."));
	}
	out
}

/** Shorts are vertical or square and up to 3 minutes. */
pub fn is_shorts_shape(width: Option<i64>, height: Option<i64>, duration: Option<f64>) -> bool {
	matches!((width, height), (Some(w), Some(h)) if h >= w) && duration.unwrap_or(0.0) <= 180.0
}

pub fn fmt_bytes(b: u64) -> String {
	if b >= GB {
		format!("{:.1} GB", b as f64 / GB as f64)
	} else {
		format!("{} MB", (b as f64 / MB as f64).round())
	}
}

pub fn fmt_dur(s: f64) -> String {
	if s >= 3600.0 {
		format!("{:.1} h", s / 3600.0)
	} else if s >= 60.0 {
		format!("{} min {} s", (s / 60.0).floor(), (s % 60.0).round())
	} else {
		format!("{} s", s.round())
	}
}

/** What the browser sees for an uploaded video. */
pub fn media_view(m: &MediaRow) -> Value {
	let info = info_of(m);
	let issues: serde_json::Map<String, Value> =
		PLATFORMS.iter().map(|p| (p.as_str().to_string(), Value::from(validate_media(*p, &info, &m.mime, &m.filename).into_iter().map(|i| i.message).collect::<Vec<_>>()))).collect();
	json!({
		"id": m.id,
		"filename": m.filename,
		"size": m.size,
		"duration": m.duration,
		"width": m.width,
		"height": m.height,
		"videoCodec": m.video_codec,
		"audioCodec": m.audio_codec,
		"shortsShape": is_shorts_shape(m.width, m.height, m.duration),
		"issues": issues,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn info(size: u64, duration: f64, codec: &str) -> MediaInfo {
		MediaInfo { size, duration: Some(duration), width: Some(1080), height: Some(1920), video_codec: Some(codec.into()), audio_codec: Some("aac".into()), fps: Some(30.0), container: None }
	}

	#[test]
	fn accepts_a_normal_vertical_video_everywhere() {
		for p in PLATFORMS {
			assert_eq!(validate_media(p, &info(20 * MB, 30.0, "h264"), "video/mp4", "clip.mp4"), vec![], "{p:?}");
		}
	}

	#[test]
	fn applies_each_platforms_limits() {
		let big = validate_media(Platform::Instagram, &info(400 * MB, 30.0, "h264"), "video/mp4", "clip.mp4");
		assert_eq!(big[0].message, "File is 400 MB; Instagram allows up to 300 MB.");
		let short = validate_media(Platform::Tiktok, &info(MB, 1.5, "h264"), "video/mp4", "clip.mp4");
		assert_eq!(short[0].message, "Video is 1.5 s; TikTok needs at least 3 s.");
		let webm = validate_media(Platform::Instagram, &info(MB, 10.0, "vp9"), "video/webm", "clip.webm");
		assert!(webm.iter().any(|i| i.message == "Instagram accepts MP4, MOV."));
		assert!(webm.iter().any(|i| i.message.contains("does not accept VP9")));
		assert!(validate_media(Platform::Youtube, &info(MB, 10.0, "h264"), "video/mp4", "clip.m4v").is_empty());
		let long = validate_media(Platform::Tiktok, &info(MB, 700.0, "h264"), "video/mp4", "clip.mp4");
		assert_eq!(long[0].message, "Video is 11 min 40 s; TikTok allows up to 10 min 0 s.");
	}

	#[test]
	fn shorts_shape_is_vertical_or_square_up_to_three_minutes() {
		assert!(is_shorts_shape(Some(1080), Some(1920), Some(60.0)));
		assert!(is_shorts_shape(Some(1080), Some(1080), Some(180.0)));
		assert!(!is_shorts_shape(Some(1920), Some(1080), Some(60.0)));
		assert!(!is_shorts_shape(Some(1080), Some(1920), Some(181.0)));
		assert!(!is_shorts_shape(None, None, Some(10.0)));
	}
}
