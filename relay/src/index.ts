// Publisher sign-in relay: a small Cloudflare Worker that lets customers connect their accounts with
// one click, without creating developer apps of their own.
//
// What it does:
// - Holds the client secrets of the operator's YouTube, TikTok and Instagram apps. A desktop app
//   cannot keep a secret, so code exchange and token refresh happen here.
// - Owns the registered HTTPS redirect address. After sign-in it sends the browser straight back to
//   the Publisher app on the customer's own computer (http://127.0.0.1:<port>), and nowhere else.
// - Hosts Instagram videos for a short time. Instagram Login can only publish a Reel from a public
//   URL, so the app uploads the video here, Instagram downloads it, and the app deletes it. A cron
//   job removes anything older than 24 hours.
// - Serves the public home, Terms and Privacy pages that the platform reviews ask for.
//
// It stores no tokens and no accounts. Tokens pass through and are kept only on the customer's computer.
import { page } from './pages.js';

export interface Env {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	TIKTOK_CLIENT_KEY?: string;
	TIKTOK_CLIENT_SECRET?: string;
	INSTAGRAM_APP_ID?: string;
	INSTAGRAM_APP_SECRET?: string;
	INSTAGRAM_API_VERSION?: string;
	/** Random secret used to sign media links and media upload keys. */
	SIGNING_KEY?: string;
	/** Optional fixed origin (for example https://publisher.example.com) when the Worker sits behind a proxy. */
	PUBLIC_ORIGIN?: string;
	OPERATOR_NAME?: string;
	CONTACT_EMAIL?: string;
	MEDIA?: R2Bucket;
}

// Minimal R2 types, so the relay builds without extra packages.
export interface R2Bucket {
	get(key: string, options?: { range?: Headers | { offset?: number; length?: number; suffix?: number } }): Promise<R2ObjectBody | null>;
	head(key: string): Promise<R2Object | null>;
	delete(keys: string | string[]): Promise<void>;
	list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>;
	createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2MultipartUpload>;
	resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}
export interface R2Object {
	key: string;
	size: number;
	etag: string;
	httpEtag: string;
	uploaded: Date;
	httpMetadata?: { contentType?: string };
	range?: { offset?: number; length?: number; suffix?: number };
}
export interface R2ObjectBody extends R2Object {
	body: ReadableStream;
}
export interface R2MultipartUpload {
	uploadId: string;
	uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | string): Promise<{ partNumber: number; etag: string }>;
	complete(parts: { partNumber: number; etag: string }[]): Promise<R2Object>;
	abort(): Promise<void>;
}

type Platform = 'youtube' | 'tiktok' | 'instagram';
const PLATFORMS: Platform[] = ['youtube', 'tiktok', 'instagram'];

/** Parts sent to the media upload are this size (the last may be smaller). Workers accept up to 100 MB per request. */
export const PART_SIZE = 50 * 1024 * 1024;
/** Instagram accepts Reels up to 1 GB through the API. */
export const MAX_MEDIA = 1024 * 1024 * 1024;
/** Media links stay valid for 6 hours; objects are deleted after 24 hours at the latest. */
const LINK_SECONDS = 6 * 3600;
const KEEP_MS = 24 * 3600 * 1000;
// Videos, and the JPEG cover images Instagram can take for a Reel.
const MEDIA_TYPES = ['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png'];

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const TIKTOK = 'https://open.tiktokapis.com';
const IG_API = 'https://api.instagram.com';
const IG_GRAPH = 'https://graph.instagram.com';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (e) {
			// Never echo details that could include a token.
			console.error('relay error', e instanceof Error ? e.name : 'unknown');
			return json(502, { error: 'relay_error', error_description: 'The sign-in service had a problem. Try again in a minute.' });
		}
	},
	async scheduled(_event: unknown, env: Env): Promise<void> {
		await sweepMedia(env);
	},
};

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split('/').filter(Boolean);
	const method = request.method;

	if (method === 'GET' && (parts.length === 0 || (parts.length === 1 && ['terms', 'privacy'].includes(parts[0])))) {
		return html(200, page((parts[0] as 'terms' | 'privacy') ?? 'home', env));
	}
	if (method === 'GET' && url.pathname === '/health') return json(200, { ok: true, platforms: Object.fromEntries(PLATFORMS.map((p) => [p, enabled(env, p)])), media: Boolean(env.MEDIA && env.SIGNING_KEY) });

	const p = parts[1] as Platform;
	if (parts.length === 2 && PLATFORMS.includes(p)) {
		if (!enabled(env, p)) return parts[0] === 'start' || parts[0] === 'callback' ? html(503, page('notice', env, `${label(p)} sign-in is not available yet.`)) : json(503, { error: 'not_configured', error_description: `${label(p)} is not set up on the sign-in service.` });
		if (method === 'GET' && parts[0] === 'start') return start(url, env, p);
		if (method === 'GET' && parts[0] === 'callback') return callback(url, p, env);
		if (method === 'POST' && parts[0] === 'token') return token(request, env, p, origin(url, env));
		if (method === 'POST' && parts[0] === 'refresh') return refresh(request, env, p);
		if (method === 'POST' && parts[0] === 'revoke') return revoke(request, env, p);
	}

	if (parts[0] === 'media' || parts[0] === 'm') {
		if (!env.MEDIA || !env.SIGNING_KEY) return json(503, { error: 'not_configured', error_description: 'Video hosting is not set up on the sign-in service.' });
		if (method === 'POST' && parts.length === 1) return mediaCreate(request, env);
		if (method === 'PUT' && parts.length === 4 && parts[2] === 'parts') return mediaPart(request, env, parts[1], parts[3], url);
		if (method === 'POST' && parts.length === 3 && parts[2] === 'complete') return mediaComplete(request, env, parts[1], origin(url, env));
		if (method === 'DELETE' && parts.length === 2) return mediaDelete(request, env, parts[1], url);
		if ((method === 'GET' || method === 'HEAD') && parts[0] === 'm' && parts.length === 2) return mediaServe(request, env, parts[1], url);
	}
	return json(404, { error: 'not_found' });
}

// ---------- sign-in ----------

const label = (p: Platform) => ({ youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' })[p];

export function enabled(env: Env, p: Platform): boolean {
	if (p === 'youtube') return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
	if (p === 'tiktok') return Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
	return Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
}

const origin = (url: URL, env: Env) => (env.PUBLIC_ORIGIN || url.origin).replace(/\/$/, '');
const redirectUri = (base: string, p: Platform) => `${base}/callback/${p}`;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

/** A port the app can be listening on. Below 1024 needs admin rights, which the app never has. */
function validPort(v: string | null): number | null {
	if (!v || !/^\d{4,5}$/.test(v)) return null;
	const n = Number(v);
	return n >= 1024 && n <= 65535 ? n : null;
}

/**
 * Step 1: the app opens /start/<platform>?port=<its port>&state=<one-use value>[&challenge=<PKCE>] in the
 * browser. The port travels inside the platform's state, so the relay needs no storage.
 */
function start(url: URL, env: Env, p: Platform): Response {
	const port = validPort(url.searchParams.get('port'));
	const state = url.searchParams.get('state') ?? '';
	const challenge = url.searchParams.get('challenge');
	if (!port || !STATE.test(state) || (challenge !== null && !CHALLENGE.test(challenge))) return html(400, page('notice', env, 'This sign-in link is not valid. Start again from the Publisher app.'));
	const s = `${port}.${state}`;
	const back = redirectUri(origin(url, env), p);
	let to: string;
	if (p === 'youtube') {
		const q = new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID!,
			redirect_uri: back,
			response_type: 'code',
			scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
			access_type: 'offline',
			prompt: 'consent',
			include_granted_scopes: 'true',
			state: s,
		});
		if (challenge) q.set('code_challenge', challenge), q.set('code_challenge_method', 'S256');
		to = `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
	} else if (p === 'tiktok') {
		const q = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY!, scope: 'user.info.basic,user.info.stats,video.list,video.upload', response_type: 'code', redirect_uri: back, state: s });
		to = `https://www.tiktok.com/v2/auth/authorize/?${q}`;
	} else {
		const q = new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID!, redirect_uri: back, response_type: 'code', scope: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights', state: s });
		to = `https://www.instagram.com/oauth/authorize?${q}`;
	}
	return redirect(to);
}

/**
 * Step 2: the platform sends the browser here. Forward the code to the app on the customer's own
 * computer. The target is always 127.0.0.1, so a crafted state cannot send a code anywhere else.
 */
function callback(url: URL, p: Platform, env: Env): Response {
	const raw = url.searchParams.get('state') ?? '';
	const dot = raw.indexOf('.');
	const port = validPort(dot > 0 ? raw.slice(0, dot) : null);
	const state = dot > 0 ? raw.slice(dot + 1) : '';
	if (!port || !STATE.test(state)) return html(400, page('notice', env, 'This sign-in did not start from the Publisher app. Start again from the app.'));
	const q = new URLSearchParams({ state });
	for (const k of ['code', 'error', 'error_description', 'error_reason']) {
		const v = url.searchParams.get(k);
		if (v) q.set(k, v.slice(0, 2000));
	}
	return redirect(`http://127.0.0.1:${port}/api/oauth/${p}/callback?${q}`);
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
	if (Number(request.headers.get('content-length') ?? 0) > 16 * 1024) return null;
	try {
		const v = await request.json();
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}
const str = (v: unknown, max = 4096) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/** Passes the platform's answer through unchanged, so the app classifies errors exactly as before. */
async function relayed(res: Response): Promise<Response> {
	const text = await res.text();
	return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
}

const formBody = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

/** Step 3: the app sends the code (and its PKCE verifier) here; the relay adds the secret. */
async function token(request: Request, env: Env, p: Platform, base: string): Promise<Response> {
	const b = await body(request);
	const code = str(b?.code);
	const verifier = b?.verifier == null ? null : str(b.verifier, 128);
	if (!code || (b?.verifier != null && !verifier)) return json(400, { error: 'invalid_request', error_description: 'Missing code.' });
	const back = redirectUri(base, p);
	if (p === 'youtube') {
		const f: Record<string, string> = { code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: back, grant_type: 'authorization_code' };
		if (verifier) f.code_verifier = verifier;
		return relayed(await fetch(GOOGLE_TOKEN, formBody(f)));
	}
	if (p === 'tiktok') {
		return relayed(await fetch(`${TIKTOK}/v2/oauth/token/`, formBody({ client_key: env.TIKTOK_CLIENT_KEY!, client_secret: env.TIKTOK_CLIENT_SECRET!, code, grant_type: 'authorization_code', redirect_uri: back })));
	}
	// Instagram: swap the code for a 1-hour token, then that for a 60-day token, as the app did before.
	const short = await fetch(`${IG_API}/oauth/access_token`, formBody({ client_id: env.INSTAGRAM_APP_ID!, client_secret: env.INSTAGRAM_APP_SECRET!, grant_type: 'authorization_code', redirect_uri: back, code }));
	if (!short.ok) return relayed(short);
	const s = (await short.json()) as Record<string, unknown>;
	const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: env.INSTAGRAM_APP_SECRET!, access_token: String(s.access_token ?? '') });
	const long = await fetch(`${IG_GRAPH}/access_token?${q}`);
	if (!long.ok) return relayed(long);
	const l = (await long.json()) as Record<string, unknown>;
	return json(200, { access_token: l.access_token, token_type: l.token_type ?? 'bearer', expires_in: l.expires_in, permissions: s.permissions ?? null, user_id: s.user_id ?? null });
}

async function refresh(request: Request, env: Env, p: Platform): Promise<Response> {
	const rt = str((await body(request))?.refreshToken);
	if (!rt) return json(400, { error: 'invalid_request', error_description: 'Missing refresh token.' });
	if (p === 'youtube') return relayed(await fetch(GOOGLE_TOKEN, formBody({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, refresh_token: rt, grant_type: 'refresh_token' })));
	if (p === 'tiktok') return relayed(await fetch(`${TIKTOK}/v2/oauth/token/`, formBody({ client_key: env.TIKTOK_CLIENT_KEY!, client_secret: env.TIKTOK_CLIENT_SECRET!, grant_type: 'refresh_token', refresh_token: rt })));
	// Instagram tokens refresh without the app secret, directly from the app.
	return json(400, { error: 'unsupported', error_description: 'Instagram tokens are refreshed by the app.' });
}

async function revoke(request: Request, env: Env, p: Platform): Promise<Response> {
	const t = str((await body(request))?.token);
	if (!t) return json(400, { error: 'invalid_request' });
	if (p === 'tiktok') return relayed(await fetch(`${TIKTOK}/v2/oauth/revoke/`, formBody({ client_key: env.TIKTOK_CLIENT_KEY!, client_secret: env.TIKTOK_CLIENT_SECRET!, token: t })));
	return json(400, { error: 'unsupported', error_description: 'Revoke this platform from the app.' });
}

// ---------- Instagram video hosting ----------

const objectKey = (id: string) => `v/${id}`;
const ID = /^[a-f0-9]{32}$/;

async function hmac(env: Env, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SIGNING_KEY!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
	return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function same(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}
async function keyOk(request: Request, env: Env, id: string): Promise<boolean> {
	return ID.test(id) && same(request.headers.get('x-media-key') ?? '', await hmac(env, `media:${id}`));
}

/**
 * Starts an upload. Only someone holding a working Instagram token can upload, which keeps the
 * relay from becoming a free file host for strangers.
 */
async function mediaCreate(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get('authorization') ?? '';
	const ig = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!ig) return json(401, { error: 'unauthorized' });
	const me = await fetch(`${IG_GRAPH}/${env.INSTAGRAM_API_VERSION || 'v25.0'}/me?fields=user_id`, { headers: { authorization: `Bearer ${ig}` } });
	if (!me.ok) return json(401, { error: 'unauthorized', error_description: 'Instagram did not accept this sign-in. Reconnect the account.' });
	const b = await body(request);
	const size = Number(b?.size);
	if (!Number.isSafeInteger(size) || size <= 0) return json(400, { error: 'invalid_request', error_description: 'Missing size.' });
	if (size > MAX_MEDIA) return json(413, { error: 'too_large', error_description: 'Instagram accepts videos up to 1 GB.' });
	const type = MEDIA_TYPES.includes(String(b?.type)) ? String(b?.type) : 'video/mp4';
	const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
	const mpu = await env.MEDIA!.createMultipartUpload(objectKey(id), { httpMetadata: { contentType: type } });
	return json(200, { id, uploadId: mpu.uploadId, key: await hmac(env, `media:${id}`), partSize: PART_SIZE });
}

async function mediaPart(request: Request, env: Env, id: string, n: string, url: URL): Promise<Response> {
	if (!(await keyOk(request, env, id))) return json(403, { error: 'forbidden' });
	const uploadId = url.searchParams.get('uploadId');
	const part = Number(n);
	const length = Number(request.headers.get('content-length') ?? NaN);
	if (!uploadId || !Number.isInteger(part) || part < 1 || part > Math.ceil(MAX_MEDIA / PART_SIZE)) return json(400, { error: 'invalid_request' });
	if (!Number.isSafeInteger(length) || length <= 0 || length > PART_SIZE || !request.body) return json(400, { error: 'invalid_request', error_description: `Parts must be 1 byte to ${PART_SIZE} bytes, with a Content-Length.` });
	const done = await env.MEDIA!.resumeMultipartUpload(objectKey(id), uploadId).uploadPart(part, request.body);
	return json(200, { partNumber: done.partNumber, etag: done.etag });
}

async function mediaComplete(request: Request, env: Env, id: string, base: string): Promise<Response> {
	if (!(await keyOk(request, env, id))) return json(403, { error: 'forbidden' });
	const b = await body(request);
	const uploadId = str(b?.uploadId, 1024);
	const parts = Array.isArray(b?.parts) ? (b!.parts as { partNumber: unknown; etag: unknown }[]) : null;
	if (!uploadId || !parts?.length || parts.some((x) => !Number.isInteger(x?.partNumber) || typeof x?.etag !== 'string')) return json(400, { error: 'invalid_request' });
	const obj = await env.MEDIA!.resumeMultipartUpload(objectKey(id), uploadId).complete(parts as { partNumber: number; etag: string }[]);
	const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
	const sig = await hmac(env, `m:${id}:${exp}`);
	return json(200, { url: `${base}/m/${id}?exp=${exp}&sig=${sig}`, expiresAt: exp * 1000, size: obj.size });
}

async function mediaDelete(request: Request, env: Env, id: string, url: URL): Promise<Response> {
	if (!(await keyOk(request, env, id))) return json(403, { error: 'forbidden' });
	const uploadId = url.searchParams.get('uploadId');
	if (uploadId) await env.MEDIA!.resumeMultipartUpload(objectKey(id), uploadId).abort().catch(() => undefined);
	await env.MEDIA!.delete(objectKey(id));
	return json(200, { ok: true });
}

/** The signed link Instagram downloads from. Supports byte ranges. */
async function mediaServe(request: Request, env: Env, id: string, url: URL): Promise<Response> {
	const exp = Number(url.searchParams.get('exp'));
	const sig = url.searchParams.get('sig') ?? '';
	if (!ID.test(id) || !Number.isInteger(exp) || exp * 1000 < Date.now() || !same(sig, await hmac(env, `m:${id}:${exp}`))) return new Response('Link expired', { status: 403 });
	const headers = new Headers({ 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' });
	if (request.method === 'HEAD') {
		const h = await env.MEDIA!.head(objectKey(id));
		if (!h) return new Response(null, { status: 404 });
		headers.set('content-type', h.httpMetadata?.contentType ?? 'video/mp4');
		headers.set('content-length', String(h.size));
		headers.set('etag', h.httpEtag);
		return new Response(null, { status: 200, headers });
	}
	const ranged = request.headers.has('range');
	const obj = await env.MEDIA!.get(objectKey(id), ranged ? { range: request.headers } : undefined);
	if (!obj) return new Response('Not found', { status: 404 });
	headers.set('content-type', obj.httpMetadata?.contentType ?? 'video/mp4');
	headers.set('etag', obj.httpEtag);
	const r = obj.range;
	if (ranged && r) {
		const offset = r.suffix != null ? Math.max(0, obj.size - r.suffix) : (r.offset ?? 0);
		const length = r.suffix != null ? obj.size - offset : (r.length ?? obj.size - offset);
		headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
		headers.set('content-length', String(length));
		return new Response(obj.body, { status: 206, headers });
	}
	headers.set('content-length', String(obj.size));
	return new Response(obj.body, { status: 200, headers });
}

/** Hourly: delete hosted videos older than 24 hours (the app normally deletes them within minutes). */
export async function sweepMedia(env: Env): Promise<number> {
	if (!env.MEDIA) return 0;
	let cursor: string | undefined;
	let removed = 0;
	do {
		const page = await env.MEDIA.list({ prefix: 'v/', cursor, limit: 1000 });
		const old = page.objects.filter((o) => Date.now() - new Date(o.uploaded).getTime() > KEEP_MS).map((o) => o.key);
		if (old.length) await env.MEDIA.delete(old);
		removed += old.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return removed;
}

// ---------- responses ----------

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function html(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
}
function redirect(to: string): Response {
	return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
