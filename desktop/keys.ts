// Encryption keys for the desktop app, protected by the macOS Keychain through Electron safeStorage
// (async API; the sync one is deprecated in Electron 45). Plus the one-time import of an older project folder.
import { safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Keys = { sessionSecret: string; tokenKey: string };

/**
 * The async safeStorage API can answer "temporarily unavailable, please try again" while the
 * Keychain is still starting up (seen right after a relaunch). Retry that for about 15 seconds
 * before treating it as a real failure. Any other error is returned at once.
 */
async function withKeychain<T>(f: () => Promise<T>): Promise<T> {
	for (let i = 0; ; i++) {
		try {
			return await f();
		} catch (e: any) {
			if (!/temporarily unavailable|try again/i.test(String(e?.message ?? e)) || i >= 20) throw e;
			await new Promise((r) => setTimeout(r, 250 + i * 100));
		}
	}
}
type KeyFile = { v: 1; protectedBy: 'macOS Keychain (Electron safeStorage)'; sessionSecret: string; tokenKey: string; createdAt: string };

export async function writeKeyFile(file: string, k: Keys) {
	if (Buffer.from(k.tokenKey, 'base64').length !== 32) throw new Error('The encryption key must be 32 bytes.');
	const enc = async (s: string) => (await withKeychain(() => safeStorage.encryptStringAsync(s))).toString('base64');
	const body: KeyFile = { v: 1, protectedBy: 'macOS Keychain (Electron safeStorage)', sessionSecret: await enc(k.sessionSecret), tokenKey: await enc(k.tokenKey), createdAt: new Date().toISOString() };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export async function readKeyFile(file: string): Promise<Keys> {
	const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as KeyFile;
	if (raw.v !== 1) throw new Error('Unknown key file version.');
	const dec = async (s: string) => {
		const r = await withKeychain(() => safeStorage.decryptStringAsync(Buffer.from(s, 'base64')));
		return typeof r === 'string' ? r : (r as any).result;
	};
	try {
		const keys = { sessionSecret: await dec(raw.sessionSecret), tokenKey: await dec(raw.tokenKey) };
		if (Buffer.from(keys.tokenKey, 'base64').length !== 32) throw new Error('decrypted key has the wrong length');
		return keys;
	} catch (e: any) {
		throw new Error(`The Keychain refused to unlock Publisher's key (${e?.message ?? e}).`);
	}
}

function parseEnv(file: string) {
	const out: Record<string, string> = {};
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
	}
	return out;
}

/** Decrypts one stored value with the key, to prove key and database belong together. */
function keyMatches(db: DatabaseSync, keyB64: string) {
	const key = Buffer.from(keyB64, 'base64');
	const rows = [
		...(db.prepare("SELECT access_token AS v FROM accounts WHERE access_token LIKE 'v1.%' LIMIT 3").all() as { v: string }[]),
		...(db.prepare("SELECT value AS v FROM app_settings WHERE value LIKE 'v1.%' LIMIT 3").all() as { v: string }[]),
	];
	if (!rows.length) return 'nothing-encrypted-yet';
	for (const { v } of rows) {
		const [, iv, tag, data] = v.split('.');
		try {
			const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
			d.setAuthTag(Buffer.from(tag, 'base64'));
			Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]);
			return 'ok';
		} catch {}
	}
	return 'mismatch';
}

/**
 * Copies an older project folder (.env + data/) into the app's data folder.
 * Uses SQLite's VACUUM INTO for a consistent snapshot even if the old copy is running, copies the
 * videos, checks the key really opens the copied data, and only then stores the key in the Keychain.
 * The source folder is never modified.
 */
export async function importLegacy(source: string, o: { dataDir: string; settingsFile: string; keyFile: string; log: (s: string) => void }) {
	const envFile = path.join(source, '.env');
	const srcDb = path.join(source, 'data', 'app.db');
	if (!fs.existsSync(envFile) || !fs.existsSync(srcDb)) throw new Error(`${source} does not look like a Publisher project folder (it needs .env and data/app.db).`);
	const env = parseEnv(envFile);
	if (!env.TOKEN_ENCRYPTION_KEY || !env.SESSION_SECRET) throw new Error('The old .env has no TOKEN_ENCRYPTION_KEY or SESSION_SECRET, so its saved accounts could not be read.');

	const staging = `${o.dataDir}.importing`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(path.join(staging, 'media'), { recursive: true });
	const src = new DatabaseSync(srcDb, { readOnly: true });
	const target = path.join(staging, 'app.db');
	src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
	src.close();

	const db = new DatabaseSync(target);
	const check = db.prepare('PRAGMA integrity_check').get() as Record<string, string>;
	if (Object.values(check)[0] !== 'ok') throw new Error('The copied database failed its integrity check. Nothing was imported.');
	const match = keyMatches(db, env.TOKEN_ENCRYPTION_KEY);
	if (match === 'mismatch') throw new Error('The encryption key in the old .env does not open the old database. Nothing was imported.');
	const counts = Object.fromEntries(['posts', 'targets', 'accounts', 'media'].map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));

	// Videos: copy each file and repoint the database at the new location.
	const oldMedia = path.join(source, 'data', 'media');
	let copied = 0;
	const files = db.prepare('SELECT id, path FROM media WHERE deleted_at IS NULL').all() as { id: string; path: string }[];
	for (const f of files) {
		const from = fs.existsSync(f.path) ? f.path : path.join(oldMedia, path.basename(f.path));
		const to = path.join(o.dataDir, 'media', path.basename(f.path));
		if (fs.existsSync(from)) {
			fs.copyFileSync(from, path.join(staging, 'media', path.basename(f.path)));
			copied++;
		}
		db.prepare('UPDATE media SET path = ? WHERE id = ?').run(to, f.id);
	}
	db.close();

	// Keys go to the Keychain only after the data checked out. Then the staged folder becomes live.
	await writeKeyFile(o.keyFile, { sessionSecret: env.SESSION_SECRET, tokenKey: env.TOKEN_ENCRYPTION_KEY });
	fs.rmSync(o.dataDir, { recursive: true, force: true });
	fs.renameSync(staging, o.dataDir);
	fs.chmodSync(o.dataDir, 0o700);
	const settings = {
		demoMode: ['1', 'true', 'yes', 'on'].includes(String(env.DEMO_MODE ?? '').toLowerCase()),
		...(Number(env.MEDIA_RETENTION_HOURS) > 0 ? { mediaRetentionHours: Number(env.MEDIA_RETENTION_HOURS) } : {}),
		...(Number(env.MAX_UPLOAD_MB) > 0 ? { maxUploadMb: Number(env.MAX_UPLOAD_MB) } : {}),
		...(/^https:\/\//.test(env.PUBLIC_BASE_URL ?? '') ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}),
	};
	fs.writeFileSync(o.settingsFile, JSON.stringify(settings, null, 2));
	const skipped = ['GOOGLE_CLIENT_SECRET', 'INSTAGRAM_APP_SECRET', 'TIKTOK_CLIENT_SECRET'].filter((k) => env[k]);
	const report = { source, importedAt: new Date().toISOString(), keyCheck: match, ...counts, videosCopied: copied, videosListed: files.length, platformKeysInEnvNotImported: skipped };
	fs.writeFileSync(path.join(path.dirname(o.keyFile), 'import-report.json'), JSON.stringify(report, null, 2));
	o.log(`imported ${JSON.stringify(report)}`);
	return report;
}
