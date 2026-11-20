//! Publisher for Windows: the desktop shell.
//!
//! Owns the window, the tray icon and the quit flow, keeps the encryption keys protected by Windows
//! (DPAPI), and runs the API and the publishing worker inside this one process. It is the Windows
//! counterpart of `desktop/main.ts`; the Mac app is untouched by this crate.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use publisher_core::keys::{self, ImportTarget, Keys};
use publisher_core::logging::Logger;
use publisher_core::{crypto, db, jobs, runner, server, App, Config, Endpoints, Shell};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const APP_NAME: &str = "Publisher";

/// Everything that exists once startup has finished.
struct Running {
	app: Arc<App>,
	owner: String,
	user_data: PathBuf,
	settings_file: PathBuf,
}
static RUNNING: OnceLock<Running> = OnceLock::new();
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static QUITTING: AtomicBool = AtomicBool::new(false);

struct DesktopShell(AppHandle);

impl Shell for DesktopShell {
	fn pick_video(&self) -> Option<PathBuf> {
		let mut dialog = self.0.dialog().file().set_title("Choose a video").add_filter("Videos", &["mp4", "mov", "m4v", "webm"]);
		if let Some(w) = self.0.get_webview_window("main") {
			dialog = dialog.set_parent(&w);
		}
		dialog.blocking_pick_file().and_then(|f| f.into_path().ok())
	}
	fn open_url(&self, url: &str) {
		let _ = open::that_detached(url);
	}
	fn reveal(&self, path: &Path) {
		let _ = open::that_detached(path);
	}
	fn notify(&self, notice: &publisher_core::Notice) {
		let (title, body, ok) = (notice.title.clone(), notice.body.clone(), notice.ok);
		let handle = self.0.clone();
		let copy = notice.copy.clone().filter(|t| !t.trim().is_empty());
		// WinRT, the clipboard owner window and the webview all want the main thread.
		let _ = self.0.run_on_main_thread(move || {
			// TikTok drafts cannot carry a caption, so it goes on the clipboard, ready to paste in TikTok.
			if let (Some(text), Some(w)) = (copy.as_deref(), handle.get_webview_window("main")) {
				let copied = w.hwnd().map_err(|e| e.to_string()).and_then(|h| toast::copy_text(h.0 as *mut std::ffi::c_void, text));
				if let (Err(e), Some(r)) = (copied, RUNNING.get()) {
					r.app.log.line(&format!("caption not copied: {e}"));
				}
			}
			if let Err(e) = toast::show(&title, &body) {
				if let Some(r) = RUNNING.get() {
					r.app.log.line(&format!("notification not shown: {e}"));
				}
			}
			if let Some(w) = handle.get_webview_window("main") {
				let _ = w.eval(format!("window.__publisherFinished && window.__publisherFinished({{ ok: {ok} }})"));
			}
		});
	}
}

mod toast;

fn user_data_dir() -> PathBuf {
	// PUBLISHER_DATA_DIR lets a test copy run beside the real one without touching its data.
	if let Some(dir) = std::env::var_os("PUBLISHER_DATA_DIR").filter(|d| !d.is_empty()) {
		return PathBuf::from(dir);
	}
	let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
	base.join(APP_NAME)
}

#[derive(Default)]
struct Settings {
	demo_mode: bool,
	media_retention_hours: Option<f64>,
	max_upload_mb: Option<f64>,
	public_base_url: Option<String>,
	/// `relayUrl` overrides the built-in sign-in relay: an https address, or "" to turn it off.
	relay_url: Option<Option<String>>,
	close_hint_shown: bool,
	raw: serde_json::Value,
}

fn read_settings(file: &Path) -> Settings {
	let raw: serde_json::Value = std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).filter(|v: &serde_json::Value| v.is_object()).unwrap_or_else(|| serde_json::json!({}));
	Settings {
		demo_mode: raw["demoMode"].as_bool().unwrap_or(true),
		media_retention_hours: raw["mediaRetentionHours"].as_f64().filter(|n| *n > 0.0),
		max_upload_mb: raw["maxUploadMb"].as_f64().filter(|n| *n > 0.0),
		public_base_url: raw["publicBaseUrl"].as_str().filter(|s| s.starts_with("https://")).map(String::from),
		relay_url: raw["relayUrl"].as_str().map(str::trim).and_then(|s| {
			if s.is_empty() {
				Some(None)
			} else if s.starts_with("https://") {
				Some(Some(s.to_string()))
			} else {
				None
			}
		}),
		close_hint_shown: raw["closeHintShown"].as_bool().unwrap_or(false),
		raw,
	}
}

fn ask(handle: &AppHandle, kind: MessageDialogKind, text: &str, yes: &str, no: &str) -> bool {
	handle.dialog().message(text).title(APP_NAME).kind(kind).buttons(MessageDialogButtons::OkCancelCustom(yes.to_string(), no.to_string())).blocking_show()
}

fn tell(handle: &AppHandle, kind: MessageDialogKind, text: &str) {
	handle.dialog().message(text).title(APP_NAME).kind(kind).blocking_show();
}

fn fatal(handle: &AppHandle, log: &Logger, logs_dir: &Path, message: &str, detail: &str) {
	log.line(&format!("fatal: {message} {detail}"));
	if !ask(handle, MessageDialogKind::Error, &format!("{message}\n\n{detail}"), "Quit", "Show Logs in Explorer") {
		let _ = open::that(logs_dir);
	}
	QUITTING.store(true, Ordering::SeqCst);
	handle.exit(1);
}

fn show_window(handle: &AppHandle) {
	if let Some(w) = handle.get_webview_window("main") {
		let _ = w.unminimize();
		let _ = w.show();
		let _ = w.set_focus();
	}
}

/// Quit: if posts are still publishing, offer to keep running. Otherwise hand the jobs back to the
/// queue (marked "check with the platform first") so they resume on the next start.
fn request_quit(handle: &AppHandle) {
	let handle = handle.clone();
	std::thread::spawn(move || {
		if let Some(r) = RUNNING.get() {
			let n = jobs::active_jobs(&r.app);
			if n > 0 {
				let text = format!(
					"{n} post{} still publishing.\n\nPublishing only runs while Publisher is open and this PC is awake. If you quit now, unfinished posts pause and continue the next time you open Publisher. They are checked with each platform first, so nothing is uploaded twice.",
					if n > 1 { "s are" } else { " is" }
				);
				if ask(&handle, MessageDialogKind::Warning, &text, "Keep Running", "Quit and Resume Later") {
					return;
				}
			}
			QUITTING.store(true, Ordering::SeqCst);
			let paused = jobs::release_leases(&r.app, &r.owner);
			r.app.log.line(&format!("quitting: paused {paused} job(s); they resume on next start"));
		}
		QUITTING.store(true, Ordering::SeqCst);
		handle.exit(0);
	});
}

fn build_tray(handle: &AppHandle) -> tauri::Result<()> {
	let menu = MenuBuilder::new(handle)
		.text("open", "Open Publisher")
		.separator()
		.text("logs", "Show Logs in Explorer")
		.text("data", "Show Data Folder in Explorer")
		.text("inbox", "Show Inbox Folder in Explorer")
		.text("about", "About Publisher")
		.separator()
		.text("quit", "Quit Publisher")
		.build()?;
	let mut tray = TrayIconBuilder::with_id("main").tooltip(APP_NAME).menu(&menu).show_menu_on_left_click(false);
	if let Some(icon) = handle.default_window_icon() {
		tray = tray.icon(icon.clone());
	}
	tray.on_menu_event(|handle, event| match event.id().as_ref() {
		"open" => show_window(handle),
		"logs" => {
			if let Some(r) = RUNNING.get() {
				let _ = open::that_detached(&r.app.cfg.logs_dir);
			}
		}
		"data" => {
			if let Some(r) = RUNNING.get() {
				let _ = open::that_detached(&r.user_data);
			}
		}
		"inbox" => {
			if let Some(r) = RUNNING.get() {
				let dir = publisher_core::inbox::dir(&r.app);
				let _ = std::fs::create_dir_all(&dir);
				let _ = open::that_detached(&dir);
			}
		}
		"about" => {
			let handle = handle.clone();
			std::thread::spawn(move || {
				tell(
					&handle,
					MessageDialogKind::Info,
					&format!("Publisher {}\nFor personal use.\n\nPublishes one video to YouTube, Instagram Reels and TikTok.\nWindows build written in Rust (Tauri, WebView2).", env!("CARGO_PKG_VERSION")),
				);
			});
		}
		"quit" => request_quit(handle),
		_ => {}
	})
	.on_tray_icon_event(|tray, event| {
		if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
			show_window(tray.app_handle());
		}
	})
	.build(handle)?;
	Ok(())
}

fn create_window(handle: &AppHandle, origin: &str, nonce: &str) -> tauri::Result<()> {
	let entry: tauri::Url = format!("{origin}/api/desktop/enter?k={nonce}").parse().expect("valid local address");
	let allowed = origin.to_string();
	let window = WebviewWindowBuilder::new(handle, "main", WebviewUrl::External(entry))
		.title(APP_NAME)
		.inner_size(1240.0, 820.0)
		.min_inner_size(900.0, 620.0)
		.center()
		.initialization_script(server::bridge_script(origin))
		// Tauri's defaults, plus letting the finish sound play while the window is hidden in the tray.
		.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required")
		// Let the page handle dropped files itself (the upload box), as it does on the Mac.
		.disable_drag_drop_handler()
		// The window only ever shows the app. Anything else opens in the default browser.
		.on_navigation(move |url| {
			let u = url.as_str();
			if u == allowed || u.starts_with(&format!("{allowed}/")) || u == "about:blank" {
				return true;
			}
			if url.scheme() == "https" {
				let _ = open::that_detached(u);
			}
			false
		})
		.build()?;

	// Closing the window keeps the app (and its jobs) running in the tray.
	let w = window.clone();
	let handle = handle.clone();
	window.on_window_event(move |event| {
		if let WindowEvent::CloseRequested { api, .. } = event {
			if QUITTING.load(Ordering::SeqCst) {
				return;
			}
			api.prevent_close();
			let _ = w.hide();
			close_hint(&handle);
		}
	});
	Ok(())
}

/** The first time the window is closed, explain that the app is still running. */
fn close_hint(handle: &AppHandle) {
	let Some(r) = RUNNING.get() else { return };
	let mut s = read_settings(&r.settings_file);
	if s.close_hint_shown {
		return;
	}
	s.raw["closeHintShown"] = serde_json::Value::Bool(true);
	if s.raw.get("demoMode").is_none() {
		s.raw["demoMode"] = serde_json::Value::Bool(s.demo_mode);
	}
	let _ = std::fs::write(&r.settings_file, serde_json::to_string_pretty(&s.raw).unwrap_or_default());
	let handle = handle.clone();
	std::thread::spawn(move || {
		tell(&handle, MessageDialogKind::Info, "Publisher is still running in the notification area (the icons next to the clock), so posts can finish publishing.\n\nClick its icon to open the window again. Right-click it and choose Quit Publisher to stop.");
	});
}

fn boot(handle: AppHandle) {
	let user_data = user_data_dir();
	let data_dir = user_data.join("data");
	let logs_dir = user_data.join("logs");
	let settings_file = user_data.join("settings.json");
	let key_file = user_data.join("keys.json");
	let db_file = data_dir.join("app.db");
	for d in [&user_data, &logs_dir] {
		let _ = std::fs::create_dir_all(d);
	}
	let log = Logger::open(&logs_dir.join("main.log"));
	log.line(&format!("starting {APP_NAME} {} (Rust, {} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH));

	let args: Vec<String> = std::env::args().collect();
	let import_arg = args.iter().find_map(|a| a.strip_prefix("--import-from=")).map(PathBuf::from);
	let start_fresh = args.iter().any(|a| a == "--start-fresh");

	if !key_file.exists() {
		if db_file.exists() {
			return fatal(
				&handle,
				&log,
				&logs_dir,
				"Publisher found its database but not its encryption key.",
				&format!("It will not create a new key, because that would make your saved accounts unreadable. Restore {} from a backup, or move {} aside to start fresh.", key_file.display(), data_dir.display()),
			);
		}
		let mut source = import_arg;
		if source.is_none() && !start_fresh {
			let fresh = ask(
				&handle,
				MessageDialogKind::Info,
				"Welcome to Publisher\n\nDo you have a Publisher project folder from before (with a .env file and a data folder)? Publisher can copy its posts, settings and connected accounts. The original folder is left untouched.",
				"Start Fresh",
				"Import from Folder…",
			);
			if !fresh {
				source = handle.dialog().file().set_title("Choose the old Publisher project folder").blocking_pick_folder().and_then(|f| f.into_path().ok());
			}
		}
		let setup = match &source {
			Some(folder) => {
				keys::import_legacy(folder, &ImportTarget { data_dir: data_dir.clone(), settings_file: settings_file.clone(), key_file: key_file.clone() }).map(|report| log.line(&format!("import finished: {report}")))
			}
			None => std::fs::create_dir_all(&data_dir)
				.map_err(|e| e.to_string())
				.and_then(|_| keys::write_key_file(&key_file, &Keys { session_secret: crypto::b64(&crypto::random_bytes(32)), token_key: crypto::b64(&crypto::random_bytes(32)) }))
				.and_then(|_| std::fs::write(&settings_file, "{\n  \"demoMode\": true\n}").map_err(|e| e.to_string()))
				.map(|_| log.line("created new keys for a fresh start")),
		};
		if let Err(e) = setup {
			return fatal(&handle, &log, &logs_dir, "Publisher could not set up its encryption key.", &format!("{e}\n\nNothing was deleted or replaced."));
		}
	}
	let unlocked = keys::read_key_file(&key_file).and_then(|k| keys::token_key_bytes(&k.token_key).map(|bytes| (k, bytes)).ok_or_else(|| "The stored key has the wrong length.".to_string()));
	let (keys, token_key) = match unlocked {
		Ok(v) => v,
		Err(e) => return fatal(&handle, &log, &logs_dir, "Publisher could not unlock its encryption key.", &format!("{e}\n\nNothing was deleted or replaced.")),
	};
	let _ = std::fs::create_dir_all(data_dir.join("media"));

	let token = crypto::random_id(32);
	let nonce = crypto::random_id(24);
	for secret in [&keys.session_secret, &keys.token_key, &token, &nonce] {
		log.add_secret(secret);
	}

	// Port 8787 when it is free (sign-in redirects registered with the platforms point there), otherwise any free port.
	let listener = match std::net::TcpListener::bind(("127.0.0.1", 8787)).or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0))) {
		Ok(l) => l,
		Err(e) => return fatal(&handle, &log, &logs_dir, "Publisher could not start its local server.", &format!("{e}\n\nYour data is safe.")),
	};
	let port = listener.local_addr().map(|a| a.port()).unwrap_or(8787);
	if port != 8787 {
		log.line(&format!("port 8787 is busy; using {port}. Sign-in redirects that need a fixed port (Instagram, TikTok tunnels) must point here."));
	}
	let origin = format!("http://127.0.0.1:{port}");

	let settings = read_settings(&settings_file);
	let ffprobe = std::env::var_os("FFPROBE_PATH").map(PathBuf::from).or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("bin").join("ffprobe.exe")))).filter(|p| p.exists());
	let cfg = Config {
		version: env!("CARGO_PKG_VERSION").to_string(),
		port,
		app_url: origin.clone(),
		data_dir: data_dir.clone(),
		logs_dir: logs_dir.clone(),
		session_secret: keys.session_secret.clone(),
		token_key,
		desktop_token: token,
		demo_mode: settings.demo_mode,
		media_retention_hours: settings.media_retention_hours.unwrap_or(72.0),
		max_upload_bytes: (settings.max_upload_mb.unwrap_or(4096.0) * 1024.0 * 1024.0) as u64,
		public_base_url: settings.public_base_url,
		instagram_api_version: "v25.0".into(),
		tiktok_direct_post: false,
		ffprobe,
	};
	let conn = match db::open(Some(&db_file)) {
		Ok(c) => c,
		Err(e) => return fatal(&handle, &log, &logs_dir, "Publisher could not open its database.", &format!("{e}\n\nYour data was not changed. The logs explain the problem.")),
	};
	// Let Windows show this app's notifications under its own name and icon.
	let icon = user_data.join("notification-icon.ico");
	if !icon.exists() {
		let _ = std::fs::write(&icon, include_bytes!("../icons/icon.ico"));
	}
	if let Err(e) = toast::register(APP_NAME, &icon) {
		log.line(&format!("could not register for notifications: {e}"));
	}

	let mut endpoints = Endpoints::default();
	if let Some(relay) = settings.relay_url.clone() {
		endpoints.relay = relay;
	}
	match &endpoints.relay {
		Some(r) => log.line(&format!("sign-in service: {r}")),
		None => log.line("sign-in service: none (accounts connect with developer keys entered in the app)"),
	}
	let app = App::new(cfg, conn, endpoints, log);
	*app.enter_nonce.lock() = Some(nonce.clone());
	let _ = app.shell.set(Box::new(DesktopShell(handle.clone())));

	// Only one copy of the app runs, so jobs a previous run left mid-flight can be picked up now.
	let recovered = jobs::expire_stale_leases(&app);
	if recovered > 0 {
		app.log.line(&format!("found {recovered} job(s) interrupted last time; they will be checked with the platform first"));
	}

	let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().thread_name("publisher").build() {
		Ok(r) => RUNTIME.get_or_init(|| r),
		Err(e) => return fatal(&handle, &app.log, &logs_dir, "Publisher could not start its background services.", &e.to_string()),
	};
	let owner = runner::new_owner();
	{
		let app = app.clone();
		runtime.spawn(async move {
			let _ = listener.set_nonblocking(true);
			match tokio::net::TcpListener::from_std(listener) {
				Ok(l) => {
					app.log.line(&format!("[api] listening on http://127.0.0.1:{port}{}", if app.cfg.demo_mode { "  (DEMO MODE: publishing is simulated)" } else { "" }));
					if let Err(e) = axum_serve(l, app.clone()).await {
						app.log.line(&format!("[api] stopped: {e}"));
					}
				}
				Err(e) => app.log.line(&format!("[api] could not listen: {e}")),
			}
		});
	}
	{
		// If the worker loop ever ends unexpectedly it is started again; jobs it held are reclaimed by their leases.
		let (app, owner) = (app.clone(), owner.clone());
		runtime.spawn(async move {
			loop {
				let run = tokio::spawn(runner::worker_loop(app.clone(), owner.clone()));
				let outcome = run.await;
				if QUITTING.load(Ordering::SeqCst) {
					return;
				}
				app.log.line(&format!("[worker] stopped unexpectedly ({outcome:?}); restarting"));
				tokio::time::sleep(std::time::Duration::from_secs(2)).await;
			}
		});
	}

	{
		// The inbox folder turns dropped videos into drafts (same as the Mac app's ~/Movies/Publisher Inbox).
		let app = app.clone();
		runtime.spawn(async move { publisher_core::inbox::start(app) });
	}
	{
		// Phone access (off unless the owner turned it on): also listen on this PC's Wi-Fi address.
		let app = app.clone();
		runtime.spawn(async move {
			if let Some(problem) = publisher_core::phone::start(&app) {
				app.log.line(&format!("[phone] {problem}"));
			}
		});
	}

	let _ = RUNNING.set(Running { app: app.clone(), owner, user_data, settings_file });
	if let Err(e) = create_window(&handle, &origin, &nonce) {
		fatal(
			&handle,
			&app.log,
			&logs_dir,
			"Publisher could not open its window.",
			&format!("{e}\n\nPublisher needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11 and can be installed from Microsoft on Windows 10."),
		);
	}
}

async fn axum_serve(listener: tokio::net::TcpListener, app: Arc<App>) -> std::io::Result<()> {
	publisher_core::server::serve(listener, app).await
}

fn main() {
	let built = tauri::Builder::default()
		// One instance only, so two workers never compete. A second launch brings the window forward.
		.plugin(tauri_plugin_single_instance::init(|handle, _args, _cwd| show_window(handle)))
		.plugin(tauri_plugin_dialog::init())
		.setup(|app| {
			build_tray(app.handle())?;
			let handle = app.handle().clone();
			std::thread::Builder::new().name("boot".into()).spawn(move || boot(handle))?;
			Ok(())
		})
		.build(tauri::generate_context!());
	match built {
		Ok(app) => app.run(|_handle, event| {
			// Stay running with no window open: jobs continue in the background until Quit is chosen.
			if let RunEvent::ExitRequested { api, code, .. } = event {
				if code.is_none() && !QUITTING.load(Ordering::SeqCst) {
					api.prevent_exit();
				}
			}
		}),
		Err(e) => {
			let _ = std::fs::write(std::env::temp_dir().join("publisher-startup-error.txt"), e.to_string());
		}
	}
}
