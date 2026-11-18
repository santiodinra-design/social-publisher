// Publisher desktop app: main process.
// Owns the window, the menu and the quit flow, keeps the encryption keys in the macOS Keychain
// (via safeStorage), and supervises two utility processes: the local API server and the publishing worker.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, safeStorage, session, shell, utilityProcess, type UtilityProcess } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { importLegacy, readKeyFile, writeKeyFile, type Keys } from './keys';

const APP_NAME = 'Publisher';
app.setName(APP_NAME);

// ---------- paths: everything the user owns lives outside the app bundle ----------
const userData = app.getPath('userData'); // ~/Library/Application Support/Publisher
const dataDir = path.join(userData, 'data');
const logsDir = path.join(userData, 'logs');
/** Where the owner's Claude sessions drop finished videos (the API process watches it). */
const inboxDir = path.join(app.getPath('home'), 'Movies', 'Publisher Inbox');
const settingsFile = path.join(userData, 'settings.json');
const res = (...p: string[]) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(app.getAppPath(), 'build', 'resources', ...p));
const bundled = (...p: string[]) => path.join(app.getAppPath(), ...p);
const FFPROBE = app.isPackaged ? res('bin', 'ffprobe') : path.join(app.getAppPath(), 'node_modules', '@ffprobe-installer', 'darwin-arm64', 'ffprobe');

// Private to this macOS user: the database holds encrypted tokens and the logs hold job details.
for (const d of [userData, dataDir, logsDir]) {
	fs.mkdirSync(d, { recursive: true });
	try {
		fs.chmodSync(d, 0o700);
	} catch {}
}

// ---------- logging (secrets redacted) ----------
const secrets: string[] = [];
function redact(s: string) {
	let out = s;
	for (const v of secrets) if (v && v.length >= 8) out = out.split(v).join('[redacted]');
	return out
		.replace(/(Bearer\s+)[\w.\-~+/=]+/gi, '$1[redacted]')
		.replace(/((?:access|refresh)_token|client_secret|code_verifier|code)=([^&\s"]+)/gi, '$1=[redacted]')
		.replace(/("(?:access_token|refresh_token|client_secret|password)"\s*:\s*")[^"]*/gi, '$1[redacted]');
}
function logger(name: string) {
	const file = path.join(logsDir, `${name}.log`);
	try {
		if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
	} catch {}
	const stream = fs.createWriteStream(file, { flags: 'a' });
	return (line: string) => {
		for (const l of String(line).split('\n')) if (l.trim()) stream.write(`${new Date().toISOString()} ${redact(l)}\n`);
	};
}
const log = logger('main');
process.on('uncaughtException', (e) => log(`uncaught: ${e?.stack ?? e}`));

// ---------- one instance only, so two workers never compete ----------
if (!app.requestSingleInstanceLock()) {
	app.quit();
	process.exit(0);
}
app.on('second-instance', () => showWindow());

// ---------- settings (non-secret) ----------
type Settings = { demoMode: boolean; mediaRetentionHours?: number; maxUploadMb?: number; publicBaseUrl?: string };
function readSettings(): Settings {
	try {
		return { demoMode: true, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
	} catch {
		return { demoMode: true };
	}
}

// ---------- services ----------
type Svc = { name: 'api' | 'worker'; proc: UtilityProcess | null; state: 'starting' | 'running' | 'stopped' | 'crashed'; restarts: number[] };
const svcs: Record<'api' | 'worker', Svc> = { api: { name: 'api', proc: null, state: 'stopped', restarts: [] }, worker: { name: 'worker', proc: null, state: 'stopped', restarts: [] } };
let port = 0;
let origin = '';
let token = '';
let keys: Keys | null = null;
let quitting = false;
let quitConfirmed = false;
let win: BrowserWindow | null = null;

async function portFree(p: number) {
	return new Promise<boolean>((resolve) => {
		const s = net.createServer();
		s.once('error', () => resolve(false));
		s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
	});
}
async function freePort() {
	return new Promise<number>((resolve, reject) => {
		const s = net.createServer();
		s.once('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const p = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(p));
		});
	});
}

function serviceEnv(): Record<string, string> {
	const s = readSettings();
	const env: Record<string, string> = {
		SP_DESKTOP: '1',
		DESKTOP_TOKEN: token,
		SESSION_SECRET: keys!.sessionSecret,
		TOKEN_ENCRYPTION_KEY: keys!.tokenKey,
		DATA_DIR: dataDir,
		INBOX_DIR: inboxDir,
		API_PORT: String(port),
		APP_URL: origin,
		UI_DIST: bundled('dist'),
		FFPROBE_PATH: FFPROBE,
		DEMO_MODE: s.demoMode ? 'true' : 'false',
		NODE_ENV: 'production',
	};
	if (s.mediaRetentionHours) env.MEDIA_RETENTION_HOURS = String(s.mediaRetentionHours);
	if (s.maxUploadMb) env.MAX_UPLOAD_MB = String(s.maxUploadMb);
	if (s.publicBaseUrl) env.PUBLIC_BASE_URL = s.publicBaseUrl;
	return env;
}

/** Starts one service and resolves when it reports ready. Secrets go over the private message port, not argv or env. */
function start(name: 'api' | 'worker'): Promise<void> {
	const svc = svcs[name];
	const write = logger(name);
	svc.state = 'starting';
	const proc = utilityProcess.fork(bundled('dist-desktop', `${name}-entry.mjs`), [], { stdio: 'pipe', serviceName: `Publisher ${name === 'api' ? 'API' : 'Worker'}` });
	svc.proc = proc;
	proc.stdout?.on('data', (d) => write(String(d)));
	proc.stderr?.on('data', (d) => write(String(d).replace(/.*ExperimentalWarning: SQLite.*\n?|.*--trace-warnings.*\n?/g, '')));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`The ${name} did not start within 30 seconds.`)), 30_000);
		proc.on('spawn', () => proc.postMessage({ type: 'start', env: serviceEnv() }));
		proc.on('message', (m: any) => {
			if (m?.type === 'ready') {
				clearTimeout(timer);
				svc.state = 'running';
				log(`${name} ready`);
				resolve();
			} else if (m?.type === 'notice' && name === 'worker') {
				announce(m.notice);
			} else if (m?.type === 'fatal') {
				clearTimeout(timer);
				reject(new Error(String(m.message ?? 'failed to start')));
			}
		});
		proc.on('exit', (code) => {
			clearTimeout(timer);
			const wasRunning = svc.state === 'running';
			svc.proc = null;
			svc.state = quitting ? 'stopped' : 'crashed';
			log(`${name} exited with code ${code}`);
			if (!wasRunning) reject(new Error(`The ${name} stopped while starting (code ${code}).`));
			else if (!quitting) supervise(name);
		});
	});
}

/** Restarts a crashed service with backoff; after repeated crashes, tells the user what to do. */
async function supervise(name: 'api' | 'worker') {
	const svc = svcs[name];
	const t = Date.now();
	svc.restarts = svc.restarts.filter((x) => t - x < 120_000).concat(t);
	if (svc.restarts.length > 4) {
		const r = await dialog.showMessageBox({
			type: 'error',
			message: `Publisher's ${name === 'api' ? 'backend' : 'background worker'} keeps stopping.`,
			detail: 'Publishing is paused. Unfinished posts are kept and continue after a restart. The logs show what went wrong.',
			buttons: ['Reveal Logs in Finder', 'Try Again', 'Quit'],
			defaultId: 1,
		});
		if (r.response === 0) shell.openPath(logsDir);
		if (r.response === 2) return app.quit();
		svc.restarts = [];
	}
	await new Promise((r) => setTimeout(r, 1000 * 2 ** Math.min(svc.restarts.length - 1, 4)));
	if (quitting) return;
	try {
		await start(name);
		if (name === 'api') win?.webContents.reload();
	} catch (e: any) {
		log(`restart of ${name} failed: ${e.message}`);
		supervise(name);
	}
}

/** A post finished: a macOS notification plus the app's finish sound (played by the page, even while hidden). */
function announce(n: { postId?: string; title?: string; body?: string; ok?: boolean; copy?: string }) {
	if (!n || typeof n.title !== 'string') return;
	// TikTok drafts cannot carry a caption, so it goes on the clipboard (Universal Clipboard reaches the iPhone).
	if (typeof n.copy === 'string' && n.copy.trim()) clipboard.writeText(n.copy.slice(0, 5000));
	const ok = n.ok !== false;
	win?.webContents.executeJavaScript(`window.__publisherFinished && window.__publisherFinished({ ok: ${ok} })`).catch(() => undefined);
	if (!Notification.isSupported()) return;
	const note = new Notification({ title: n.title.slice(0, 120), body: String(n.body ?? '').slice(0, 240), silent: true });
	note.on('click', () => {
		showWindow();
		win?.webContents.executeJavaScript("history.pushState(null, '', '/history'); dispatchEvent(new PopStateEvent('popstate'))").catch(() => undefined);
	});
	note.show();
}

async function stopServices() {
	const w = svcs.worker.proc;
	if (w) {
		// Ask the worker to hand its jobs back (marked to check first), then make sure it is gone.
		const exited = new Promise<void>((r) => w.once('exit', () => r()));
		w.postMessage({ type: 'stop' });
		await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
		svcs.worker.proc?.kill();
	}
	svcs.api.proc?.kill();
	await new Promise((r) => setTimeout(r, 300));
}

// ---------- window ----------
function createWindow() {
	win = new BrowserWindow({
		width: 1240,
		height: 820,
		minWidth: 900,
		minHeight: 620,
		title: APP_NAME,
		backgroundColor: '#0c0c0d',
		show: false,
		webPreferences: {
			preload: bundled('dist-desktop', 'preload.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webviewTag: false,
			spellcheck: false,
			devTools: !app.isPackaged,
			// Let the finish sound play while the window is closed (hidden).
			backgroundThrottling: false,
		},
	});
	win.once('ready-to-show', () => win?.show());
	// Keep the app (and its jobs) running when the window closes, like other Mac apps.
	win.on('close', (e) => {
		if (!quitting) {
			e.preventDefault();
			win?.hide();
		}
	});
	win.on('closed', () => (win = null));
	const wc = win.webContents;
	wc.setWindowOpenHandler(({ url }) => {
		if (/^https:\/\//i.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
	wc.on('will-navigate', (e, url) => {
		if (!url.startsWith(`${origin}/`) && url !== origin) {
			e.preventDefault();
			if (/^https:\/\//i.test(url)) shell.openExternal(url);
		}
	});
	wc.on('will-attach-webview', (e) => e.preventDefault());
	win.loadURL(`${origin}/`);
}

function showWindow() {
	if (!origin) return;
	if (!win) createWindow();
	else {
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	}
}

// ---------- IPC (only from our own page) ----------
const fromApp = (e: Electron.IpcMainInvokeEvent) => {
	const u = e.senderFrame?.url ?? '';
	return Boolean(origin) && (u === origin || u.startsWith(`${origin}/`)) && e.sender === win?.webContents;
};
const SIGN_IN_HOSTS = new Set(['accounts.google.com', 'www.instagram.com', 'api.instagram.com', 'www.tiktok.com']);
const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

function registerIpc() {
	ipcMain.handle('open-external', async (e, url: unknown) => {
		if (!fromApp(e) || typeof url !== 'string' || url.length > 4000) return false;
		let u: URL;
		try {
			u = new URL(url);
		} catch {
			return false;
		}
		if (u.protocol !== 'https:' || !SIGN_IN_HOSTS.has(u.hostname)) return false;
		await shell.openExternal(u.toString());
		return true;
	});
	ipcMain.handle('reveal-logs', async (e) => {
		if (fromApp(e)) await shell.openPath(logsDir);
	});
	ipcMain.handle('reveal-inbox', async (e) => {
		if (!fromApp(e)) return;
		fs.mkdirSync(inboxDir, { recursive: true });
		await shell.openPath(inboxDir);
	});
	ipcMain.handle('services', async (e) => {
		if (!fromApp(e)) return null;
		return { version: app.getVersion(), api: svcs.api.state, worker: svcs.worker.state, logsDir, dataDir, port };
	});
	ipcMain.handle('pick-video', async (e) => {
		if (!fromApp(e) || !win) return { canceled: true };
		const r = await dialog.showOpenDialog(win, { title: 'Choose a video', properties: ['openFile'], filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm'] }] });
		if (r.canceled || !r.filePaths[0]) return { canceled: true };
		const file = r.filePaths[0];
		const name = path.basename(file);
		const ext = name.split('.').pop()?.toLowerCase() ?? '';
		if (!MIME[ext]) return { canceled: false, error: 'Only MP4, MOV or WebM videos can be published.' };
		const size = fs.statSync(file).size;
		let sent = 0;
		let last = 0;
		const src = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
		src.on('data', (c) => {
			sent += c.length;
			const now = Date.now();
			if (now - last > 120) {
				last = now;
				e.sender.send('upload-progress', sent / size);
			}
		});
		try {
			const resp = await fetch(`${origin}/api/media`, {
				method: 'PUT',
				headers: { 'Content-Type': MIME[ext], 'Content-Length': String(size), 'X-Filename': encodeURIComponent(name), 'X-Requested-With': 'social-publisher', Cookie: `sp_desktop=${token}` },
				body: Readable.toWeb(src) as any,
				duplex: 'half',
			} as RequestInit);
			const data: any = await resp.json().catch(() => ({}));
			if (!resp.ok) return { canceled: false, error: data.error ?? `Upload failed (${resp.status})` };
			e.sender.send('upload-progress', 1);
			return { canceled: false, media: data, filename: name, size };
		} catch (err: any) {
			log(`upload failed: ${err?.message ?? err}`);
			return { canceled: false, error: 'The upload to the local server failed. Try again.' };
		}
	});
}

// ---------- menu ----------
function buildMenu() {
	app.setAboutPanelOptions({
		applicationName: APP_NAME,
		applicationVersion: app.getVersion(),
		version: `Electron ${process.versions.electron}`,
		credits: 'Includes ffprobe from FFmpeg 4.4.1 under the LGPL 2.1 (see Publisher.app/Contents/Resources/licenses).',
		copyright: 'For personal use.',
	});
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ role: 'appMenu' },
			{ role: 'editMenu' },
			{
				label: 'View',
				submenu: [{ role: 'reload' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const]), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
			},
			{ role: 'windowMenu' },
			{
				role: 'help',
				submenu: [
					{ label: 'Reveal Logs in Finder', click: () => shell.openPath(logsDir) },
					{ label: 'Reveal Inbox Folder in Finder', click: () => (fs.mkdirSync(inboxDir, { recursive: true }), shell.openPath(inboxDir)) },
					{ label: 'Reveal Data Folder in Finder', click: () => shell.openPath(userData) },
				],
			},
		]),
	);
}

// ---------- quit: offer to keep jobs running ----------
async function activeJobs(): Promise<number> {
	if (!origin || svcs.api.state !== 'running') return 0;
	try {
		const r = await fetch(`${origin}/api/status`, { headers: { Cookie: `sp_desktop=${token}` } });
		return ((await r.json()) as { activeJobs?: number }).activeJobs ?? 0;
	} catch {
		return 0;
	}
}

app.on('before-quit', async (e) => {
	if (quitConfirmed) return;
	e.preventDefault();
	const n = await activeJobs();
	if (n > 0) {
		const r = await dialog.showMessageBox({
			type: 'question',
			message: `${n} post${n > 1 ? 's are' : ' is'} still publishing.`,
			detail: 'Publishing only runs while Publisher is open and the Mac is awake. If you quit now, unfinished posts pause and continue the next time you open Publisher. They are checked with each platform first, so nothing is uploaded twice.',
			buttons: ['Keep Running', 'Quit and Resume Later'],
			defaultId: 0,
			cancelId: 0,
		});
		if (r.response === 0) return;
	}
	quitConfirmed = true;
	quitting = true;
	await stopServices();
	app.quit();
});

app.on('window-all-closed', () => {
	/* stay running: jobs continue in the background */
});
app.on('activate', () => showWindow());

// ---------- startup ----------
async function fatal(message: string, detail: string) {
	log(`fatal: ${message} ${detail}`);
	const r = await dialog.showMessageBox({ type: 'error', message, detail, buttons: ['Quit', 'Reveal Logs in Finder'], defaultId: 0 });
	if (r.response === 1) await shell.openPath(logsDir);
	quitConfirmed = true;
	quitting = true;
	await stopServices();
	app.exit(1);
}

async function boot() {
	await app.whenReady();
	buildMenu();
	registerIpc();
	session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
	log(`starting ${APP_NAME} ${app.getVersion()} (Electron ${process.versions.electron}, Node ${process.versions.node})`);

	if (!safeStorage.isAsyncEncryptionAvailable()) {
		return fatal('The macOS Keychain is not available.', 'Publisher keeps its encryption key in your Keychain. Unlock your login keychain (Keychain Access) and open Publisher again.');
	}

	// Optional one-time import from an existing project folder (development copy).
	const importArg = process.argv.find((a) => a.startsWith('--import-from='))?.slice('--import-from='.length);
	const keyFile = path.join(userData, 'keys.json');
	const dbFile = path.join(dataDir, 'app.db');
	try {
		if (!fs.existsSync(keyFile)) {
			if (fs.existsSync(dbFile)) {
				return fatal('Publisher found its database but not its encryption key.', `It will not create a new key, because that would make your saved accounts unreadable. Restore ${keyFile} from a backup, or move ${dataDir} aside to start fresh.`);
			}
			let source = importArg;
			if (!source) {
				const r = await dialog.showMessageBox({
					type: 'question',
					message: 'Welcome to Publisher',
					detail: 'Do you have a Publisher project folder from before (with a .env file and a data folder)? Publisher can copy its posts, settings and connected accounts. The original folder is left untouched.',
					buttons: ['Start Fresh', 'Import from Folder…'],
					defaultId: 0,
				});
				if (r.response === 1) {
					const pick = await dialog.showOpenDialog({ title: 'Choose the old Publisher project folder', properties: ['openDirectory'] });
					source = pick.canceled ? undefined : pick.filePaths[0];
				}
			}
			if (source) {
				const report = await importLegacy(source, { dataDir, settingsFile, keyFile, log });
				log(`import finished: ${JSON.stringify(report)}`);
			} else {
				fs.mkdirSync(dataDir, { recursive: true });
				await writeKeyFile(keyFile, { sessionSecret: crypto.randomBytes(32).toString('base64'), tokenKey: crypto.randomBytes(32).toString('base64') });
				fs.writeFileSync(settingsFile, JSON.stringify({ demoMode: true }, null, 2));
				log('created new keys for a fresh start');
			}
		}
		keys = await readKeyFile(keyFile);
	} catch (e: any) {
		return fatal('Publisher could not unlock or set up its encryption key.', `${e?.message ?? e}\n\nNothing was deleted or replaced. If macOS asked for Keychain access, choose Allow (or Always Allow) and open Publisher again.`);
	}
	secrets.push(keys.sessionSecret, keys.tokenKey);

	token = crypto.randomBytes(32).toString('base64url');
	secrets.push(token);
	port = (await portFree(8787)) ? 8787 : await freePort();
	if (port !== 8787) log(`port 8787 is busy; using ${port}. Sign-in redirects that need a fixed port (Instagram, TikTok tunnels) must point here.`);
	origin = `http://127.0.0.1:${port}`;
	// The window's cookie jar holds the per-launch key; the API refuses requests without it.
	await session.defaultSession.cookies.set({ url: origin, name: 'sp_desktop', value: token, httpOnly: true, sameSite: 'strict' });

	try {
		await start('api');
		await start('worker');
	} catch (e: any) {
		return fatal('Publisher could not start its background services.', `${e?.message ?? e}\n\nYour data is safe. The logs explain the problem.`);
	}
	createWindow();
}

boot();
