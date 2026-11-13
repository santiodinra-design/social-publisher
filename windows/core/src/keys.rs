//! Encryption keys for the desktop app, protected by Windows DPAPI for the signed-in Windows user
//! (the equivalent of the macOS Keychain item the Mac app uses). Also the one-time import of an
//! older project folder. Port of `desktop/keys.ts`.
use crate::crypto::{b64, b64_decode, open};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Keys {
	pub session_secret: String,
	pub token_key: String,
}

pub fn token_key_bytes(b64_key: &str) -> Option<[u8; 32]> {
	b64_decode(b64_key)?.try_into().ok()
}

#[cfg(windows)]
mod dpapi {
	use windows_sys::Win32::Foundation::LocalFree;
	use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

	const UI_FORBIDDEN: u32 = 0x1; // CRYPTPROTECT_UI_FORBIDDEN

	fn run(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
		let in_blob = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
		let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
		// SAFETY: both blobs are valid for the call; the output buffer is allocated by Windows and
		// released with LocalFree after it has been copied.
		let ok = unsafe {
			if protect {
				CryptProtectData(&in_blob, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), UI_FORBIDDEN, &mut out)
			} else {
				CryptUnprotectData(&in_blob, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), UI_FORBIDDEN, &mut out)
			}
		};
		if ok == 0 || out.pbData.is_null() {
			return Err(format!("Windows error {}", std::io::Error::last_os_error()));
		}
		let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
		unsafe { LocalFree(out.pbData as _) };
		Ok(bytes)
	}

	pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
		run(plain, true)
	}
	pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
		run(sealed, false)
	}
}

#[cfg(not(windows))]
mod dpapi {
	pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
		Err("Key protection is only implemented for Windows in this build.".into())
	}
	pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
		Err("Key protection is only implemented for Windows in this build.".into())
	}
}

const PROTECTED_BY: &str = "Windows DPAPI (current user)";

pub fn write_key_file(file: &Path, k: &Keys) -> Result<(), String> {
	if token_key_bytes(&k.token_key).is_none() {
		return Err("The encryption key must be 32 bytes.".into());
	}
	let enc = |s: &str| dpapi::protect(s.as_bytes()).map(|b| b64(&b));
	let body = json!({
		"v": 1,
		"protectedBy": PROTECTED_BY,
		"sessionSecret": enc(&k.session_secret)?,
		"tokenKey": enc(&k.token_key)?,
		"createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
	});
	if let Some(dir) = file.parent() {
		std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
	}
	let mut tmp = file.as_os_str().to_owned();
	tmp.push(".tmp");
	std::fs::write(&tmp, serde_json::to_string_pretty(&body).unwrap()).map_err(|e| e.to_string())?;
	std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

pub fn read_key_file(file: &Path) -> Result<Keys, String> {
	let raw: Value = serde_json::from_slice(&std::fs::read(file).map_err(|e| format!("Could not read {}: {e}", file.display()))?).map_err(|e| format!("The key file is damaged: {e}"))?;
	if raw["v"] != 1 {
		return Err("Unknown key file version.".into());
	}
	if raw["protectedBy"] != PROTECTED_BY {
		return Err(format!(
			"This key file was protected by \"{}\", which this Windows app cannot unlock. Keys cannot be moved between computers or operating systems; use Import from Folder with the original project instead.",
			raw["protectedBy"].as_str().unwrap_or("something else")
		));
	}
	let dec = |v: &Value| -> Result<String, String> {
		let sealed = v.as_str().and_then(b64_decode).ok_or("the key file is damaged")?;
		String::from_utf8(dpapi::unprotect(&sealed)?).map_err(|_| "the unlocked key is not text".to_string())
	};
	let unlock = || -> Result<Keys, String> {
		let keys = Keys { session_secret: dec(&raw["sessionSecret"])?, token_key: dec(&raw["tokenKey"])? };
		if token_key_bytes(&keys.token_key).is_none() {
			return Err("decrypted key has the wrong length".into());
		}
		Ok(keys)
	};
	unlock().map_err(|e| format!("Windows refused to unlock Publisher's key ({e}). The key can only be opened by the Windows user who created it, on this PC."))
}

fn parse_env(file: &Path) -> std::collections::HashMap<String, String> {
	let mut out = std::collections::HashMap::new();
	for line in std::fs::read_to_string(file).unwrap_or_default().lines() {
		let Some((k, v)) = line.split_once('=') else { continue };
		let k = k.trim();
		if k.is_empty() || !k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') {
			continue;
		}
		let v = v.trim();
		let v = v.strip_prefix(['"', '\'']).unwrap_or(v);
		let v = v.strip_suffix(['"', '\'']).unwrap_or(v);
		out.insert(k.to_string(), v.to_string());
	}
	out
}

/** Decrypts one stored value with the key, to prove key and database belong together. */
fn key_matches(db: &Connection, key: &[u8; 32]) -> &'static str {
	let mut rows: Vec<String> = Vec::new();
	for sql in ["SELECT access_token FROM accounts WHERE access_token LIKE 'v1.%' LIMIT 3", "SELECT value FROM app_settings WHERE value LIKE 'v1.%' LIMIT 3"] {
		if let Ok(mut st) = db.prepare(sql) {
			if let Ok(found) = st.query_map([], |r| r.get::<_, String>(0)) {
				rows.extend(found.flatten());
			}
		}
	}
	if rows.is_empty() {
		return "nothing-encrypted-yet";
	}
	if rows.iter().any(|v| open(key, Some(v)).is_ok()) {
		"ok"
	} else {
		"mismatch"
	}
}

pub struct ImportTarget {
	pub data_dir: PathBuf,
	pub settings_file: PathBuf,
	pub key_file: PathBuf,
}

/// Copies an older project folder (`.env` + `data/`) into the app's data folder.
/// Uses SQLite's `VACUUM INTO` for a consistent snapshot even if the old copy is running, copies the
/// videos, checks the key really opens the copied data, and only then protects the key with DPAPI.
/// The source folder is never modified.
pub fn import_legacy(source: &Path, o: &ImportTarget) -> Result<Value, String> {
	let env_file = source.join(".env");
	let src_db = source.join("data").join("app.db");
	if !env_file.exists() || !src_db.exists() {
		return Err(format!("{} does not look like a Publisher project folder (it needs .env and data/app.db).", source.display()));
	}
	let env = parse_env(&env_file);
	let get = |k: &str| env.get(k).cloned().unwrap_or_default();
	let (token_key, session_secret) = (get("TOKEN_ENCRYPTION_KEY"), get("SESSION_SECRET"));
	if token_key.is_empty() || session_secret.is_empty() {
		return Err("The old .env has no TOKEN_ENCRYPTION_KEY or SESSION_SECRET, so its saved accounts could not be read.".into());
	}
	let key = token_key_bytes(&token_key).ok_or("The TOKEN_ENCRYPTION_KEY in the old .env is not a 32-byte base64 key.")?;
	let sql = |e: rusqlite::Error| format!("Database error during import: {e}");

	let mut staging = o.data_dir.as_os_str().to_owned();
	staging.push(".importing");
	let staging = PathBuf::from(staging);
	let _ = std::fs::remove_dir_all(&staging);
	std::fs::create_dir_all(staging.join("media")).map_err(|e| e.to_string())?;
	let target = staging.join("app.db");
	{
		let src = Connection::open_with_flags(&src_db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql)?;
		src.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()]).map_err(sql)?;
	}

	let db = Connection::open(&target).map_err(sql)?;
	let check: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(sql)?;
	if check != "ok" {
		return Err("The copied database failed its integrity check. Nothing was imported.".into());
	}
	let matched = key_matches(&db, &key);
	if matched == "mismatch" {
		return Err("The encryption key in the old .env does not open the old database. Nothing was imported.".into());
	}
	let count = |t: &str| db.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap_or(0);
	let (posts, targets, accounts, media) = (count("posts"), count("targets"), count("accounts"), count("media"));

	// Videos: copy each file and repoint the database at the new location.
	let old_media = source.join("data").join("media");
	let files: Vec<(String, String)> = db.prepare("SELECT id, path FROM media WHERE deleted_at IS NULL").and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|r| r.flatten().collect())).map_err(sql)?;
	let mut copied = 0;
	for (id, path) in &files {
		// The stored path may come from another computer (or a Mac), so only its file name is trusted.
		let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_string();
		let from = if Path::new(path).exists() { PathBuf::from(path) } else { old_media.join(&name) };
		if from.exists() && std::fs::copy(&from, staging.join("media").join(&name)).is_ok() {
			copied += 1;
		}
		db.execute("UPDATE media SET path = ? WHERE id = ?", params![o.data_dir.join("media").join(&name).to_string_lossy(), id]).map_err(sql)?;
	}
	drop(db);

	// Keys are protected only after the data checked out. Then the staged folder becomes live.
	write_key_file(&o.key_file, &Keys { session_secret, token_key })?;
	let _ = std::fs::remove_dir_all(&o.data_dir);
	std::fs::rename(&staging, &o.data_dir).map_err(|e| format!("Could not move the imported data into place: {e}"))?;

	let truthy = |k: &str| matches!(get(k).to_lowercase().as_str(), "1" | "true" | "yes" | "on");
	let mut settings = json!({ "demoMode": truthy("DEMO_MODE") });
	if let Some(n) = get("MEDIA_RETENTION_HOURS").parse::<f64>().ok().filter(|n| *n > 0.0) {
		settings["mediaRetentionHours"] = json!(n);
	}
	if let Some(n) = get("MAX_UPLOAD_MB").parse::<f64>().ok().filter(|n| *n > 0.0) {
		settings["maxUploadMb"] = json!(n);
	}
	if get("PUBLIC_BASE_URL").starts_with("https://") {
		settings["publicBaseUrl"] = json!(get("PUBLIC_BASE_URL"));
	}
	std::fs::write(&o.settings_file, serde_json::to_string_pretty(&settings).unwrap()).map_err(|e| e.to_string())?;
	let skipped: Vec<&str> = ["GOOGLE_CLIENT_SECRET", "INSTAGRAM_APP_SECRET", "TIKTOK_CLIENT_SECRET"].into_iter().filter(|k| !get(k).is_empty()).collect();
	let report = json!({
		"source": source.to_string_lossy(),
		"importedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
		"keyCheck": matched,
		"posts": posts,
		"targets": targets,
		"accounts": accounts,
		"media": media,
		"videosCopied": copied,
		"videosListed": files.len(),
		"platformKeysInEnvNotImported": skipped,
	});
	if let Some(dir) = o.key_file.parent() {
		let _ = std::fs::write(dir.join("import-report.json"), serde_json::to_string_pretty(&report).unwrap());
	}
	Ok(report)
}

#[cfg(all(test, windows))]
mod tests {
	use super::*;

	#[test]
	fn key_file_round_trips_through_dpapi_and_never_holds_the_plain_key() {
		let dir = std::env::temp_dir().join(format!("sp-keys-{}", crate::crypto::random_id(6)));
		let file = dir.join("keys.json");
		let keys = Keys { session_secret: b64(&[1u8; 32]), token_key: b64(&[2u8; 32]) };
		write_key_file(&file, &keys).unwrap();
		let on_disk = std::fs::read_to_string(&file).unwrap();
		assert!(!on_disk.contains(&keys.token_key) && !on_disk.contains(&keys.session_secret));
		let back = read_key_file(&file).unwrap();
		assert_eq!((back.session_secret, back.token_key), (keys.session_secret.clone(), keys.token_key.clone()));
		assert!(write_key_file(&file, &Keys { session_secret: "x".into(), token_key: b64(&[2u8; 8]) }).is_err());
		let _ = std::fs::remove_dir_all(dir);
	}
}
