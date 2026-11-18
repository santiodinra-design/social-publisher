import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { getDb } from '../server/db.js';
import { config } from '../server/config.js';
import { saveSettings } from '../server/settings.js';
import { freshDb, seedAccount, seedMedia } from './helpers.js';

let app: FastifyInstance;
let cookie = '';
const H = { 'x-requested-with': 'social-publisher' };

async function signIn() {
	const r = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'test-password-123' } });
	cookie = String(r.headers['set-cookie']).split(';')[0];
}
const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as any, headers: { cookie, ...H } });

beforeEach(async () => {
	freshDb();
	app = await buildApp();
	await signIn();
});
afterEach(async () => {
	vi.restoreAllMocks();
	await app.close();
});

describe('access control', () => {
	it('serves the Terms and Privacy pages without signing in', async () => {
		for (const url of ['/terms', '/privacy']) {
			const r = await app.inject({ method: 'GET', url });
			expect(r.statusCode).toBe(200);
			expect(r.headers['content-type']).toMatch(/text\/html/);
		}
	});
	it('blocks the API without signing in', async () => {
		expect((await app.inject({ method: 'GET', url: '/api/accounts' })).statusCode).toBe(401);
		expect((await app.inject({ method: 'POST', url: '/api/posts', payload: {} })).statusCode).toBe(401);
	});
	it('rejects a wrong password', async () => {
		expect((await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'nope' } })).statusCode).toBe(401);
	});
	it('lets the owner in without a password only when NO_SIGN_IN is on, and still checks CSRF', async () => {
		config.noSignIn = true;
		try {
			expect((await app.inject({ method: 'GET', url: '/api/accounts' })).statusCode).toBe(200);
			expect((await app.inject({ method: 'POST', url: '/api/posts', payload: {} })).statusCode).toBe(403);
		} finally {
			config.noSignIn = false;
		}
		expect((await app.inject({ method: 'GET', url: '/api/accounts' })).statusCode).toBe(401);
	});
	it('rejects state-changing requests not made by the app (CSRF)', async () => {
		const r = await app.inject({ method: 'POST', url: '/api/posts', payload: {}, headers: { cookie } });
		expect(r.statusCode).toBe(403);
	});
});

describe('tokens', () => {
	it('stores tokens encrypted and never returns them to the browser', async () => {
		seedAccount('youtube');
		const raw = getDb().prepare('SELECT access_token, refresh_token FROM accounts').get() as any;
		expect(raw.access_token).not.toContain('secret-access');
		expect(raw.access_token.startsWith('v1.')).toBe(true);
		const body = (await get('/api/accounts')).body;
		expect(body).not.toContain('secret');
		expect(body).not.toContain('v1.');
	});
});

describe('publishing validation', () => {
	it('explains each problem next to the right field', async () => {
		saveSettings({ DRAFTS_ONLY: 'off' }); // with drafts only, privacy is forced and Instagram refused
		const m = seedMedia(1024 * 1024, { duration: 1 });
		const yt = seedAccount('youtube');
		const ig = seedAccount('instagram');
		const r = await post('/api/posts', {
			idempotencyKey: 'val-key-0001',
			mediaId: m,
			caption: 'x'.repeat(2300),
			targets: [{ accountId: yt.id, settings: { title: '', privacy: 'secret' } }, { accountId: ig.id, settings: {} }],
		});
		expect(r.statusCode).toBe(422);
		const fields = r.json().issues.map((i: any) => i.field);
		expect(fields).toEqual(expect.arrayContaining(['youtube.title', 'youtube.privacy', 'youtube.madeForKids', 'caption.instagram', 'media.instagram']));
	});

	it('requires at least one destination', async () => {
		const r = await post('/api/posts', { idempotencyKey: 'val-key-0002', mediaId: seedMedia(), caption: '', targets: [] });
		expect(r.statusCode).toBe(400);
	});

	it('rejects mixing demo and real accounts', async () => {
		const real = seedAccount('youtube');
		const demo = seedAccount('instagram', { demo: true });
		const r = await post('/api/posts', { idempotencyKey: 'val-key-0003', mediaId: seedMedia(), caption: 'hi', targets: [{ accountId: real.id, settings: { title: 't', privacy: 'private', madeForKids: false } }, { accountId: demo.id, settings: {} }] });
		expect(r.statusCode).toBe(422);
		expect(r.body).toContain('Demo accounts and real accounts');
	});

	it('returns the same post when the publish request is repeated', async () => {
		const yt = seedAccount('youtube');
		const body = { idempotencyKey: 'dup-key-0001', mediaId: seedMedia(), caption: 'hi', targets: [{ accountId: yt.id, settings: { title: 'T', privacy: 'unlisted', madeForKids: false } }] };
		const [a, b] = await Promise.all([post('/api/posts', body), post('/api/posts', body)]);
		expect(a.json().post.id).toBe(b.json().post.id);
		expect((getDb().prepare('SELECT COUNT(*) n FROM posts').get() as any).n).toBe(1);
	});

	it('rejects non-video uploads', async () => {
		const r = await app.inject({ method: 'PUT', url: '/api/media', payload: Buffer.from('hello'), headers: { cookie, ...H, 'content-type': 'image/png' } });
		expect(r.statusCode).toBe(415);
	});
});

describe('OAuth', () => {
	it('starts sign-in with state and PKCE, without exposing secrets', async () => {
		const r = await get('/api/oauth/youtube/start');
		expect(r.statusCode).toBe(302);
		const loc = new URL(r.headers.location as string);
		expect(loc.host).toBe('accounts.google.com');
		expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
		expect(loc.searchParams.get('access_type')).toBe('offline');
		expect(r.headers.location).not.toContain('gs');
	});

	it('handles a refused sign-in with a clear message', async () => {
		const r = await get('/api/oauth/instagram/callback?error=access_denied&error_description=User+denied');
		expect(r.statusCode).toBe(302);
		expect(decodeURIComponent(r.headers.location as string)).toContain('Instagram cancelled the sign-in');
	});

	it('rejects a callback whose state does not match', async () => {
		await get('/api/oauth/tiktok/start');
		const r = await get('/api/oauth/tiktok/callback?code=abc&state=forged');
		expect(decodeURIComponent(r.headers.location as string)).toContain('expired or did not match');
	});

	it('reports a failed token exchange and stores nothing', async () => {
		const start = await get('/api/oauth/youtube/start');
		const state = new URL(start.headers.location as string).searchParams.get('state');
		const oauthCookie = String(start.headers['set-cookie']).split(';')[0];
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }), { status: 400 }));
		const r = await app.inject({ method: 'GET', url: `/api/oauth/youtube/callback?code=abc&state=${state}`, headers: { cookie: `${cookie}; ${oauthCookie}` } });
		expect(decodeURIComponent(r.headers.location as string)).toContain('Could not connect youtube');
		expect((getDb().prepare('SELECT COUNT(*) n FROM accounts').get() as any).n).toBe(0);
	});

	it('connects (and reconnects) an account through the callback', async () => {
		for (let i = 0; i < 2; i++) {
			const start = await get('/api/oauth/youtube/start');
			const state = new URL(start.headers.location as string).searchParams.get('state');
			const oauthCookie = String(start.headers['set-cookie']).split(';')[0];
			const f = vi.spyOn(globalThis, 'fetch');
			f.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: `at${i}`, refresh_token: `rt${i}`, expires_in: 3600 }), { status: 200 }));
			f.mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'UC1', snippet: { title: 'My Channel', customUrl: '@me', thumbnails: {} } }] }), { status: 200 }));
			const r = await app.inject({ method: 'GET', url: `/api/oauth/youtube/callback?code=c&state=${state}`, headers: { cookie: `${cookie}; ${oauthCookie}` } });
			expect(decodeURIComponent(r.headers.location as string)).toContain('connected=My Channel');
			f.mockRestore();
		}
		expect((getDb().prepare('SELECT COUNT(*) n FROM accounts').get() as any).n).toBe(1);
	});
});

describe('public media links for Instagram', () => {
	it('serves a video only with a valid signed link, with range support', async () => {
		const { publicMediaUrl } = await import('../server/platforms/instagram.js');
		const m = seedMedia(2000);
		const url = new URL(publicMediaUrl(m)).pathname;
		const r = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-99' } });
		expect(r.statusCode).toBe(206);
		expect(r.rawPayload.length).toBe(100);
		expect((await app.inject({ method: 'GET', url: '/m/forged.token' })).statusCode).toBe(404);
	});

	it('lets a saved draft find its video by ID, and says when it is gone', async () => {
		const m = seedMedia(2000);
		const r = await get(`/api/media/${m}`);
		expect(r.statusCode).toBe(200);
		const preview = r.json().previewUrl as string;
		expect((await app.inject({ method: 'GET', url: preview, headers: { range: 'bytes=0-9' } })).statusCode).toBe(206);
		getDb().prepare('UPDATE media SET deleted_at = 1 WHERE id = ?').run(m);
		expect((await get(`/api/media/${m}`)).statusCode).toBe(404);
	});

	it('reports worker health from its heartbeat, not from the web server answering', async () => {
		const { workerBeat } = await import('../server/db.js');
		expect((await get('/api/status')).json().worker.state).toBe('never');
		workerBeat('w1', Date.now());
		expect((await get('/api/status')).json().worker.state).toBe('running');
		getDb().prepare('UPDATE worker_status SET beat_at = ?').run(Date.now() - 120_000);
		expect((await get('/api/status')).json().worker.state).toBe('stale');
	});

	it('checks a demo account without claiming a live check', async () => {
		const a = seedAccount('youtube', { demo: true });
		const r = await post(`/api/accounts/${a.id}/verify`, {});
		expect(r.json()).toMatchObject({ ok: true, simulated: true });
	});
});

describe('in-app platform keys', () => {
	const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, payload: payload as any, headers: { cookie, ...H } });
	const GOOD_ID = '1234567890-abcdef.apps.googleusercontent.com';

	it('catches common paste mistakes beside the right field', async () => {
		const r = await put('/api/setup/youtube', { id: 'not-a-client-id', secret: '' });
		expect(r.statusCode).toBe(422);
		const fields = r.json().issues.map((i: any) => i.field);
		expect(fields).toEqual(expect.arrayContaining(['id', 'secret']));
		const same = await put('/api/setup/youtube', { id: GOOD_ID, secret: GOOD_ID });
		expect(same.body).toContain('client ID again');
	});

	it('saves keys encrypted, shows only a masked ID, and never returns the secret', async () => {
		const r = await put('/api/setup/youtube', { id: GOOD_ID, secret: 'GOCSPX-supersecretvalue' });
		expect(r.statusCode).toBe(200);
		const view = r.json().platforms.youtube;
		expect(view).toMatchObject({ configured: true, source: 'app', hasSecret: true });
		expect(view.idPreview).toBe('123456….com');
		expect(r.body).not.toContain('supersecret');
		expect((await get('/api/setup')).body).not.toContain('supersecret');
		const raw = getDb().prepare("SELECT value FROM app_settings WHERE key = 'GOOGLE_CLIENT_SECRET'").get() as any;
		expect(raw.value).not.toContain('supersecret');
		expect(view.redirectUri).toBe('http://localhost:5173/api/oauth/youtube/callback');
	});

	it('uses the saved keys for Connect immediately, without a restart', async () => {
		await put('/api/setup/youtube', { id: GOOD_ID, secret: 'GOCSPX-x' });
		const r = await get('/api/oauth/youtube/start');
		expect(new URL(r.headers.location as string).searchParams.get('client_id')).toBe(GOOD_ID);
	});

	it('falls back to .env after removing saved keys', async () => {
		await put('/api/setup/youtube', { id: GOOD_ID, secret: 'GOCSPX-x' });
		await app.inject({ method: 'DELETE', url: '/api/setup/youtube', headers: { cookie, ...H } });
		const r = await get('/api/oauth/youtube/start');
		expect(new URL(r.headers.location as string).searchParams.get('client_id')).toBe('gid');
	});

	it('only accepts an https public address for Instagram', async () => {
		expect((await put('/api/setup/public-url', { publicBaseUrl: 'http://insecure.example' })).statusCode).toBe(422);
		const ok = await put('/api/setup/public-url', { publicBaseUrl: 'https://tunnel.example.com/' });
		expect(ok.json().publicBaseUrl).toMatchObject({ value: 'https://tunnel.example.com', source: 'app' });
	});

	it('requires sign-in to read or change keys', async () => {
		expect((await app.inject({ method: 'GET', url: '/api/setup' })).statusCode).toBe(401);
		expect((await app.inject({ method: 'PUT', url: '/api/setup/youtube', payload: { id: 'a', secret: 'b' } })).statusCode).toBe(401);
	});
});

describe('desktop app mode', () => {
	const TOKEN = 'd'.repeat(43);
	beforeEach(() => {
		process.env.SP_DESKTOP = '1';
		config.desktopToken = TOKEN;
	});
	afterEach(() => {
		delete process.env.SP_DESKTOP;
		config.desktopToken = '';
	});
	const as = (c?: string) => (url: string) => app.inject({ method: 'GET', url, headers: c ? { cookie: c } : {} });

	it('only lets in the window holding the per-launch cookie; loopback alone is not enough', async () => {
		expect((await as()('/api/accounts')).statusCode).toBe(401);
		expect((await as('sp_desktop=wrong')('/api/accounts')).statusCode).toBe(401);
		expect((await as(cookie)('/api/accounts')).statusCode).toBe(401); // a password session does not count
		expect((await as(`sp_desktop=${TOKEN}`)('/api/accounts')).statusCode).toBe(200);
		expect((await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'test-password-123' } })).statusCode).toBe(403);
	});

	it('hands sign-in to the system browser with one-use server-side state, and answers there with a page', async () => {
		const begin = await app.inject({ method: 'POST', url: '/api/oauth/youtube/begin', headers: { cookie: `sp_desktop=${TOKEN}`, ...H } });
		expect(begin.statusCode).toBe(200);
		const url = new URL(begin.json().url);
		const state = url.searchParams.get('state')!;
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: any) =>
			String(u).includes('oauth2.googleapis.com/token')
				? new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 })
				: new Response(JSON.stringify({ items: [{ id: 'UC1', snippet: { title: 'My Channel', thumbnails: {} } }] }), { status: 200 }),
		);
		// The callback arrives from the system browser: no app cookie at all.
		const cb = await app.inject({ method: 'GET', url: `/api/oauth/youtube/callback?code=abc&state=${state}` });
		expect(cb.statusCode).toBe(200);
		expect(cb.body).toContain('Connected My Channel');
		const again = await app.inject({ method: 'GET', url: `/api/oauth/youtube/callback?code=abc&state=${state}` });
		expect(again.body).toContain('expired or did not match');
	});
});
