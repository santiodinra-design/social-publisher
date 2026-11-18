//! Reads a video's duration, size and codecs straight from its container (MP4/MOV and WebM/Matroska).
//!
//! The Mac app runs a bundled `ffprobe` for this. Reading the header in-process is much faster (no
//! process start, only the index is read, never the video data) and removes a large bundled binary.
//! If a file is in a shape this reader does not understand and an `ffprobe` is available, that is
//! used as a fallback.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaInfo {
	pub size: u64,
	pub duration: Option<f64>,
	pub width: Option<i64>,
	pub height: Option<i64>,
	pub video_codec: Option<String>,
	pub audio_codec: Option<String>,
	pub fps: Option<f64>,
	pub container: Option<String>,
}

const MAX_INDEX_BYTES: u64 = 256 * 1024 * 1024;

pub fn probe(file: &Path, size: u64, ffprobe: Option<&Path>) -> MediaInfo {
	let mut info = native(file).unwrap_or_default();
	if info.video_codec.is_none() {
		if let Some(bin) = ffprobe {
			if let Some(f) = with_ffprobe(bin, file) {
				info = f;
			}
		}
	}
	info.size = size;
	info
}

fn native(file: &Path) -> Option<MediaInfo> {
	let mut f = File::open(file).ok()?;
	let len = f.metadata().ok()?.len();
	let mut head = [0u8; 12];
	f.read_exact(&mut head).ok()?;
	f.seek(SeekFrom::Start(0)).ok()?;
	if head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
		return matroska(&mut f, len);
	}
	if matches!(&head[4..8], b"ftyp" | b"moov" | b"mdat" | b"wide" | b"free" | b"skip" | b"pnot") {
		return isobmff(&mut f, len);
	}
	None
}

// ---------- MP4 / MOV ----------

fn be32(b: &[u8], at: usize) -> Option<u32> {
	Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn be64(b: &[u8], at: usize) -> Option<u64> {
	Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}
fn be16(b: &[u8], at: usize) -> Option<u16> {
	Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

/** Iterates the boxes inside `data`, yielding (type, payload). */
fn boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
	let mut out = Vec::new();
	let mut at = 0usize;
	while at + 8 <= data.len() {
		let Some(size32) = be32(data, at) else { break };
		let kind: [u8; 4] = data[at + 4..at + 8].try_into().unwrap();
		let (header, size) = match size32 {
			0 => (8usize, (data.len() - at) as u64),
			1 => match be64(data, at + 8) {
				Some(s) => (16usize, s),
				None => break,
			},
			s => (8usize, s as u64),
		};
		if size < header as u64 || at as u64 + size > data.len() as u64 {
			break;
		}
		out.push((kind, &data[at + header..at + size as usize]));
		at += size as usize;
	}
	out
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
	boxes(data).into_iter().find(|(k, _)| k == kind).map(|(_, d)| d)
}

/** (timescale, duration) from an mvhd or mdhd payload. */
fn header_times(d: &[u8]) -> Option<(u32, u64)> {
	match *d.first()? {
		1 => Some((be32(d, 20)?, be64(d, 24)?)),
		_ => Some((be32(d, 12)?, be32(d, 16)? as u64)),
	}
}

fn isobmff(f: &mut File, len: u64) -> Option<MediaInfo> {
	// Find the index ("moov") without reading the video data ("mdat"), wherever it sits in the file.
	let mut at = 0u64;
	let mut moov: Option<Vec<u8>> = None;
	while at + 8 <= len {
		f.seek(SeekFrom::Start(at)).ok()?;
		let mut h = [0u8; 16];
		f.read_exact(&mut h[..8]).ok()?;
		let mut size = be32(&h, 0)? as u64;
		let mut header = 8u64;
		if size == 1 {
			f.read_exact(&mut h[8..16]).ok()?;
			size = be64(&h, 8)?;
			header = 16;
		} else if size == 0 {
			size = len - at;
		}
		if size < header {
			break;
		}
		if &h[4..8] == b"moov" {
			let body = size - header;
			if body > MAX_INDEX_BYTES || at + size > len {
				return None;
			}
			let mut buf = vec![0u8; body as usize];
			f.read_exact(&mut buf).ok()?;
			moov = Some(buf);
			break;
		}
		at += size;
	}
	let moov = moov?;
	let mut info = MediaInfo { container: Some("mov,mp4,m4a,3gp,3g2,mj2".into()), ..Default::default() };

	let mut longest = 0f64;
	if let Some((scale, dur)) = child(&moov, b"mvhd").and_then(header_times) {
		if scale > 0 && dur > 0 && dur != u32::MAX as u64 && dur != u64::MAX {
			longest = dur as f64 / scale as f64;
		}
	}
	// Fragmented files keep the length in mvex/mehd.
	if longest == 0.0 {
		if let (Some(mehd), Some((scale, _))) = (child(&moov, b"mvex").and_then(|m| child(m, b"mehd")), child(&moov, b"mvhd").and_then(header_times)) {
			let dur = if mehd.first() == Some(&1) { be64(mehd, 4) } else { be32(mehd, 4).map(|v| v as u64) };
			if let (Some(d), true) = (dur, scale > 0) {
				longest = d as f64 / scale as f64;
			}
		}
	}

	for (kind, trak) in boxes(&moov) {
		if &kind != b"trak" {
			continue;
		}
		let Some(mdia) = child(trak, b"mdia") else { continue };
		let handler = child(mdia, b"hdlr").and_then(|h| h.get(8..12)).map(|h| h.to_vec());
		let times = child(mdia, b"mdhd").and_then(header_times);
		let track_secs = times.filter(|(s, _)| *s > 0).map(|(s, d)| d as f64 / s as f64).unwrap_or(0.0);
		let Some(stbl) = child(mdia, b"minf").and_then(|m| child(m, b"stbl")) else { continue };
		let Some(stsd) = child(stbl, b"stsd") else { continue };
		// stsd: version/flags (4), entry count (4), then the first sample entry: size (4), format (4).
		let Some(entry) = stsd.get(8..) else { continue };
		let Some(fourcc) = entry.get(4..8) else { continue };
		match handler.as_deref() {
			Some(b"vide") if info.video_codec.is_none() => {
				info.video_codec = Some(video_codec(fourcc));
				// Sample entry: 8 header, 6 reserved, 2 data ref, 16 pre-defined/reserved, then width and height.
				info.width = be16(entry, 32).map(|v| v as i64).filter(|v| *v > 0);
				info.height = be16(entry, 34).map(|v| v as i64).filter(|v| *v > 0);
				if let Some(stts) = child(stbl, b"stts") {
					let count = be32(stts, 4).unwrap_or(0) as usize;
					let mut samples = 0u64;
					for i in 0..count.min(1_000_000) {
						match be32(stts, 8 + i * 8) {
							Some(n) => samples += n as u64,
							None => break,
						}
					}
					if samples > 0 && track_secs > 0.0 {
						info.fps = Some((samples as f64 / track_secs * 100.0).round() / 100.0);
					}
				}
				if longest == 0.0 && track_secs > 0.0 {
					longest = track_secs;
				}
			}
			Some(b"soun") if info.audio_codec.is_none() => info.audio_codec = Some(audio_codec(fourcc)),
			_ => {}
		}
	}
	if longest > 0.0 {
		info.duration = Some(longest);
	}
	Some(info)
}

fn video_codec(fourcc: &[u8]) -> String {
	match fourcc {
		b"avc1" | b"avc2" | b"avc3" | b"avc4" => "h264".into(),
		b"hvc1" | b"hev1" | b"dvh1" | b"dvhe" => "hevc".into(),
		b"vp08" => "vp8".into(),
		b"vp09" => "vp9".into(),
		b"av01" => "av1".into(),
		b"mp4v" => "mpeg4".into(),
		b"apch" | b"apcn" | b"apcs" | b"apco" | b"ap4h" | b"ap4x" => "prores".into(),
		b"jpeg" | b"mjpa" | b"mjpb" => "mjpeg".into(),
		other => String::from_utf8_lossy(other).trim().to_lowercase(),
	}
}

fn audio_codec(fourcc: &[u8]) -> String {
	match fourcc {
		b"mp4a" => "aac".into(),
		b"Opus" => "opus".into(),
		b"ac-3" => "ac3".into(),
		b"ec-3" => "eac3".into(),
		b"fLaC" => "flac".into(),
		b".mp3" => "mp3".into(),
		b"sowt" | b"twos" | b"lpcm" | b"in24" | b"in32" | b"fl32" | b"fl64" => "pcm".into(),
		other => String::from_utf8_lossy(other).trim().to_lowercase(),
	}
}

// ---------- WebM / Matroska ----------

const EBML_UNKNOWN: u64 = u64::MAX;

/** Reads an element ID (marker bits kept). */
fn ebml_id(d: &[u8], at: &mut usize) -> Option<u32> {
	let first = *d.get(*at)?;
	let len = first.leading_zeros() as usize + 1;
	if len > 4 {
		return None;
	}
	let mut v = 0u32;
	for i in 0..len {
		v = (v << 8) | *d.get(*at + i)? as u32;
	}
	*at += len;
	Some(v)
}

/** Reads an element size (marker bit removed). All ones means "unknown size". */
fn ebml_size(d: &[u8], at: &mut usize) -> Option<u64> {
	let first = *d.get(*at)?;
	let len = first.leading_zeros() as usize + 1;
	if len > 8 {
		return None;
	}
	let mut v = (first as u64) & ((1u64 << (8 - len)) - 1);
	let mut all_ones = v == (1u64 << (8 - len)) - 1;
	for i in 1..len {
		let b = *d.get(*at + i)?;
		all_ones &= b == 0xFF;
		v = (v << 8) | b as u64;
	}
	*at += len;
	Some(if all_ones { EBML_UNKNOWN } else { v })
}

fn ebml_children(d: &[u8]) -> Vec<(u32, &[u8])> {
	let mut out = Vec::new();
	let mut at = 0usize;
	while at < d.len() {
		let Some(id) = ebml_id(d, &mut at) else { break };
		let Some(size) = ebml_size(d, &mut at) else { break };
		if size == EBML_UNKNOWN || at as u64 + size > d.len() as u64 {
			break;
		}
		out.push((id, &d[at..at + size as usize]));
		at += size as usize;
	}
	out
}

fn ebml_uint(d: &[u8]) -> u64 {
	d.iter().take(8).fold(0u64, |a, b| (a << 8) | *b as u64)
}

fn ebml_float(d: &[u8]) -> Option<f64> {
	match d.len() {
		4 => Some(f32::from_be_bytes(d.try_into().ok()?) as f64),
		8 => Some(f64::from_be_bytes(d.try_into().ok()?)),
		_ => None,
	}
}

fn matroska(f: &mut File, len: u64) -> Option<MediaInfo> {
	const SEGMENT: u32 = 0x1853_8067;
	const INFO: u32 = 0x1549_A966;
	const TRACKS: u32 = 0x1654_AE6B;
	const CLUSTER: u32 = 0x1F43_B675;

	let mut info = MediaInfo { container: Some("matroska,webm".into()), ..Default::default() };
	let mut at = 0u64;
	let mut seen_info = false;
	let mut seen_tracks = false;
	let mut in_segment = false;
	let mut scale = 1_000_000u64;
	let mut raw_duration: Option<f64> = None;

	while at < len && !(seen_info && seen_tracks) {
		f.seek(SeekFrom::Start(at)).ok()?;
		let mut head = [0u8; 12];
		let got = f.read(&mut head).ok()?;
		if got < 2 {
			break;
		}
		let mut p = 0usize;
		let id = ebml_id(&head[..got], &mut p)?;
		let size = ebml_size(&head[..got], &mut p)?;
		let body = at + p as u64;
		if id == SEGMENT {
			// Step inside the segment and walk its children.
			in_segment = true;
			at = body;
			continue;
		}
		if size == EBML_UNKNOWN {
			break;
		}
		if in_segment && (id == INFO || id == TRACKS) {
			if size > MAX_INDEX_BYTES || body + size > len {
				return None;
			}
			let mut buf = vec![0u8; size as usize];
			f.seek(SeekFrom::Start(body)).ok()?;
			f.read_exact(&mut buf).ok()?;
			if id == INFO {
				seen_info = true;
				for (cid, d) in ebml_children(&buf) {
					match cid {
						0x2AD7B1 => scale = ebml_uint(d).max(1),
						0x4489 => raw_duration = ebml_float(d),
						_ => {}
					}
				}
			} else {
				seen_tracks = true;
				for (cid, entry) in ebml_children(&buf) {
					if cid != 0xAE {
						continue;
					}
					let mut kind = 0u64;
					let mut codec = String::new();
					let mut frame_ns = 0u64;
					let (mut w, mut h) = (None, None);
					for (eid, d) in ebml_children(entry) {
						match eid {
							0x83 => kind = ebml_uint(d),
							0x86 => codec = String::from_utf8_lossy(d).trim_end_matches('\0').to_string(),
							0x23E383 => frame_ns = ebml_uint(d),
							0xE0 => {
								for (vid, vd) in ebml_children(d) {
									match vid {
										0xB0 => w = Some(ebml_uint(vd) as i64),
										0xBA => h = Some(ebml_uint(vd) as i64),
										_ => {}
									}
								}
							}
							_ => {}
						}
					}
					if kind == 1 && info.video_codec.is_none() {
						info.video_codec = Some(mkv_codec(&codec));
						info.width = w;
						info.height = h;
						if frame_ns > 0 {
							info.fps = Some((1e9 / frame_ns as f64 * 100.0).round() / 100.0);
						}
					} else if kind == 2 && info.audio_codec.is_none() {
						info.audio_codec = Some(mkv_codec(&codec));
					}
				}
			}
		} else if id == CLUSTER && in_segment {
			// Video data starts here. Files that put their track list after it are not supported.
			break;
		}
		at = body + size;
	}
	if let Some(d) = raw_duration {
		let secs = d * scale as f64 / 1e9;
		if secs > 0.0 {
			info.duration = Some(secs);
		}
	}
	Some(info)
}

fn mkv_codec(id: &str) -> String {
	match id {
		"V_VP8" => "vp8".into(),
		"V_VP9" => "vp9".into(),
		"V_AV1" => "av1".into(),
		"V_MPEG4/ISO/AVC" => "h264".into(),
		"V_MPEGH/ISO/HEVC" => "hevc".into(),
		"A_OPUS" => "opus".into(),
		"A_VORBIS" => "vorbis".into(),
		"A_FLAC" => "flac".into(),
		"A_AC3" => "ac3".into(),
		"A_EAC3" => "eac3".into(),
		"A_MPEG/L3" => "mp3".into(),
		s if s.starts_with("A_AAC") => "aac".into(),
		s if s.starts_with("A_PCM") => "pcm".into(),
		s => s.trim_start_matches("V_").trim_start_matches("A_").to_lowercase(),
	}
}

// ---------- optional ffprobe fallback ----------

fn with_ffprobe(bin: &Path, file: &Path) -> Option<MediaInfo> {
	let mut cmd = std::process::Command::new(bin);
	cmd.args(["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json"]).arg(file);
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
	}
	let out = cmd.output().ok()?;
	let j: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
	let streams = j.get("streams")?.as_array()?;
	let find = |kind: &str| streams.iter().find(|s| s["codec_type"] == kind);
	let v = find("video");
	let a = find("audio");
	let fps = v.and_then(|v| v["avg_frame_rate"].as_str()).and_then(|r| {
		let (n, d) = r.split_once('/')?;
		let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
		(d != 0.0).then(|| (n / d * 100.0).round() / 100.0)
	});
	Some(MediaInfo {
		size: 0,
		duration: j["format"]["duration"].as_str().and_then(|d| d.parse().ok()),
		width: v.and_then(|v| v["width"].as_i64()),
		height: v.and_then(|v| v["height"].as_i64()),
		video_codec: v.and_then(|v| v["codec_name"].as_str()).map(String::from),
		audio_codec: a.and_then(|a| a["codec_name"].as_str()).map(String::from),
		fps,
		container: j["format"]["format_name"].as_str().map(String::from),
	})
}

/// Builds tiny but structurally valid files, so the reader is tested without shipping videos.
#[doc(hidden)]
pub mod fixtures {
	fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
		let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
		v.extend_from_slice(kind);
		v.extend_from_slice(body);
		v
	}

	fn full(version: u8) -> Vec<u8> {
		vec![version, 0, 0, 0]
	}

	fn trak(handler: &[u8; 4], fourcc: &[u8; 4], timescale: u32, duration: u32, width: u16, height: u16, samples: u32) -> Vec<u8> {
		let mut mdhd = full(0);
		mdhd.extend_from_slice(&[0; 8]);
		mdhd.extend_from_slice(&timescale.to_be_bytes());
		mdhd.extend_from_slice(&duration.to_be_bytes());
		mdhd.extend_from_slice(&[0; 4]);
		let mut hdlr = full(0);
		hdlr.extend_from_slice(&[0; 4]);
		hdlr.extend_from_slice(handler);
		hdlr.extend_from_slice(&[0; 13]);
		let mut entry = vec![0u8; 6];
		entry.extend_from_slice(&1u16.to_be_bytes());
		if handler == b"vide" {
			entry.extend_from_slice(&[0; 16]);
			entry.extend_from_slice(&width.to_be_bytes());
			entry.extend_from_slice(&height.to_be_bytes());
			entry.extend_from_slice(&[0; 50]);
		} else {
			entry.extend_from_slice(&[0; 20]);
		}
		let mut stsd = full(0);
		stsd.extend_from_slice(&1u32.to_be_bytes());
		stsd.extend_from_slice(&bx(fourcc, &entry));
		let mut stts = full(0);
		stts.extend_from_slice(&1u32.to_be_bytes());
		stts.extend_from_slice(&samples.to_be_bytes());
		stts.extend_from_slice(&(duration / samples.max(1)).to_be_bytes());
		let stbl = [bx(b"stsd", &stsd), bx(b"stts", &stts)].concat();
		let minf = bx(b"stbl", &stbl);
		let mdia = [bx(b"mdhd", &mdhd), bx(b"hdlr", &hdlr), bx(b"minf", &minf)].concat();
		bx(b"trak", &bx(b"mdia", &mdia))
	}

	/// An MP4 with one video and one audio track. `moov_last` puts the index after the video data.
	pub fn mp4(video: &[u8; 4], width: u16, height: u16, seconds: u32, fps: u32, moov_last: bool) -> Vec<u8> {
		let mut mvhd = full(0);
		mvhd.extend_from_slice(&[0; 8]);
		mvhd.extend_from_slice(&1000u32.to_be_bytes());
		mvhd.extend_from_slice(&(seconds * 1000).to_be_bytes());
		mvhd.extend_from_slice(&[0; 80]);
		let moov = bx(b"moov", &[bx(b"mvhd", &mvhd), trak(b"vide", video, 30_000, seconds * 30_000, width, height, seconds * fps), trak(b"soun", b"mp4a", 48_000, seconds * 48_000, 0, 0, seconds * 47)].concat());
		let ftyp = bx(b"ftyp", b"isom\0\0\x02\0isomiso2mp41");
		let mdat = bx(b"mdat", &vec![0u8; 4096]);
		if moov_last {
			[ftyp, mdat, moov].concat()
		} else {
			[ftyp, moov, mdat].concat()
		}
	}

	fn el(id: &[u8], body: &[u8]) -> Vec<u8> {
		let mut v = id.to_vec();
		// 4-byte size field.
		v.extend_from_slice(&(0x1000_0000u32 | body.len() as u32).to_be_bytes());
		v.extend_from_slice(body);
		v
	}

	pub fn webm(codec: &str, width: u16, height: u16, seconds: f64) -> Vec<u8> {
		let info = el(&[0x15, 0x49, 0xA9, 0x66], &[el(&[0x2A, 0xD7, 0xB1], &1_000_000u32.to_be_bytes()), el(&[0x44, 0x89], &(seconds * 1000.0).to_be_bytes())].concat());
		let video = el(&[0xE0], &[el(&[0xB0], &width.to_be_bytes()), el(&[0xBA], &height.to_be_bytes())].concat());
		let v = el(&[0xAE], &[el(&[0x83], &[1]), el(&[0x86], codec.as_bytes()), el(&[0x23, 0xE3, 0x83], &33_333_333u32.to_be_bytes()), video].concat());
		let a = el(&[0xAE], &[el(&[0x83], &[2]), el(&[0x86], b"A_OPUS")].concat());
		let tracks = el(&[0x16, 0x54, 0xAE, 0x6B], &[v, a].concat());
		let cluster = el(&[0x1F, 0x43, 0xB6, 0x75], &[0u8; 64]);
		let header = el(&[0x1A, 0x45, 0xDF, 0xA3], &el(&[0x42, 0x82], b"webm"));
		[header, el(&[0x18, 0x53, 0x80, 0x67], &[info, tracks, cluster].concat())].concat()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn write(name: &str, bytes: &[u8]) -> std::path::PathBuf {
		let p = std::env::temp_dir().join(format!("sp-probe-{}-{name}", crate::crypto::random_id(6)));
		std::fs::write(&p, bytes).unwrap();
		p
	}

	#[test]
	fn reads_an_mp4_with_the_index_at_either_end() {
		for last in [false, true] {
			let p = write("a.mp4", &fixtures::mp4(b"avc1", 1080, 1920, 6, 30, last));
			let i = probe(&p, 123, None);
			assert_eq!(i.video_codec.as_deref(), Some("h264"));
			assert_eq!(i.audio_codec.as_deref(), Some("aac"));
			assert_eq!((i.width, i.height), (Some(1080), Some(1920)));
			assert_eq!(i.duration, Some(6.0));
			assert_eq!(i.fps, Some(30.0));
			assert_eq!(i.size, 123);
			let _ = std::fs::remove_file(p);
		}
	}

	#[test]
	fn maps_hevc_and_reads_webm() {
		let p = write("b.mov", &fixtures::mp4(b"hvc1", 1920, 1080, 12, 60, false));
		assert_eq!(probe(&p, 1, None).video_codec.as_deref(), Some("hevc"));
		let _ = std::fs::remove_file(p);

		let p = write("c.webm", &fixtures::webm("V_VP9", 1280, 720, 4.5));
		let i = probe(&p, 1, None);
		assert_eq!(i.video_codec.as_deref(), Some("vp9"));
		assert_eq!(i.audio_codec.as_deref(), Some("opus"));
		assert_eq!((i.width, i.height), (Some(1280), Some(720)));
		assert_eq!(i.duration, Some(4.5));
		assert_eq!(i.fps, Some(30.0));
		let _ = std::fs::remove_file(p);
	}

	#[test]
	fn a_file_that_is_not_a_video_has_no_video_codec() {
		let p = write("d.mp4", b"this is plainly not a video file at all");
		assert_eq!(probe(&p, 1, None).video_codec, None);
		let _ = std::fs::remove_file(p);
	}
}
