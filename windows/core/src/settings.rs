//! Platform app keys entered in the app. Stored encrypted; secrets are never sent back to the page.
//! Port of `server/settings.ts` (the desktop app has no `.env`, so saved values are the only source
//! apart from the public address in settings.json).
use crate::crypto::{open, seal};
use crate::db::{Platform, PLATFORMS};
use crate::media::Issue;
use crate::util::now_ms;
use crate::App;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct Fields {
	pub id: &'static str,
	pub secret: &'static str,
	pub id_label: &'static str,
	pub secret_label: &'static str,
}

pub fn fields(p: Platform) -> Fields {
	match p {
		Platform::Youtube => Fields { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET", id_label: "Client ID", secret_label: "Client secret" },
		Platform::Instagram => Fields { id: "INSTAGRAM_APP_ID", secret: "INSTAGRAM_APP_SECRET", id_label: "App ID", secret_label: "App secret" },
		Platform::Tiktok => Fields { id: "TIKTOK_CLIENT_KEY", secret: "TIKTOK_CLIENT_SECRET", id_label: "Client key", secret_label: "Client secret" },
	}
}

/// `NOTIFY` and `DRAFTS_ONLY` ("off" or unset) are on/off choices. `INSTAGRAM_CONFIG_ID` and
/// `INSTAGRAM_LOGIN` pick how Instagram signs in (see `instagram::login_mode`).
/// `PHONE_ACCESS` ("on" or unset) lets paired phones use the app over Wi-Fi (see `phone.rs`).
const ALLOWED: [&str; 12] = [
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"INSTAGRAM_APP_ID",
	"INSTAGRAM_APP_SECRET",
	"TIKTOK_CLIENT_KEY",
	"TIKTOK_CLIENT_SECRET",
	"PUBLIC_BASE_URL",
	"NOTIFY",
	"DRAFTS_ONLY",
	"INSTAGRAM_CONFIG_ID",
	"INSTAGRAM_LOGIN",
	"PHONE_ACCESS",
];

/** Drafts only (on unless the owner turned it off): nothing Publisher sends can go public by itself. */
pub fn drafts_only(app: &App) -> bool {
	get(app, "DRAFTS_ONLY") != "off"
}

fn load(app: &App) -> Arc<HashMap<String, String>> {
	if let Some((at, values)) = app.settings_cache.lock().as_ref() {
		if at.elapsed() < Duration::from_secs(3) {
			return values.clone();
		}
	}
	let mut values = HashMap::new();
	{
		let db = app.db();
		if let Ok(mut st) = db.prepare_cached("SELECT key, value FROM app_settings") {
			if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
				for (k, v) in rows.flatten() {
					if let Ok(Some(plain)) = open(&app.cfg.token_key, Some(&v)) {
						values.insert(k, plain);
					}
				}
			}
		};
	}
	let values = Arc::new(values);
	*app.settings_cache.lock() = Some((Instant::now(), values.clone()));
	values
}

/** A saved setting, or an empty string. */
pub fn get(app: &App, key: &str) -> String {
	load(app).get(key).cloned().unwrap_or_default()
}

pub fn public_base_url(app: &App) -> String {
	load(app).get("PUBLIC_BASE_URL").cloned().or_else(|| app.cfg.public_base_url.clone()).unwrap_or_default()
}

pub fn is_https(url: &str) -> bool {
	url.starts_with("https://")
}

pub fn configured(app: &App, p: Platform) -> bool {
	let f = fields(p);
	!get(app, f.id).is_empty() && !get(app, f.secret).is_empty()
}

/// Where each platform sends the browser back after sign-in. YouTube accepts loopback addresses on
/// any port for "Desktop app" clients. Instagram and TikTok need a registered HTTPS address, so they
/// use the public address (a tunnel) when one is set.
pub fn redirect_uri(app: &App, p: Platform) -> String {
	let public = public_base_url(app);
	let base = if p != Platform::Youtube && is_https(&public) { public } else { app.cfg.app_url.clone() };
	format!("{}/api/oauth/{}/callback", base.trim_end_matches('/'), p.as_str())
}

/** `None` or an empty value removes the setting. */
pub fn save(app: &App, values: &[(&str, Option<&str>)]) -> Result<(), String> {
	let db = app.db();
	for (k, v) in values {
		if !ALLOWED.contains(k) {
			return Err(format!("Unknown setting {k}"));
		}
		match v.map(str::trim).filter(|s| !s.is_empty()) {
			None => db.execute("DELETE FROM app_settings WHERE key = ?", [k]).map(|_| ()),
			Some(val) => db
				.execute(
					"INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
					params![k, seal(&app.cfg.token_key, Some(val)), now_ms()],
				)
				.map(|_| ()),
		}
		.map_err(|e| e.to_string())?;
	}
	*app.settings_cache.lock() = None;
	Ok(())
}

fn mask(v: &str) -> String {
	let chars: Vec<char> = v.chars().collect();
	if chars.len() <= 10 {
		format!("{}…", chars.iter().take(2).collect::<String>())
	} else {
		format!("{}…{}", chars[..6].iter().collect::<String>(), chars[chars.len() - 4..].iter().collect::<String>())
	}
}

/** Safe summary for the page: whether keys exist, where they came from, a masked ID. Never the secret. */
pub fn setup_view(app: &App) -> Value {
	let saved = load(app);
	let public = public_base_url(app);
	let platforms: serde_json::Map<String, Value> = PLATFORMS
		.iter()
		.map(|p| {
			let f = fields(*p);
			let id = saved.get(f.id).cloned().unwrap_or_default();
			let secret = saved.get(f.secret).cloned().unwrap_or_default();
			let from_app = saved.contains_key(f.id) || saved.contains_key(f.secret);
			let mut view = json!({
					"configured": !id.is_empty() && !secret.is_empty(),
					"hosted": crate::relay::hosted(app, *p),
					"source": if from_app { Value::from("app") } else { Value::Null },
					"idPreview": if id.is_empty() { Value::Null } else { Value::from(mask(&id)) },
					"hasSecret": !secret.is_empty(),
					"redirectUri": redirect_uri(app, *p),
					"idLabel": f.id_label,
					"secretLabel": f.secret_label,
			});
			if *p == Platform::Instagram {
				let cfg = saved.get("INSTAGRAM_CONFIG_ID").cloned().unwrap_or_default();
				view["loginMode"] = Value::from(crate::platforms::instagram::login_mode(app));
				view["configPreview"] = if cfg.is_empty() { Value::Null } else { Value::from(mask(&cfg)) };
			}
			(p.as_str().to_string(), view)
		})
		.collect();
	json!({
		"appUrl": app.cfg.app_url,
		"publicBaseUrl": {
			"value": if public.is_empty() { Value::Null } else { Value::from(public) },
			"source": if saved.contains_key("PUBLIC_BASE_URL") { Value::from("app") } else if app.cfg.public_base_url.is_some() { Value::from("env") } else { Value::Null },
		},
		"platforms": platforms,
	})
}

/** Light format checks that catch common copy-paste mistakes. */
pub fn check_keys(p: Platform, id: &str, secret: &str) -> Vec<Issue> {
	let f = fields(p);
	let mut out = Vec::new();
	let i = id.trim();
	let s = secret.trim();
	if i.is_empty() {
		out.push(Issue::new("id", format!("Paste the {}.", f.id_label)));
	}
	if s.is_empty() {
		out.push(Issue::new("secret", format!("Paste the {}.", f.secret_label)));
	}
	if i.chars().any(char::is_whitespace) || s.chars().any(char::is_whitespace) {
		out.push(Issue::new("id", "Remove spaces or line breaks from the pasted value."));
	}
	if p == Platform::Youtube && !i.is_empty() && !i.ends_with(".apps.googleusercontent.com") {
		out.push(Issue::new("id", "A Google client ID ends in .apps.googleusercontent.com."));
	}
	if p == Platform::Youtube && !i.is_empty() && !s.is_empty() && s == i {
		out.push(Issue::new("secret", "This is the client ID again. Paste the client secret."));
	}
	if p == Platform::Instagram && !i.is_empty() && !(i.len() >= 6 && i.bytes().all(|b| b.is_ascii_digit())) {
		out.push(Issue::new("id", "The app ID is a number."));
	}
	out
}
