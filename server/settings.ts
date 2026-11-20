// Platform app keys entered in the app. Stored encrypted; secrets are never sent back to the browser.
// Values saved here take priority over the same names in .env, and apply without a restart.
import { config, overrides, redirectUri } from './config.js';
import { getDb, now, type Platform } from './db.js';
import { open, seal } from './crypto.js';

export const FIELDS: Record<Platform, { id: string; secret: string; idLabel: string; secretLabel: string }> = {
	youtube: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET', idLabel: 'Client ID', secretLabel: 'Client secret' },
	instagram: { id: 'INSTAGRAM_APP_ID', secret: 'INSTAGRAM_APP_SECRET', idLabel: 'App ID', secretLabel: 'App secret' },
	tiktok: { id: 'TIKTOK_CLIENT_KEY', secret: 'TIKTOK_CLIENT_SECRET', idLabel: 'Client key', secretLabel: 'Client secret' },
};
const ALLOWED = new Set([...Object.values(FIELDS).flatMap((f) => [f.id, f.secret]), 'PUBLIC_BASE_URL', 'NOTIFY', 'INSTAGRAM_CONFIG_ID', 'INSTAGRAM_LOGIN', 'DRAFTS_ONLY', 'PHONE_ACCESS']);

let cache: { at: number; values: Map<string, string> } | null = null;

function load(): Map<string, string> {
	if (cache && Date.now() - cache.at < 3000) return cache.values;
	const values = new Map<string, string>();
	try {
		for (const r of getDb().prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[]) {
			const v = open(r.value);
			if (v) values.set(r.key, v);
		}
	} catch {
		// Table not ready yet; fall back to .env only.
	}
	cache = { at: Date.now(), values };
	return values;
}

overrides.get = (key: string) => load().get(key);

/** Drafts only (on unless the owner turned it off): nothing Publisher sends can go public by itself. */
export const draftsOnly = () => overrides.get('DRAFTS_ONLY') !== 'off';

/** Phone access (off unless the owner turned it on): paired phones may use the desktop app over Wi-Fi. */
export const phoneAccess = () => overrides.get('PHONE_ACCESS') === 'on';

export function saveSettings(values: Record<string, string | null>) {
	const db = getDb();
	for (const [k, v] of Object.entries(values)) {
		if (!ALLOWED.has(k)) throw new Error(`Unknown setting ${k}`);
		if (v == null || v === '') db.prepare('DELETE FROM app_settings WHERE key = ?').run(k);
		else db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(k, seal(v.trim()), now());
	}
	cache = null;
}

const mask = (v: string) => (v.length <= 10 ? `${v.slice(0, 2)}…` : `${v.slice(0, 6)}…${v.slice(-4)}`);

/** Safe summary for the browser: whether keys exist, where they came from, a masked ID. Never the secret. */
export function setupView() {
	const saved = load();
	return {
		appUrl: config.appUrl,
		publicBaseUrl: { value: config.publicBaseUrl || null, source: saved.has('PUBLIC_BASE_URL') ? 'app' : process.env.PUBLIC_BASE_URL ? 'env' : null },
		platforms: Object.fromEntries(
			(Object.keys(FIELDS) as Platform[]).map((p) => {
				const f = FIELDS[p];
				const id = saved.get(f.id) ?? process.env[f.id] ?? '';
				const secret = saved.get(f.secret) ?? process.env[f.secret] ?? '';
				return [p, {
					configured: Boolean(id && secret),
					source: saved.has(f.id) || saved.has(f.secret) ? 'app' : id ? 'env' : null,
					idPreview: id ? mask(id) : null,
					hasSecret: Boolean(secret),
					redirectUri: redirectUri(p),
					idLabel: f.idLabel,
					secretLabel: f.secretLabel,
					...(p === 'instagram' ? { loginMode: (saved.get('INSTAGRAM_CONFIG_ID') ?? process.env.INSTAGRAM_CONFIG_ID) ? 'unified' : (saved.get('INSTAGRAM_LOGIN') ?? process.env.INSTAGRAM_LOGIN) === 'facebook' ? 'facebook' : 'instagram', configPreview: (saved.get('INSTAGRAM_CONFIG_ID') ?? process.env.INSTAGRAM_CONFIG_ID) ? mask(saved.get('INSTAGRAM_CONFIG_ID') ?? process.env.INSTAGRAM_CONFIG_ID ?? '') : null } : {}),
				}];
			}),
		),
	};
}

/** Light format checks that catch common copy-paste mistakes. */
export function checkKeys(p: Platform, id: string, secret: string): { field: string; message: string }[] {
	const out: { field: string; message: string }[] = [];
	const i = id.trim();
	const s = secret.trim();
	if (!i) out.push({ field: 'id', message: `Paste the ${FIELDS[p].idLabel}.` });
	if (!s) out.push({ field: 'secret', message: `Paste the ${FIELDS[p].secretLabel}.` });
	if (/\s/.test(i) || /\s/.test(s)) out.push({ field: 'id', message: 'Remove spaces or line breaks from the pasted value.' });
	if (p === 'youtube' && i && !i.endsWith('.apps.googleusercontent.com')) out.push({ field: 'id', message: 'A Google client ID ends in .apps.googleusercontent.com.' });
	if (p === 'youtube' && i && s && s === i) out.push({ field: 'secret', message: 'This is the client ID again. Paste the client secret.' });
	if (p === 'instagram' && i && !/^\d{6,}$/.test(i)) out.push({ field: 'id', message: 'The app ID is a number.' });
	return out;
}

/** Tests swap databases; drop cached values with them. */
export function resetSettingsCache() {
	cache = null;
}
