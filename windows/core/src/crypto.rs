//! Token encryption and signing. Formats match `server/crypto.ts` byte for byte, so a database
//! written by the Node version opens here with the same key.
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64U};
use base64::Engine;
use hmac::{Hmac, Mac};
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use subtle::ConstantTimeEq;

pub fn random_bytes(n: usize) -> Vec<u8> {
	let mut b = vec![0u8; n];
	getrandom::getrandom(&mut b).expect("the system random number generator is unavailable");
	b
}

pub fn random_id(bytes: usize) -> String {
	B64U.encode(random_bytes(bytes))
}

pub fn b64(data: &[u8]) -> String {
	B64.encode(data)
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
	B64.decode(s.trim()).ok()
}

/** A float in [0, 1) for retry jitter. */
pub fn random_unit() -> f64 {
	let b = random_bytes(4);
	u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64 / (u32::MAX as f64 + 1.0)
}

/** AES-256-GCM, stored as `v1.<iv>.<tag>.<data>` (standard base64). Empty values are stored as NULL. */
pub fn seal(key: &[u8; 32], plain: Option<&str>) -> Option<String> {
	let p = plain?;
	if p.is_empty() {
		return None;
	}
	let iv = random_bytes(12);
	let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
	let out = cipher.encrypt(Nonce::from_slice(&iv), p.as_bytes()).ok()?;
	let (data, tag) = out.split_at(out.len() - 16);
	Some(format!("v1.{}.{}.{}", B64.encode(&iv), B64.encode(tag), B64.encode(data)))
}

pub fn open(key: &[u8; 32], sealed: Option<&str>) -> Result<Option<String>, String> {
	let Some(s) = sealed else { return Ok(None) };
	if s.is_empty() {
		return Ok(None);
	}
	let parts: Vec<&str> = s.split('.').collect();
	if parts.len() != 4 || parts[0] != "v1" {
		return Err("Unknown token format".into());
	}
	let bad = || "Stored value could not be decrypted".to_string();
	let iv = B64.decode(parts[1]).map_err(|_| bad())?;
	let tag = B64.decode(parts[2]).map_err(|_| bad())?;
	let mut data = B64.decode(parts[3]).map_err(|_| bad())?;
	if iv.len() != 12 || tag.len() != 16 {
		return Err(bad());
	}
	data.extend_from_slice(&tag);
	let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
	let plain = cipher.decrypt(Nonce::from_slice(&iv), data.as_ref()).map_err(|_| bad())?;
	String::from_utf8(plain).map(Some).map_err(|_| bad())
}

pub fn sign(secret: &str, value: &str) -> String {
	let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
	mac.update(value.as_bytes());
	B64U.encode(mac.finalize().into_bytes())
}

/** `payload` must be a JSON object; an expiry is added. */
pub fn signed_token(secret: &str, mut payload: Value, ttl_seconds: i64) -> String {
	payload["exp"] = Value::from(crate::util::now_ms() / 1000 + ttl_seconds);
	let body = B64U.encode(payload.to_string());
	let sig = sign(secret, &body);
	format!("{body}.{sig}")
}

pub fn read_signed_token(secret: &str, token: &str) -> Option<Value> {
	let (body, sig) = token.split_once('.')?;
	if body.is_empty() || sig.is_empty() {
		return None;
	}
	let expected = sign(secret, body);
	if !constant_eq(sig.as_bytes(), expected.as_bytes()) {
		return None;
	}
	let data: Value = serde_json::from_slice(&B64U.decode(body).ok()?).ok()?;
	let exp = data.get("exp")?.as_f64()?;
	if exp < (crate::util::now_ms() as f64) / 1000.0 {
		return None;
	}
	Some(data)
}

pub fn constant_eq(a: &[u8], b: &[u8]) -> bool {
	a.len() == b.len() && bool::from(a.ct_eq(b))
}

pub fn pkce_pair() -> (String, String) {
	let verifier = random_id(48);
	let challenge = B64U.encode(Sha256::digest(verifier.as_bytes()));
	(verifier, challenge)
}

static RE_PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(access_token|refresh_token|client_secret|code|token)=([^&\s"]+)"#).unwrap());
static RE_BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(Bearer|OAuth)\s+[A-Za-z0-9._\-]+").unwrap());
static RE_JSON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""(access_token|refresh_token|id_token)"\s*:\s*"[^"]+""#).unwrap());

/** Removes anything that looks like a credential before a message is stored or logged. */
pub fn redact(text: &str) -> String {
	let a = RE_PARAM.replace_all(text, "${1}=[redacted]");
	let b = RE_BEARER.replace_all(&a, "${1} [redacted]");
	let c = RE_JSON.replace_all(&b, "\"${1}\":\"[redacted]\"");
	c.chars().take(1200).collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn seal_round_trips_and_hides_the_plain_text() {
		let key = [7u8; 32];
		let s = seal(&key, Some("ya29.secret-token")).unwrap();
		assert!(s.starts_with("v1."));
		assert!(!s.contains("secret-token"));
		assert_eq!(open(&key, Some(&s)).unwrap().as_deref(), Some("ya29.secret-token"));
		assert!(open(&[8u8; 32], Some(&s)).is_err());
		assert_eq!(seal(&key, Some("")), None);
		assert_eq!(seal(&key, None), None);
	}

	/// Produced by the Node server (`seal('hello from node')`) with the key bytes 0..31.
	#[test]
	fn opens_a_value_sealed_by_the_node_server() {
		let mut key = [0u8; 32];
		for (i, k) in key.iter_mut().enumerate() {
			*k = i as u8;
		}
		let sealed = "v1.AAECAwQFBgcICQoL.MSJv38fiRZynMTSzKs7gzg==.L2e6d6rFpGniLLfl3o0d";
		assert_eq!(open(&key, Some(sealed)).unwrap().as_deref(), Some("hello from node"));
	}

	#[test]
	fn signed_tokens_expire_and_reject_tampering() {
		let t = signed_token("secret", serde_json::json!({ "media": "abc" }), 60);
		assert_eq!(read_signed_token("secret", &t).unwrap()["media"], "abc");
		assert!(read_signed_token("other", &t).is_none());
		let old = signed_token("secret", serde_json::json!({ "media": "abc" }), -5);
		assert!(read_signed_token("secret", &old).is_none());
		assert!(read_signed_token("secret", "nonsense").is_none());
	}

	#[test]
	fn redact_removes_credentials() {
		let r = redact(r#"POST https://x/y?access_token=abc123&z=1 Bearer ya29.abc {"refresh_token":"1//zzz"} code=4/0Ab"#);
		assert!(!r.contains("abc123") && !r.contains("ya29") && !r.contains("1//zzz") && !r.contains("4/0Ab"), "{r}");
		assert!(r.contains("z=1"));
	}
}
