// Phone access in the desktop app: pairing with a one-use link, what a paired phone may do, removing
// it, turning it off. Same rules as windows/core/tests/phone.rs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { buildApp, routedPath } = await import('../server/app.js');
const { config } = await import('../server/config.js');
const phone = await import('../server/phone.js');
const { freshDb } = await import('./helpers.js');

const TOKEN = 'd'.repeat(43);
const H = { 'x-requested-with': 'social-publisher' };
let app: FastifyInstance;

beforeEach(async () => {
	freshDb();
	process.env.SP_DESKTOP = '1';
	config.desktopToken = TOKEN;
	app = await buildApp();
});
afterEach(async () => {
	phone.stop();
	delete process.env.SP_DESKTOP;
	config.desktopToken = '';
	await app.close();
});

const desk = (method: any, url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie: `sp_desktop=${TOKEN}`, ...H }, payload: payload as any });
const fromPhone = (cookie: string, method: any, url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie, ...H }, payload: payload as any });
const linkPath = (url: string) => `/pair/${url.split('/pair/')[1]}`;

describe('phone access', () => {
	it('pairs a phone once; the phone can post but not change keys; removing or turning off ends it', async () => {
		// Off by default.
		expect((await desk('POST', '/api/phone/pair', {})).statusCode).toBe(409);
		expect((await app.inject({ url: '/api/session' })).json().phonePairing).toBe(false);
		expect((await desk('GET', '/api/config')).json().features).toContain('phone');

		const on = await desk('PUT', '/api/phone', { enabled: true });
		expect(on.json().enabled).toBe(true);
		// PUBLIC_BASE_URL (https) is set in tests/setup.ts, so a link exists even without Wi-Fi.
		const pair = (await desk('POST', '/api/phone/pair', {})).json();
		expect(pair.qr).toContain('<svg');
		const path = linkPath(pair.url);

		const opened = await app.inject({ url: path, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)' } });
		expect(opened.statusCode).toBe(200);
		const set = String(opened.headers['set-cookie']);
		expect(set).toMatch(/^sp_phone=[^;]+;.*HttpOnly/);
		expect(set).toContain('SameSite=Lax');
		const cookie = set.split(';')[0];
		expect((await app.inject({ url: path })).statusCode).toBe(410);

		const s = (await fromPhone(cookie, 'GET', '/api/session')).json();
		expect([s.signedIn, s.phone, s.desktop]).toEqual([true, true, false]);
		expect((await desk('GET', '/api/phone')).json().devices[0].name).toBe('iPhone');

		// Allowed from a phone.
		expect((await fromPhone(cookie, 'GET', '/api/accounts')).statusCode).toBe(200);
		expect((await fromPhone(cookie, 'POST', '/api/demo/accounts', {})).statusCode).toBe(200);
		expect((await fromPhone(cookie, 'GET', '/api/desktop/prefs')).statusCode).toBe(200);
		// Drafts only can only be changed on the computer.
		expect((await fromPhone(cookie, 'PUT', '/api/desktop/prefs', { draftsOnly: false })).statusCode).toBe(403);
		// Kept on the computer.
		for (const [m, u] of [['PUT', '/api/setup/youtube'], ['PUT', '/api/setup/public-url'], ['POST', '/api/oauth/youtube/begin'], ['GET', '/api/phone'], ['POST', '/api/phone/pair']] as const)
			expect((await fromPhone(cookie, m, u, {})).statusCode, `${m} ${u}`).toBe(403);
		expect((await fromPhone('sp_phone=abc.def', 'GET', '/api/accounts')).statusCode).toBe(401);
		expect((await app.inject({ method: 'POST', url: '/api/demo/accounts', headers: { cookie } })).statusCode).toBe(403);

		// Off refuses every phone at once; on again, it works.
		await desk('PUT', '/api/phone', { enabled: false });
		expect((await fromPhone(cookie, 'GET', '/api/accounts')).statusCode).toBe(401);
		await desk('PUT', '/api/phone', { enabled: true });
		expect((await fromPhone(cookie, 'GET', '/api/accounts')).statusCode).toBe(200);

		// Removed on the computer.
		const id = (await desk('GET', '/api/phone')).json().devices[0].id;
		expect((await desk('DELETE', `/api/phone/devices/${id}`)).json().devices).toEqual([]);
		expect((await fromPhone(cookie, 'GET', '/api/accounts')).statusCode).toBe(401);

		// Unpairing on the phone forgets it.
		const again = (await desk('POST', '/api/phone/pair', {})).json();
		const c2 = String((await app.inject({ url: linkPath(again.url), headers: { 'user-agent': 'Android' } })).headers['set-cookie']).split(';')[0];
		expect((await fromPhone(c2, 'DELETE', '/api/session')).statusCode).toBe(200);
		expect((await fromPhone(c2, 'GET', '/api/accounts')).statusCode).toBe(401);
		await desk('PUT', '/api/phone', { enabled: false });
	});

	it('encoded or odd paths cannot skip the sign-in check or the phone limits', async () => {
		// "/%61pi/accounts" decodes to /api/accounts; the guard once checked the raw URL and let it through.
		for (const url of ['/%61pi/accounts', '/%61pi/phone', '/api/%70hone', '/api//accounts', '/api/accounts/', '/%2561pi/accounts']) {
			const r = await app.inject({ url });
			expect(r.statusCode === 401 || r.headers['content-type']?.startsWith('text/html'), `${url} ${r.statusCode} ${r.body.slice(0, 40)}`).toBe(true);
		}
		expect((await app.inject({ url: '/api/accounts%' })).statusCode).toBe(400);
		// An absolute request target or a fragment must not hide the API path from the checks.
		expect(routedPath('http://desktop/api/accounts')).toBe('/api/accounts');
		expect(routedPath('/api/oauth/youtube/start#x')).toBe('/api/oauth/youtube/start');
		expect(routedPath('/%61pi/x?y')).toBe('/api/x');
		expect(phone.blocked('POST', routedPath('/api/oauth/youtube/begin#x')!)).toBe(true);
		await desk('PUT', '/api/phone', { enabled: true });
		const pair = (await desk('POST', '/api/phone/pair', {})).json();
		const cookie = String((await app.inject({ url: linkPath(pair.url) })).headers['set-cookie']).split(';')[0];
		for (const [m, u] of [['GET', '/api/%70hone'], ['PUT', '/%61pi/setup/youtube'], ['POST', '/api/oauth/youtube/%62egin'], ['POST', '/api/desktop/%70ick-video']] as const)
			expect((await fromPhone(cookie, m, u, {})).statusCode, `${m} ${u}`).toBe(403);
		await desk('PUT', '/api/phone', { enabled: false });
	});

	it('blocks only what belongs on the computer', () => {
		expect(phone.blocked('GET', '/api/setup')).toBe(false);
		expect(phone.blocked('PUT', '/api/setup/tiktok')).toBe(true);
		expect(phone.blocked('GET', '/api/desktop/prefs')).toBe(false);
		expect(phone.blocked('PUT', '/api/desktop/prefs')).toBe(true);
		expect(phone.blocked('POST', '/api/desktop/pick-video')).toBe(true);
		expect(phone.blocked('POST', '/api/oauth/tiktok/begin')).toBe(true);
		expect(phone.blocked('GET', '/api/oauth/tiktok/callback')).toBe(false);
		expect(phone.blocked('POST', '/api/posts')).toBe(false);
	});
});
