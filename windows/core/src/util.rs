//! Small helpers, including the few JavaScript coercions the original server relied on.
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
	SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/** `String(v ?? '')` */
pub fn js_str(v: &Value) -> String {
	match v {
		Value::Null => String::new(),
		Value::String(s) => s.clone(),
		Value::Bool(b) => b.to_string(),
		Value::Number(n) => n.to_string(),
		other => other.to_string(),
	}
}

/** JavaScript truthiness. */
pub fn js_truthy(v: &Value) -> bool {
	match v {
		Value::Null => false,
		Value::Bool(b) => *b,
		Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
		Value::String(s) => !s.is_empty(),
		_ => true,
	}
}

/** `Number(v)` for the value kinds a settings object can hold. */
pub fn js_num(v: &Value) -> f64 {
	match v {
		Value::Null => 0.0,
		Value::Bool(b) => *b as u8 as f64,
		Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
		Value::String(s) => {
			let t = s.trim();
			if t.is_empty() {
				0.0
			} else {
				t.parse::<f64>().unwrap_or(f64::NAN)
			}
		}
		_ => f64::NAN,
	}
}

/** Length as JavaScript counts it (UTF-16 code units), which is what the platforms' limits use. */
pub fn js_len(s: &str) -> usize {
	s.encode_utf16().count()
}

pub fn host_of(url: &str) -> String {
	url::Url::parse(url)
		.ok()
		.map(|u| match (u.host_str(), u.port()) {
			(Some(h), Some(p)) => format!("{h}:{p}"),
			(Some(h), None) => h.to_string(),
			_ => String::new(),
		})
		.unwrap_or_default()
}

/** `new URLSearchParams(pairs).toString()` */
pub fn form(pairs: &[(&str, &str)]) -> String {
	let mut s = url::form_urlencoded::Serializer::new(String::new());
	for (k, v) in pairs {
		s.append_pair(k, v);
	}
	s.finish()
}

/** `encodeURIComponent` */
pub fn encode_component(s: &str) -> String {
	use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
	const SET: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
	utf8_percent_encode(s, SET).to_string()
}

pub fn decode_component(s: &str) -> String {
	percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}
