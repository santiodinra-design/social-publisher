//! HTTP with a timeout and error classification. Messages never include tokens.
use super::PubError;
use crate::util::{host_of, js_str, js_truthy};
use crate::App;
use regex::Regex;
use reqwest::Method;
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::time::Duration;

pub struct Res {
	pub status: u16,
	pub headers: reqwest::header::HeaderMap,
	body: Vec<u8>,
}

impl Res {
	pub fn ok(&self) -> bool {
		(200..300).contains(&self.status)
	}
	pub fn header(&self, name: &str) -> Option<String> {
		self.headers.get(name).and_then(|v| v.to_str().ok()).map(String::from)
	}
	pub fn json(&self) -> Option<Value> {
		serde_json::from_slice(&self.body).ok()
	}
	pub fn text(&self) -> String {
		String::from_utf8_lossy(&self.body).into_owned()
	}
}

pub struct Req<'a> {
	pub method: Method,
	pub url: &'a str,
	pub headers: Vec<(&'static str, String)>,
	pub body: Option<Vec<u8>>,
	pub timeout_ms: u64,
}

impl<'a> Req<'a> {
	pub fn new(method: Method, url: &'a str) -> Self {
		Req { method, url, headers: Vec::new(), body: None, timeout_ms: 60_000 }
	}
	pub fn get(url: &'a str) -> Self {
		Req::new(Method::GET, url)
	}
	pub fn post(url: &'a str) -> Self {
		Req::new(Method::POST, url)
	}
	pub fn put(url: &'a str) -> Self {
		Req::new(Method::PUT, url)
	}
	pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
		self.headers.push((name, value.into()));
		self
	}
	pub fn bearer(self, token: &str) -> Self {
		self.header("Authorization", format!("Bearer {token}"))
	}
	pub fn form(mut self, pairs: &[(&str, &str)]) -> Self {
		self.body = Some(crate::util::form(pairs).into_bytes());
		self.header("Content-Type", "application/x-www-form-urlencoded")
	}
	pub fn json_body(mut self, v: &Value) -> Self {
		self.body = Some(v.to_string().into_bytes());
		self.header("Content-Type", "application/json; charset=UTF-8")
	}
	pub fn body(mut self, b: Vec<u8>) -> Self {
		self.body = Some(b);
		self
	}
	pub fn timeout(mut self, ms: u64) -> Self {
		self.timeout_ms = ms;
		self
	}
}

/** Sends a request. Any failure to get a response is a `Transient` error naming only the host. */
pub async fn send(app: &App, req: Req<'_>) -> Result<Res, PubError> {
	let host = host_of(req.url);
	let mut b = app.http.request(req.method.clone(), req.url).timeout(Duration::from_millis(req.timeout_ms));
	for (k, v) in &req.headers {
		b = b.header(*k, v);
	}
	// PUT and POST always carry a body, even an empty one, so a Content-Length is sent.
	if let Some(body) = req.body {
		b = b.body(body);
	} else if req.method != Method::GET {
		b = b.body(Vec::new());
	}
	let fail = |e: reqwest::Error| {
		let why = if e.is_timeout() { "timed out".to_string() } else { e.without_url().to_string() };
		PubError::transient(format!("Network error contacting {host}: {why}"))
	};
	let res = b.send().await.map_err(fail)?;
	let status = res.status().as_u16();
	let headers = res.headers().clone();
	let body = res.bytes().await.map_err(fail)?.to_vec();
	Ok(Res { status, headers, body })
}

/** Sends a request and returns its JSON, or a classified error if the platform reported one. */
pub async fn json(app: &App, req: Req<'_>) -> Result<Value, PubError> {
	let host = host_of(req.url);
	let res = send(app, req).await?;
	let text = res.text();
	let body: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text.chars().take(300).collect::<String>() })) };
	let code = &body["error"]["code"];
	if !res.ok() || (js_truthy(code) && code != "ok") {
		return Err(classify(res.status, &body, &host, res.header("retry-after").as_deref()));
	}
	Ok(body)
}

static RE_AUTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)invalid_grant|access_token_invalid|token.*expired|OAuthException.*(190|463)|scope_not_authorized|access_token_expired").unwrap());
static RE_TRANSIENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)rate_limit|rate limit|spam_risk_too_many|quotaExceeded|backendError|temporarily").unwrap());

pub fn classify(status: u16, body: &Value, host: &str, retry_after: Option<&str>) -> PubError {
	let described = describe(body);
	let msg = if described.is_empty() { format!("HTTP {status}") } else { described };
	let place = format!("{host}: {msg}");
	let raw = if body.is_null() { "\"\"".to_string() } else { body.to_string() };
	if status == 401 || RE_AUTH.is_match(&raw) {
		return PubError::auth(place);
	}
	if status == 429 || status >= 500 || RE_TRANSIENT.is_match(&msg) {
		let after = retry_after.and_then(|s| s.trim().parse::<f64>().ok()).filter(|n| n.is_finite() && *n >= 0.0).map(|n| (n * 1000.0) as u64);
		return PubError::Transient { msg: crate::crypto::redact(&place), retry_after_ms: after };
	}
	PubError::permanent(place)
}

fn describe(body: &Value) -> String {
	if !js_truthy(body) {
		return String::new();
	}
	let e = &body["error"];
	if let Some(s) = e.as_str() {
		if !s.is_empty() {
			return [s.to_string(), js_str(&body["error_description"])].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(": ");
		}
	}
	if js_truthy(e) {
		return [&e["code"], &e["message"], &e["error_user_msg"], &e["errors"][0]["reason"]].into_iter().filter(|x| js_truthy(x) && *x != "ok").map(js_str).collect::<Vec<_>>().join(" · ");
	}
	if !body["message"].is_null() {
		return js_str(&body["message"]);
	}
	js_str(&body["raw"])
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn classifies_errors_the_way_the_runner_expects() {
		assert!(matches!(classify(401, &Value::Null, "h", None), PubError::Auth(_)));
		assert!(matches!(classify(400, &json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." }), "h", None), PubError::Auth(_)));
		assert!(matches!(classify(400, &json!({ "error": { "type": "OAuthException", "code": 190, "message": "bad" } }), "h", None), PubError::Auth(_)));
		match classify(429, &Value::Null, "h", Some("7")) {
			PubError::Transient { retry_after_ms, .. } => assert_eq!(retry_after_ms, Some(7000)),
			other => panic!("{other:?}"),
		}
		assert!(matches!(classify(503, &Value::Null, "h", None), PubError::Transient { .. }));
		assert!(matches!(classify(403, &json!({ "error": { "code": 403, "message": "x", "errors": [{ "reason": "quotaExceeded" }] } }), "h", None), PubError::Transient { .. }));
		let p = classify(400, &json!({ "error": { "code": "invalid_params", "message": "bad chunk" } }), "open.tiktokapis.com", None);
		assert!(matches!(&p, PubError::Permanent(m) if m == "open.tiktokapis.com: invalid_params · bad chunk"), "{p:?}");
		assert!(matches!(classify(404, &Value::Null, "h", None), PubError::Permanent(m) if m == "h: HTTP 404"));
	}
}
