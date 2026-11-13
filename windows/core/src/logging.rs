//! Append-only log file with secrets removed. Rotated once at 5 MB, like the Mac app.
use parking_lot::Mutex;
use regex::Regex;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

pub struct Logger {
	file: Option<Mutex<File>>,
	secrets: Mutex<Vec<String>>,
}

static RE_BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(Bearer\s+)[\w.\-~+/=]+").unwrap());
static RE_PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)((?:access|refresh)_token|client_secret|code_verifier|code|k)=([^&\s"]+)"#).unwrap());
static RE_JSON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)("(?:access_token|refresh_token|client_secret|password)"\s*:\s*")[^"]*"#).unwrap());

impl Logger {
	/** A logger that discards everything (tests). */
	pub fn none() -> Self {
		Logger { file: None, secrets: Mutex::new(Vec::new()) }
	}

	pub fn open(path: &Path) -> Self {
		if let Ok(m) = std::fs::metadata(path) {
			if m.len() > 5 * 1024 * 1024 {
				let mut old = path.as_os_str().to_owned();
				old.push(".1");
				let _ = std::fs::remove_file(&old);
				let _ = std::fs::rename(path, &old);
			}
		}
		let file = OpenOptions::new().create(true).append(true).open(path).ok().map(Mutex::new);
		Logger { file, secrets: Mutex::new(Vec::new()) }
	}

	/** Values that must never reach the log (keys and the per-launch token). */
	pub fn add_secret(&self, s: &str) {
		if s.len() >= 8 {
			self.secrets.lock().push(s.to_string());
		}
	}

	pub fn redact(&self, s: &str) -> String {
		let mut out = s.to_string();
		for v in self.secrets.lock().iter() {
			out = out.replace(v.as_str(), "[redacted]");
		}
		let a = RE_BEARER.replace_all(&out, "${1}[redacted]");
		let b = RE_PARAM.replace_all(&a, "${1}=[redacted]");
		RE_JSON.replace_all(&b, "${1}[redacted]").into_owned()
	}

	pub fn line(&self, text: &str) {
		let Some(file) = &self.file else { return };
		let stamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
		let mut f = file.lock();
		for l in text.split('\n') {
			if !l.trim().is_empty() {
				let _ = writeln!(f, "{stamp} {}", self.redact(l));
			}
		}
	}
}
