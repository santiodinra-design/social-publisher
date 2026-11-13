import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { PART_SIZE, sweepMedia, type Env, type R2Bucket, type R2Object } from '../src/index.js';

/** An in-memory stand-in for an R2 bucket, enough for multipart uploads, ranges and listing. */
function fakeBucket() {
	const objects = new Map<string, { data: Uint8Array; type: string; uploaded: Date }>();
	const uploads = new Map<string, { key: string; type: string; parts: Map<number, Uint8Array> }>();
	const meta = (key: string, o: { data: Uint8Array; type: string; uploaded: Date }): R2Object => ({ key, size: o.data.length, etag: 'e', httpEtag: '"e"', uploaded: o.uploaded, httpMetadata: { contentType: o.type } });
	const read = async (v: ReadableStream | ArrayBuffer | string) => new Uint8Array(typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer());
	const bucket: R2Bucket = {
		async get(key, opts) {
			const o = objects.get(key);
			if (!o) return null;
			let range: R2Object['range'];
			let data = o.data;
			const h = opts?.range instanceof Headers ? opts.range.get('range') : null;
			const m = h?.match(/^bytes=(\d+)-(\d*)$/);
			if (m) {
				const start = Number(m[1]);
				const end = m[2] ? Number(m[2]) : o.data.length - 1;
				range = { offset: start, length: end - start + 1 };
				data = o.data.slice(start, end + 1);
			}
			return { ...meta(key, o), range, body: new Response(data as unknown as BodyInit).body! };
		},
		async head(key) {
			const o = objects.get(key);
			return o ? meta(key, o) : null;
		},
		async delete(keys) {
			for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
		},
		async list(opts) {
			return { objects: [...objects.entries()].filter(([k]) => k.startsWith(opts?.prefix ?? '')).map(([k, o]) => meta(k, o)), truncated: false };
		},
		async createMultipartUpload(key, opts) {
			const uploadId = `u${uploads.size + 1}`;
			uploads.set(uploadId, { key, type: opts?.httpMetadata?.contentType ?? 'application/octet-stream', parts: new Map() });
			return bucket.resumeMultipartUpload(key, uploadId);
		},
		resumeMultipartUpload(key, uploadId) {
			return {
				uploadId,
				async uploadPart(n, v) {
					const u = uploads.get(uploadId);
					if (!u || u.key !== key) throw new Error('no such upload');
					u.parts.set(n, await read(v));
					return { partNumber: n, etag: `etag-${n}` };
				},
				async complete(parts) {
					const u = uploads.get(uploadId)!;
					const chunks = parts.map((p) => u.parts.get(p.partNumber)!);
					const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
					let at = 0;
					for (const c of chunks) data.set(c, at), (at += c.length);
					objects.set(key, { data, type: u.type, uploaded: new Date() });
					uploads.delete(uploadId);
					return meta(key, objects.get(key)!);
				},
				async abort() {
					uploads.delete(uploadId);
				},
			};
		},
	};
	return { bucket, objects };
}

const env = (extra: Partial<Env> = {}): Env => ({
	GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com',
	GOOGLE_CLIENT_SECRET: 'g-secret',
	TIKTOK_CLIENT_KEY: 'tt-key',
	TIKTOK_CLIENT_SECRET: 'tt-secret',
	INSTAGRAM_APP_ID: '123456789',
	INSTAGRAM_APP_SECRET: 'ig-secret',
	SIGNING_KEY: 'test-signing-key-0123456789abcdef',
	OPERATOR_NAME: 'Test Operator',
	CONTACT_EMAIL: 'help@example.test',
	...extra,
});

const BASE = 'https://relay.example.test';
const call = (e: Env, path: string, init?: RequestInit) => worker.fetch(new Request(`${BASE}${path}`, init), e);
const post = (e: Env, path: string, body: unknown, headers: Record<string, string> = {}) => call(e, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const STATE = 'abcdefghijklmnop0123';

let upstream: { url: string; init?: RequestInit }[];
let answer: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
	upstream = [];
	answer = () => Response.json({});
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		upstream.push({ url, init });
		return answer(url, init);
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('sign-in', () => {
	it('sends YouTube sign-in to Google with the relay redirect, the PKCE challenge and the app port in the state', async () => {
		const challenge = 'c'.repeat(43);
		const res = await call(env(), `/start/youtube?port=8787&state=${STATE}&challenge=${challenge}`);
		expect(res.status).toBe(302);
		const to = new URL(res.headers.get('location')!);
		expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(to.searchParams.get('redirect_uri')).toBe(`${BASE}/callback/youtube`);
		expect(to.searchParams.get('state')).toBe(`8787.${STATE}`);
		expect(to.searchParams.get('code_challenge')).toBe(challenge);
		expect(to.searchParams.get('client_id')).toBe('gid.apps.googleusercontent.com');
		expect(res.headers.get('location')).not.toContain('secret');
	});

	it('asks TikTok for the profile, stats, video list and inbox upload scopes, never video.publish', async () => {
		const to = new URL((await call(env(), `/start/tiktok?port=51234&state=${STATE}`)).headers.get('location')!);
		expect(to.host).toBe('www.tiktok.com');
		expect(to.searchParams.get('scope')).toBe('user.info.basic,user.info.stats,video.list,video.upload');
		expect(to.searchParams.get('client_key')).toBe('tt-key');
	});

	it('refuses bad ports and states', async () => {
		for (const q of [`port=80&state=${STATE}`, `port=99999&state=${STATE}`, `port=8787&state=short`, `port=8787&state=${STATE}&challenge=bad`, `state=${STATE}`]) {
			expect((await call(env(), `/start/youtube?${q}`)).status, q).toBe(400);
		}
	});

	it('only ever forwards the code to 127.0.0.1 on the port from the state', async () => {
		const res = await call(env(), `/callback/instagram?code=abc&state=8787.${STATE}`);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe(`http://127.0.0.1:8787/api/oauth/instagram/callback?state=${STATE}&code=abc`);
		const err = await call(env(), `/callback/tiktok?error=access_denied&error_description=User+cancelled&state=8787.${STATE}`);
		expect(err.headers.get('location')).toContain('error=access_denied');
		for (const s of [`evil.com.${STATE}`, `8787`, `8787.x`, `0.${STATE}`]) expect((await call(env(), `/callback/youtube?code=a&state=${encodeURIComponent(s)}`)).status, s).toBe(400);
	});

	it('shows a plain notice when a platform is not set up', async () => {
		const res = await call(env({ TIKTOK_CLIENT_SECRET: '' }), `/start/tiktok?port=8787&state=${STATE}`);
		expect(res.status).toBe(503);
		expect(await res.text()).toContain('TikTok sign-in is not available yet');
		expect((await post(env({ TIKTOK_CLIENT_SECRET: '' }), '/token/tiktok', { code: 'x' })).status).toBe(503);
	});

	it('exchanges a YouTube code with the secret and the verifier, and passes Google’s answer through', async () => {
		answer = () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 's' });
		const res = await post(env(), '/token/youtube', { code: 'the-code', verifier: 'v'.repeat(43) });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ access_token: 'at', refresh_token: 'rt' });
		const sent = new URLSearchParams(String(upstream[0].init?.body));
		expect(upstream[0].url).toBe('https://oauth2.googleapis.com/token');
		expect(Object.fromEntries(sent)).toMatchObject({ code: 'the-code', client_secret: 'g-secret', redirect_uri: `${BASE}/callback/youtube`, code_verifier: 'v'.repeat(43), grant_type: 'authorization_code' });
	});

	it('passes platform errors through with their status, so the app can tell an expired sign-in', async () => {
		answer = () => Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
		const res = await post(env(), '/refresh/youtube', { refreshToken: 'old' });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
	});

	it('swaps an Instagram code for a long-lived token in one call', async () => {
		answer = (url) =>
			url.startsWith('https://api.instagram.com/oauth/access_token')
				? Response.json({ access_token: 'short', user_id: 42, permissions: ['instagram_business_basic', 'instagram_business_content_publish'] })
				: Response.json({ access_token: 'long', token_type: 'bearer', expires_in: 5183944 });
		const res = await post(env(), '/token/instagram', { code: 'c' });
		expect(await res.json()).toEqual({ access_token: 'long', token_type: 'bearer', expires_in: 5183944, permissions: ['instagram_business_basic', 'instagram_business_content_publish'], user_id: 42 });
		expect(upstream[1].url).toContain('grant_type=ig_exchange_token');
		expect(upstream[1].url).toContain('client_secret=ig-secret');
	});

	it('refreshes and revokes TikTok tokens with the secret', async () => {
		answer = () => Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 86400 });
		await post(env(), '/refresh/tiktok', { refreshToken: 'r1' });
		await post(env(), '/revoke/tiktok', { token: 'a2' });
		expect(Object.fromEntries(new URLSearchParams(String(upstream[0].init?.body)))).toMatchObject({ client_secret: 'tt-secret', grant_type: 'refresh_token', refresh_token: 'r1' });
		expect(upstream[1].url).toBe('https://open.tiktokapis.com/v2/oauth/revoke/');
	});

	it('rejects requests without a code or with oversized bodies', async () => {
		expect((await post(env(), '/token/tiktok', {})).status).toBe(400);
		expect((await post(env(), '/token/tiktok', { code: 'x'.repeat(20_000) })).status).toBe(400);
		expect(upstream).toHaveLength(0);
	});
});

describe('Instagram video hosting', () => {
	const igOk = () => (answer = (url) => (url.includes('graph.instagram.com') && url.includes('/me?') ? Response.json({ user_id: '1' }) : Response.json({}, { status: 404 })));

	async function upload(e: Env, bytes: Uint8Array) {
		const created = await post(e, '/media', { size: bytes.length, type: 'video/mp4' }, { authorization: 'Bearer ig-token' });
		expect(created.status).toBe(200);
		const c = (await created.json()) as { id: string; uploadId: string; key: string; partSize: number };
		expect(c.partSize).toBe(PART_SIZE);
		const part = await call(e, `/media/${c.id}/parts/1?uploadId=${c.uploadId}`, { method: 'PUT', headers: { 'x-media-key': c.key, 'content-length': String(bytes.length) }, body: bytes as unknown as BodyInit });
		expect(part.status).toBe(200);
		const done = await post(e, `/media/${c.id}/complete`, { uploadId: c.uploadId, parts: [await part.json()] }, { 'x-media-key': c.key });
		expect(done.status).toBe(200);
		return { ...c, ...((await done.json()) as { url: string; expiresAt: number }) };
	}

	it('uploads, serves through a signed link with ranges, and deletes', async () => {
		igOk();
		const { bucket, objects } = fakeBucket();
		const e = env({ MEDIA: bucket });
		const bytes = new TextEncoder().encode('0123456789abcdef');
		const u = await upload(e, bytes);
		expect(u.url.startsWith(`${BASE}/m/${u.id}?exp=`)).toBe(true);
		const path = u.url.slice(BASE.length);

		const whole = await call(e, path);
		expect(whole.status).toBe(200);
		expect(whole.headers.get('content-type')).toBe('video/mp4');
		expect(await whole.text()).toBe('0123456789abcdef');
		const part = await call(e, path, { headers: { range: 'bytes=4-7' } });
		expect(part.status).toBe(206);
		expect(part.headers.get('content-range')).toBe('bytes 4-7/16');
		expect(await part.text()).toBe('4567');
		expect((await call(e, path, { method: 'HEAD' })).headers.get('content-length')).toBe('16');

		const tampered = path.replace(/sig=[0-9a-f]/, (m) => (m.endsWith('0') ? m.slice(0, -1) + '1' : m.slice(0, -1) + '0'));
		expect((await call(e, tampered)).status).toBe(403);

		expect((await call(e, `/media/${u.id}`, { method: 'DELETE', headers: { 'x-media-key': 'wrong' } })).status).toBe(403);
		expect((await call(e, `/media/${u.id}`, { method: 'DELETE', headers: { 'x-media-key': u.key } })).status).toBe(200);
		expect(objects.size).toBe(0);
		expect((await call(e, path)).status).toBe(404);
	});

	it('refuses uploads without a working Instagram sign-in, and oversized parts', async () => {
		answer = () => Response.json({ error: { code: 190 } }, { status: 401 });
		const { bucket } = fakeBucket();
		const e = env({ MEDIA: bucket });
		expect((await post(e, '/media', { size: 10 })).status).toBe(401);
		expect((await post(e, '/media', { size: 10 }, { authorization: 'Bearer bad' })).status).toBe(401);
		igOk();
		expect((await post(e, '/media', { size: 2 * 1024 * 1024 * 1024 }, { authorization: 'Bearer ig' })).status).toBe(413);
		const c = (await (await post(e, '/media', { size: 10 }, { authorization: 'Bearer ig' })).json()) as { id: string; uploadId: string; key: string };
		const big = await call(e, `/media/${c.id}/parts/1?uploadId=${c.uploadId}`, { method: 'PUT', headers: { 'x-media-key': c.key, 'content-length': String(PART_SIZE + 1) }, body: 'x' });
		expect(big.status).toBe(400);
	});

	it('expires links and sweeps leftovers older than a day', async () => {
		igOk();
		const { bucket, objects } = fakeBucket();
		const e = env({ MEDIA: bucket });
		const u = await upload(e, new Uint8Array([1, 2, 3]));
		const expired = u.url.replace(/exp=\d+/, 'exp=1000').slice(BASE.length);
		expect((await call(e, expired)).status).toBe(403);
		expect(await sweepMedia(e)).toBe(0);
		for (const o of objects.values()) o.uploaded = new Date(Date.now() - 25 * 3600 * 1000);
		expect(await sweepMedia(e)).toBe(1);
		expect(objects.size).toBe(0);
	});
});

describe('public pages', () => {
	it('serves home, terms and privacy with the operator details', async () => {
		for (const p of ['/', '/terms', '/privacy']) {
			const res = await call(env(), p);
			expect(res.status).toBe(200);
			const t = await res.text();
			expect(t).toContain('Test Operator');
			expect(t).toContain('help@example.test');
		}
		expect(await (await call(env(), '/privacy')).text()).toContain('Limited Use');
		expect(await (await call(env({ OPERATOR_NAME: '<script>' }), '/')).text()).not.toContain('<script>');
	});

	it('reports which platforms are ready', async () => {
		expect(await (await call(env({ INSTAGRAM_APP_SECRET: '' }), '/health')).json()).toEqual({ ok: true, platforms: { youtube: true, tiktok: true, instagram: false }, media: false });
	});
});
