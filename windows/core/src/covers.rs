//! Cover images chosen per destination: a custom YouTube thumbnail, or an Instagram Reel cover.
//! They are kept next to the videos (rows in `media` with an image type) and named in the
//! destination's settings as `coverId`. TikTok's inbox upload takes no cover; the owner picks one
//! in TikTok when finishing the draft.
use crate::db::{self, MediaRow, Platform};
use crate::media::Issue;
use crate::util::now_ms;
use crate::{crypto, App};
use rusqlite::params;
use serde_json::{json, Value};

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
/// YouTube refuses thumbnails over 2 MB.
pub const YOUTUBE_MAX_BYTES: i64 = 2 * 1024 * 1024;

/** The image type, from the file's first bytes. Only JPEG and PNG are accepted. */
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
	if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
		Some("image/jpeg")
	} else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
		Some("image/png")
	} else {
		None
	}
}

/** Width and height from a PNG header or a JPEG frame header, when they can be read. */
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
	if bytes.len() >= 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
		let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
		let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
		return Some((w, h));
	}
	let mut i = 2;
	while i + 9 < bytes.len() {
		if bytes[i] != 0xFF {
			return None;
		}
		let marker = bytes[i + 1];
		let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
		// SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
		if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
			let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
			let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
			return Some((w, h));
		}
		i += 2 + len;
	}
	None
}

pub fn view(m: &MediaRow) -> Value {
	json!({ "id": m.id, "mime": m.mime, "size": m.size, "width": m.width, "height": m.height, "url": format!("/api/covers/{}", m.id) })
}

/** Saves an uploaded image. Returns its view, or a message for the owner. */
pub fn save(app: &App, bytes: &[u8]) -> Result<Value, &'static str> {
	if bytes.is_empty() {
		return Err("Choose an image.");
	}
	if bytes.len() > MAX_BYTES {
		return Err("Cover images can be up to 8 MB.");
	}
	let mime = sniff(bytes).ok_or("Use a JPEG or PNG image.")?;
	let ext = if mime == "image/png" { "png" } else { "jpg" };
	let id = format!("c{}", crypto::random_id(11));
	let path = app.media_dir().join(format!("cover-{id}.{ext}"));
	std::fs::create_dir_all(app.media_dir()).map_err(|_| "Could not save the image.")?;
	std::fs::write(&path, bytes).map_err(|_| "Could not save the image.")?;
	let (w, h) = dimensions(bytes).map(|(w, h)| (Some(w as i64), Some(h as i64))).unwrap_or((None, None));
	app.db()
		.execute(
			"INSERT INTO media (id, path, filename, mime, size, duration, width, height, video_codec, audio_codec, fps, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?)",
			params![id, path.to_string_lossy(), format!("cover.{ext}"), mime, bytes.len() as i64, w, h, now_ms()],
		)
		.map_err(|_| "Could not save the image.")?;
	get(app, &id).map(|m| view(&m)).ok_or("Could not save the image.")
}

/** A cover image that is still on this computer. */
pub fn get(app: &App, id: &str) -> Option<MediaRow> {
	db::get_media(app, id, true).filter(|m| m.mime.starts_with("image/") && std::path::Path::new(&m.path).exists())
}

/** The cover a destination asks for, if any. */
pub fn chosen(settings: &Value) -> Option<&str> {
	settings["coverId"].as_str().filter(|s| !s.is_empty())
}

/** Checks a destination's cover before the post is saved. */
pub fn issues(app: &App, p: Platform, settings: &Value) -> Vec<Issue> {
	let Some(id) = chosen(settings) else { return Vec::new() };
	let field = format!("{}.cover", p.as_str());
	let Some(m) = get(app, id) else { return vec![Issue::new(field, "The cover image is no longer available. Choose it again.")] };
	match p {
		Platform::Tiktok => vec![Issue::new(field, "TikTok sets the cover when you finish the draft in the TikTok app.")],
		Platform::Youtube if m.size > YOUTUBE_MAX_BYTES => vec![Issue::new(field, "YouTube thumbnails can be up to 2 MB.")],
		Platform::Instagram if m.mime != "image/jpeg" => vec![Issue::new(field, "Instagram covers must be JPEG images.")],
		_ => Vec::new(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reads_image_types_and_sizes() {
		let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
		png.extend_from_slice(&1280u32.to_be_bytes());
		png.extend_from_slice(&720u32.to_be_bytes());
		assert_eq!((sniff(&png), dimensions(&png)), (Some("image/png"), Some((1280, 720))));
		// SOI, an APP0 segment, then SOF0 with height 1920 and width 1080.
		let jpg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0x07, 0x80, 0x04, 0x38, 3, 0, 0, 0, 0, 0, 0, 0];
		assert_eq!((sniff(&jpg), dimensions(&jpg)), (Some("image/jpeg"), Some((1080, 1920))));
		assert_eq!(sniff(b"GIF89a"), None);
	}
}
