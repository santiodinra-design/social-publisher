// Phone access (desktop app): use Publisher from an Android phone or iPhone while the computer does
// the work. Same design as windows/core/src/phone.rs.
//
// Off by default. When it is on, the server also listens on this computer's Wi-Fi address (same
// port), and the owner pairs a phone by scanning a QR code shown in the app window. The QR holds a
// one-use link (10 minutes). Opening it gives that phone its own random key in a cookie; only a hash
// is stored, and each phone can be removed on its own. Turning phone access off stops the Wi-Fi
// listener and refuses every phone key at once. With a public HTTPS address (the tunnel), the
// pairing link also works through it, so the phone keeps working away from home, over HTTPS.
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { config } from './config.js';
import { randomId } from './crypto.js';
import { getDb, now } from './db.js';
import { phoneAccess, saveSettings } from './settings.js';

export const COOKIE = 'sp_phone';
const PAIR_MS = 10 * 60_000;
const pairing = new Map<string, number>();
let listener: { server: http.Server; url: string } | null = null;

export const enabled = phoneAccess;
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('base64');

/** The phone behind this request, from its cookie (`<device id>.<key>`), while phone access is on. */
export function deviceOf(req: FastifyRequest): string | null {
	if (!enabled()) return null;
	const raw = String(req.cookies[COOKIE] ?? '');
	const dot = raw.indexOf('.');
	if (dot < 1) return null;
	const id = raw.slice(0, dot);
	const row = getDb().prepare('SELECT token_hash FROM devices WHERE id = ?').get(id) as { token_hash: string } | undefined;
	if (!row) return null;
	const a = Buffer.from(row.token_hash);
	const b = Buffer.from(hash(raw.slice(dot + 1)));
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
	const t = now();
	getDb().prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(t, id, t - 60_000);
	return id;
}

/** What a paired phone may not do: developer keys, connecting accounts, native pickers and folders, phone access itself. */
export function blocked(method: string, url: string) {
	if (url.startsWith('/api/phone')) return true;
	// Phones may read the preferences but not change them: Drafts only is what keeps a stolen phone
	// key (sniffed on Wi-Fi) from posting publicly.
	if (url.startsWith('/api/desktop/')) return !(url === '/api/desktop/prefs' && method === 'GET');
	if (/^\/api\/oauth\/[a-z]+\/(begin|start)$/.test(url)) return true;
	return url.startsWith('/api/setup') && method !== 'GET';
}

/** This computer's private network address (home Wi-Fi, or a Tailscale-style 100.64/10 address). */
export function lanIp(): string | null {
	const ok = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
	for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && ok(a.address)) return a.address;
	return null;
}

/** Starts the Wi-Fi listener when phone access is on. Resolves to a problem for the owner, if any. */
export function start(app: FastifyInstance): Promise<string | null> {
	if (!enabled() || listener) return Promise.resolve(null);
	const ip = lanIp();
	if (!ip) return Promise.resolve('This computer has no Wi-Fi or network address right now. Connect it to the same Wi-Fi as the phone.');
	// The same Fastify app answers, so every check (cookies, phone limits, CSRF) applies unchanged.
	const server = http.createServer((req, res) => app.routing(req, res));
	return new Promise((resolve) => {
		server.once('error', (e) => resolve(`Could not open ${ip}:${config.port} for phones: ${e.message}`));
		server.listen(config.port, ip, () => {
			listener = { server, url: `http://${ip}:${config.port}` };
			console.log(`[phone] phones can connect at ${listener.url}`);
			resolve(null);
		});
	});
}

export function stop() {
	listener?.server.close();
	listener = null;
}

const httpsUrl = () => (/^https:\/\//.test(config.publicBaseUrl) ? config.publicBaseUrl.replace(/\/$/, '') : null);

export function view(problem: string | null = null) {
	const devices = (getDb().prepare('SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at').all() as any[]).map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at ?? null }));
	return { enabled: enabled(), wifiUrl: listener?.url ?? null, httpsUrl: httpsUrl(), problem, devices };
}

export async function setEnabled(app: FastifyInstance, on: boolean) {
	saveSettings({ PHONE_ACCESS: on ? 'on' : null });
	if (!on) {
		stop();
		return view();
	}
	return view(await start(app));
}

export async function pair() {
	if (!enabled()) throw new Error('Turn on phone access first.');
	const base = listener?.url ?? httpsUrl();
	if (!base) throw new Error('Phones cannot reach this computer yet. Connect it to Wi-Fi, or set a public HTTPS address.');
	const secret = randomId(24);
	const exp = now() + PAIR_MS;
	for (const [k, e] of pairing) if (e < now()) pairing.delete(k);
	pairing.set(secret, exp);
	const url = `${base}/pair/${secret}`;
	const qr = await QRCode.toString(url, { type: 'svg', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
	const https = httpsUrl();
	return { url, awayUrl: listener && https ? `${https}/pair/${secret}` : null, qr, expiresAt: exp };
}

/** Uses up a pairing link and returns the new phone's cookie value, or null. */
export function redeem(secret: string, userAgent: string): string | null {
	if (!enabled()) return null;
	const exp = pairing.get(secret);
	pairing.delete(secret);
	if (!exp || exp < now()) return null;
	const id = randomId(9);
	const token = randomId(32);
	const ua = userAgent.toLowerCase();
	const kind = ua.includes('iphone') ? 'iPhone' : ua.includes('ipad') ? 'iPad' : ua.includes('android') ? 'Android phone' : 'Phone';
	const n = (getDb().prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
	const name = n === 0 ? kind : `${kind} ${n + 1}`;
	getDb().prepare('INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, name, hash(token), now(), now());
	console.log(`[phone] paired ${name}`);
	return `${id}.${token}`;
}

export const remove = (id: string) => getDb().prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
