//! Phone access: use Publisher from an Android phone or iPhone while the computer does the work.
//!
//! Off by default. When the owner turns it on, the app also listens on this computer's Wi-Fi address
//! (same port), and the owner pairs a phone by scanning a QR code shown in the app window. The QR
//! holds a one-use link (10 minutes). Opening it gives that phone its own random key in a cookie;
//! only a hash of the key is stored, and each phone can be removed on its own. Turning phone access
//! off stops the Wi-Fi listener and refuses every phone key at once.
//!
//! With a public HTTPS address set (the tunnel Instagram needs), the pairing link also works through
//! it, so the phone keeps working away from home, over HTTPS.
//!
//! Phones can post, schedule, see history and stats, and manage groups. Things that belong on the
//! computer stay there: developer keys, connecting accounts (sign-in returns to this computer),
//! the native file picker and folders, and phone access itself.
use crate::crypto::{constant_eq, random_id};
use crate::util::now_ms;
use crate::{settings, App};
use axum::http::{HeaderMap, Method};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Arc;

pub const COOKIE: &str = "sp_phone";
const PAIR_MS: i64 = 10 * 60_000;

pub fn enabled(app: &App) -> bool {
	settings::get(app, "PHONE_ACCESS") == "on"
}

fn hash(token: &str) -> String {
	crate::crypto::b64(&Sha256::digest(token.as_bytes()))
}

/// The phone behind this request, from its cookie (`<device id>.<key>`). `None` when phone access is
/// off, the cookie is missing or wrong, or the phone was removed.
pub fn device_of(app: &App, cookie: Option<String>) -> Option<String> {
	if !enabled(app) {
		return None;
	}
	let raw = cookie?;
	let (id, token) = raw.split_once('.')?;
	let stored: String = app.db().query_row("SELECT token_hash FROM devices WHERE id = ?", [id], |r| r.get(0)).optional().ok().flatten()?;
	if !constant_eq(stored.as_bytes(), hash(token).as_bytes()) {
		return None;
	}
	let t = now_ms();
	let _ = app.db().execute("UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)", params![t, id, t - 60_000]);
	Some(id.to_string())
}

/// What a paired phone may not do. These need the computer: developer keys, connecting accounts
/// (the sign-in returns to this computer), native pickers and folders, and phone access itself.
pub fn blocked(method: &Method, path: &str) -> bool {
	if path.starts_with("/api/phone") {
		return true;
	}
	// Phones may read the preferences but not change them: Drafts only is what keeps a stolen phone
	// key (sniffed on Wi-Fi) from posting publicly.
	if path.starts_with("/api/desktop/") {
		return !(path == "/api/desktop/prefs" && *method == Method::GET);
	}
	if path.starts_with("/api/oauth/") && (path.ends_with("/begin") || path.ends_with("/start")) {
		return true;
	}
	path.starts_with("/api/setup") && *method != Method::GET
}

/// This computer's address on the local network, when it has a private one (home Wi-Fi, or a
/// Tailscale-style 100.64/10 address). Asking the routing table sends no packets.
pub fn lan_ip() -> Option<Ipv4Addr> {
	let s = UdpSocket::bind("0.0.0.0:0").ok()?;
	s.connect("8.8.8.8:80").ok()?;
	match s.local_addr().ok()?.ip() {
		IpAddr::V4(ip) if ip.is_private() || (ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1])) => Some(ip),
		_ => None,
	}
}

/** Starts the Wi-Fi listener if phone access is on and it is not running yet. Returns a problem, if any. */
pub fn start(app: &Arc<App>) -> Option<String> {
	if !enabled(app) || app.phone_listener.lock().is_some() {
		return None;
	}
	let Some(ip) = lan_ip() else { return Some("This computer has no Wi-Fi or network address right now. Connect it to the same Wi-Fi as the phone.".into()) };
	let addr = SocketAddr::from((ip, app.cfg.port));
	let std_listener = match std::net::TcpListener::bind(addr) {
		Ok(l) => l,
		Err(e) => return Some(format!("Could not open {addr} for phones: {e}")),
	};
	let _ = std_listener.set_nonblocking(true);
	let listener = match tokio::net::TcpListener::from_std(std_listener) {
		Ok(l) => l,
		Err(e) => return Some(format!("Could not open {addr} for phones: {e}")),
	};
	let task = {
		let app = app.clone();
		tokio::spawn(async move {
			if let Err(e) = crate::server::serve(listener, app.clone()).await {
				app.log.line(&format!("[phone] listener stopped: {e}"));
			}
		})
	};
	*app.phone_listener.lock() = Some((addr, task.abort_handle()));
	app.log.line(&format!("[phone] phones can connect at http://{addr}"));
	None
}

pub fn stop(app: &App) {
	if let Some((addr, task)) = app.phone_listener.lock().take() {
		task.abort();
		app.log.line(&format!("[phone] stopped listening on {addr}"));
	}
}

fn wifi_url(app: &App) -> Option<String> {
	app.phone_listener.lock().as_ref().map(|(a, _)| format!("http://{a}"))
}

fn https_url(app: &App) -> Option<String> {
	let p = settings::public_base_url(app);
	settings::is_https(&p).then(|| p.trim_end_matches('/').to_string())
}

/** What the computer's Phone access panel shows. */
pub fn view(app: &App, problem: Option<String>) -> Value {
	let devices: Vec<Value> = {
		let db = app.db();
		let mut st = match db.prepare_cached("SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at") {
			Ok(st) => st,
			Err(_) => return json!({ "enabled": false, "devices": [] }),
		};
		st.query_map([], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "createdAt": r.get::<_, i64>(2)?, "lastSeenAt": r.get::<_, Option<i64>>(3)? })))
			.map(|r| r.flatten().collect())
			.unwrap_or_default()
	};
	json!({ "enabled": enabled(app), "wifiUrl": wifi_url(app), "httpsUrl": https_url(app), "problem": problem, "devices": devices })
}

/** Turns phone access on or off. Off also stops the Wi-Fi listener; paired phones stay listed but are refused. */
/// Off stops the listener even if the setting could not be saved, and then reports the error, so
/// the owner never sees "off" while phones still get in.
pub fn set_enabled(app: &Arc<App>, on: bool) -> Result<Value, String> {
	let saved = settings::save(app, &[("PHONE_ACCESS", on.then_some("on"))]);
	if !on {
		stop(app);
	}
	saved?;
	let problem = if on { start(app) } else { None };
	Ok(view(app, problem))
}

/** A new one-use pairing link and its QR code (SVG). */
pub fn pair(app: &App) -> Result<Value, &'static str> {
	if !enabled(app) {
		return Err("Turn on phone access first.");
	}
	let base = wifi_url(app).or_else(|| https_url(app)).ok_or("Phones cannot reach this computer yet. Connect it to Wi-Fi, or set a public HTTPS address.")?;
	let secret = random_id(24);
	let exp = now_ms() + PAIR_MS;
	{
		let mut p = app.pairing.lock();
		let t = now_ms();
		p.retain(|_, e| *e >= t);
		p.insert(secret.clone(), exp);
	}
	let url = format!("{base}/pair/{secret}");
	let qr = qrcode::QrCode::new(url.as_bytes()).map(|c| c.render::<qrcode::render::svg::Color>().min_dimensions(220, 220).quiet_zone(true).dark_color(qrcode::render::svg::Color("#000")).light_color(qrcode::render::svg::Color("#fff")).build()).unwrap_or_default();
	let away = https_url(app).filter(|_| wifi_url(app).is_some()).map(|h| format!("{h}/pair/{secret}"));
	Ok(json!({ "url": url, "awayUrl": away, "qr": qr, "expiresAt": exp }))
}

/// Opens a pairing link on the phone. Uses it up and returns the new phone's cookie value
/// (`<id>.<key>`), or `None` when the link is unknown, used or expired.
pub fn redeem(app: &App, secret: &str, user_agent: &str) -> Option<String> {
	if !enabled(app) {
		return None;
	}
	let exp = app.pairing.lock().remove(secret)?;
	if exp < now_ms() {
		return None;
	}
	let (id, token) = (random_id(9), random_id(32));
	let ua = user_agent.to_lowercase();
	let kind = if ua.contains("iphone") {
		"iPhone"
	} else if ua.contains("ipad") {
		"iPad"
	} else if ua.contains("android") {
		"Android phone"
	} else {
		"Phone"
	};
	let n: i64 = app.db().query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0)).unwrap_or(0);
	let name = if n == 0 { kind.to_string() } else { format!("{kind} {}", n + 1) };
	app.db().execute("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", params![id, name, hash(&token), now_ms(), now_ms()]).ok()?;
	app.log.line(&format!("[phone] paired {name}"));
	Some(format!("{id}.{token}"))
}

pub fn remove(app: &App, id: &str) -> bool {
	app.db().execute("DELETE FROM devices WHERE id = ?", [id]).unwrap_or(0) > 0
}

/** The phone's cookie. `Secure` when the request came over HTTPS (the tunnel). */
pub fn set_cookie(value: &str, headers: &HeaderMap) -> String {
	let https = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).map(|v| v.eq_ignore_ascii_case("https")).unwrap_or(false);
	format!("{COOKIE}={value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax{}", if https { "; Secure" } else { "" })
}

pub fn clear_cookie() -> String {
	format!("{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
}
