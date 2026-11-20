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

/// Puts plain text on the Windows clipboard (CF_UNICODETEXT), for pasting the caption into TikTok.
/// `owner` is the app window: with no owner, EmptyClipboard leaves the clipboard unowned and
/// SetClipboardData then fails.
pub fn copy_text(owner: *mut std::ffi::c_void, text: &str) -> Result<(), String> {
	use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
	use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
	use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
	const CF_UNICODETEXT: u32 = 13;
	let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
	unsafe {
		// Another program may hold the clipboard for a moment, so try a few times.
		let mut opened = false;
		for _ in 0..10 {
			if OpenClipboard(Some(HWND(owner))).is_ok() {
				opened = true;
				break;
			}
			std::thread::sleep(std::time::Duration::from_millis(30));
		}
		if !opened {
			return Err("the clipboard is busy".into());
		}
		let result = (|| -> Result<(), String> {
			EmptyClipboard().map_err(|e| e.to_string())?;
			let mem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|e| e.to_string())?;
			let ptr = GlobalLock(mem) as *mut u16;
			if ptr.is_null() {
				let _ = GlobalFree(Some(mem));
				return Err("could not lock clipboard memory".into());
			}
			std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
			let _ = GlobalUnlock(mem);
			// On success the clipboard owns the memory.
			if let Err(e) = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(mem.0))) {
				let _ = GlobalFree(Some(mem));
				return Err(e.to_string());
			}
			Ok(())
		})();
		let _ = CloseClipboard();
		result
	}
}
