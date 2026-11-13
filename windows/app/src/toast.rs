//! Windows notifications ("toasts") for a portable app.
//!
//! Windows only shows a toast for an app it knows. An installed app is known through its Start menu
//! shortcut; this one runs as a single exe, so it registers itself under
//! `HKCU\Software\Classes\AppUserModelId\<id>` with its name and icon, the way unpackaged apps do.
//! That key belongs to the current user only and needs no admin rights.
use std::path::Path;
use windows::core::{HSTRING, PCWSTR};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ};
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

/// Same as the identifier in tauri.conf.json, so an installer build would use the same name.
pub const APP_ID: &str = "local.socialpublisher.publisher";

/** Registers the app's notification name and icon for this Windows user. Safe to call every start. */
pub fn register(display_name: &str, icon: &Path) -> Result<(), String> {
	let sub = HSTRING::from(format!("Software\\Classes\\AppUserModelId\\{APP_ID}"));
	let mut key = HKEY::default();
	unsafe {
		RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut key, None).ok().map_err(|e| e.to_string())?;
		let set = |name: &str, value: &str| {
			let name = HSTRING::from(name);
			let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
			let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
			RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(bytes)).ok().map_err(|e| e.to_string())
		};
		let r = set("DisplayName", display_name).and_then(|_| set("IconUri", &icon.to_string_lossy()));
		let _ = RegCloseKey(key);
		r
	}
}

fn esc(s: &str) -> String {
	s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Shows a toast. It is silent, because the app plays its own finish sound (which follows the
/// Sounds on/off choice in the window).
pub fn show(title: &str, body: &str) -> Result<(), String> {
	let xml = format!(r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual><audio silent="true"/></toast>"#, esc(title), esc(body));
	let doc = XmlDocument::new().map_err(|e| e.to_string())?;
	doc.LoadXml(&HSTRING::from(xml)).map_err(|e| e.to_string())?;
	let toast = ToastNotification::CreateToastNotification(&doc).map_err(|e| e.to_string())?;
	ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID)).and_then(|n| n.Show(&toast)).map_err(|e| e.to_string())
}
