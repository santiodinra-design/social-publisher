// The extras shared with the Windows build, on the Node (Mac) server: scheduling, "I posted it",
// cover images, finish notices and the notification preference.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { getDb } from '../server/db.js';
import { claimNext, finish, getTarget, postView } from '../server/jobs.js';
import { runTarget } from '../server/runner.js';
import { afterTarget, summarize } from '../server/notify.js';
import { resetSettingsCache, saveSettings } from '../server/settings.js';
import { freshDb, instantSleep, seedAccount, seedMedia } from './helpers.js';

let app: FastifyInstance;
let cookie = '';
const H = { 'x-requested-with': 'social-publisher' };
const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as any, headers: { cookie, ...H } });

beforeEach(async () => {
	freshDb();
	app = await buildApp();
	const r = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'test-password-123' } });
	cookie = String(r.headers['set-cookie']).split(';')[0];
});
afterEach(async () => {
	vi.restoreAllMocks();
	await app.close();
});

const PNG = (w = 1280, h = 720) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([w >> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255]), Buffer.alloc(64)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x07, 0x80, 0x04, 0x38, 3, 0, 0, 0, 0, 0, 0, 0]);
const putCover = (body: Buffer, type = 'image/png') => app.inject({ method: 'PUT', url: '/api/covers', payload: body, headers: { cookie, ...H, 'content-type': type } });

function publish(platform: 'youtube' | 'instagram' | 'tiktok', settings: object, extra: object = {}) {
	const a = seedAccount(platform);
	const m = seedMedia(3 * 1024 * 1024);
	return post('/api/posts', { idempotencyKey: `k-${Math.random()}`, mediaId: m, caption: 'hello', targets: [{ accountId: a.id, settings }], ...extra });
}
const YT = { title: 'T', privacy: 'private', madeForKids: false };

describe('feature list', () => {
	it('lists the extras the Node server provides; notifications only inside the desktop app', async () => {
		expect((await get('/api/config')).json().features).toEqual(['schedule', 'markPosted', 'repost', 'covers', 'analytics', 'groups', 'draftsOnly']);
	});
});

describe('scheduled publishing', () => {
	it('holds every destination until the time, then can be moved to now', async () => {
		const at = Date.now() + 3_600_000;
		const r = await publish('youtube', YT, { scheduledAt: at });
		expect(r.statusCode).toBe(200);
		const p = r.json().post;
		expect(p.scheduled).toBe(true);
		expect(p.scheduledAt).toBe(at);
		expect(p.targets[0].scheduled).toBe(true);
		expect(claimNext('w')).toBeNull();
		const now = await post(`/api/posts/${p.id}/schedule`, { at: null });
		expect(now.json().post.scheduled).toBe(false);
		expect(claimNext('w')?.post_id).toBe(p.id);
	});

	it('refuses times that are too soon or too far away', async () => {
		expect((await publish('youtube', YT, { scheduledAt: Date.now() + 5_000 })).statusCode).toBe(400);
		expect((await publish('youtube', YT, { scheduledAt: Date.now() + 61 * 86_400_000 })).statusCode).toBe(400);
	});

	it('cancels only destinations still waiting, and not once they have started', async () => {
		const p = (await publish('youtube', YT, { scheduledAt: Date.now() + 3_600_000 })).json().post;
		const c = await post(`/api/posts/${p.id}/cancel`, {});
		expect(c.json().post.targets[0].state).toBe('failed');
		expect(c.json().post.targets[0].error).toContain('Cancelled before the scheduled time');
		expect((await post(`/api/posts/${p.id}/cancel`, {})).statusCode).toBe(409);
		expect((await post(`/api/posts/${p.id}/schedule`, { at: Date.now() + 3_600_000 })).statusCode).toBe(409);
	});
});

describe('I posted it (TikTok inbox)', () => {
	it('marks an inbox draft as published with an optional TikTok link, and refuses anything else', async () => {
		const p = (await publish('tiktok', { mode: 'inbox' })).json().post;
		const t = p.targets[0];
		expect((await post(`/api/targets/${t.id}/posted`, { permalink: '' })).statusCode).toBe(409); // still queued
		finish(t.id, 'needs_attention', { error: 'Sent to your TikTok inbox. Open TikTok…' });
		expect(postView(p.id)!.targets[0].canMarkPosted).toBe(true);
		const bad = await post(`/api/targets/${t.id}/posted`, { permalink: 'https://evil.example/x' });
		expect(bad.statusCode).toBe(422);
		const ok = await post(`/api/targets/${t.id}/posted`, { permalink: 'https://www.tiktok.com/@me/video/1' });
		expect(ok.json().post.targets[0]).toMatchObject({ state: 'published', permalink: 'https://www.tiktok.com/@me/video/1', error: null });
	});
});

describe('cover images', () => {
	it('accepts JPEG and PNG by their bytes, reads the size, and serves them back', async () => {
		const r = await putCover(PNG(1280, 720));
		expect(r.statusCode).toBe(200);
		expect(r.json()).toMatchObject({ mime: 'image/png', width: 1280, height: 720 });
		expect((await get(r.json().url)).statusCode).toBe(200);
		expect((await putCover(JPG, 'image/jpeg')).json()).toMatchObject({ mime: 'image/jpeg', width: 1080, height: 1920 });
		expect((await putCover(Buffer.from('GIF89a........'), 'image/png')).statusCode).toBe(422);
	});

	it('checks covers per platform before saving the post', async () => {
		saveSettings({ DRAFTS_ONLY: 'off' }); // Instagram is refused while drafts only is on
		const png = (await putCover(PNG())).json().id;
		const tt = await publish('tiktok', { mode: 'inbox', coverId: png });
		expect(tt.statusCode).toBe(422);
		expect(tt.json().issues.some((i: any) => i.field === 'tiktok.cover')).toBe(true);
		const ig = await publish('instagram', { coverId: png });
		expect(ig.json().issues.some((i: any) => i.message.includes('JPEG'))).toBe(true);
	});

	it('sets the YouTube thumbnail after upload, and a refused thumbnail never fails the video', async () => {
		const id = (await putCover(PNG())).json().id;
		const p = (await publish('youtube', { ...YT, coverId: id })).json().post;
		const calls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: any, i: any = {}) => {
			const url = String(u);
			calls.push(url);
			if (url.includes('uploadType=resumable')) return new Response('', { status: 200, headers: { location: 'https://upload.example/s' } });
			if (url.includes('upload.example/s')) return String(i.headers['Content-Range']).startsWith('bytes */') ? new Response('', { status: 308 }) : new Response(JSON.stringify({ id: 'v1' }), { status: 200 });
			if (url.includes('thumbnails/set')) return new Response(JSON.stringify({ error: { code: 403, message: 'forbidden' } }), { status: 403 });
			return new Response(JSON.stringify({ items: [{ status: { uploadStatus: 'processed' } }] }), { status: 200 });
		});
		await runTarget(claimNext('w')!, 'w', instantSleep);
		const t = getTarget(p.targets[0].id)!;
		expect(t.state).toBe('published');
		expect(calls.filter((c) => c.includes('thumbnails/set?videoId=v1'))).toHaveLength(1);
		expect(postView(p.id)!.targets[0].events.some((e: any) => e.message.includes('verified channel'))).toBe(true);
	});
});

describe('finish notices', () => {
	it('announces a post once, when its last destination ends, in plain words', async () => {
		const p = (await publish('youtube', YT)).json().post;
		finish(p.targets[0].id, 'published', { permalink: 'https://youtube.com/x' });
		expect(afterTarget(p.id)).toMatchObject({ title: 'Published to YouTube', body: 'hello', ok: true });
		expect(afterTarget(p.id)).toBeNull();
		const n = summarize('p', [{ platform: 'tiktok', state: 'needs_attention', error: 'Sent to your TikTok inbox. Open TikTok…' }, { platform: 'youtube', state: 'published', error: null }], '', 'clip.mp4', false);
		expect(n).toMatchObject({ title: 'Sent to your TikTok inbox', body: 'Published to YouTube. Open TikTok to finish posting: clip.mp4' });
	});

	it('remembers the on/off preference', async () => {
		expect((await get('/api/desktop/prefs')).json()).toEqual({ notifications: true, draftsOnly: true });
		const off = await app.inject({ method: 'PUT', url: '/api/desktop/prefs', payload: { notifications: false }, headers: { cookie, ...H } });
		expect(off.json()).toEqual({ notifications: false, draftsOnly: true });
		resetSettingsCache();
		const p = (await publish('youtube', YT)).json().post;
		finish(p.targets[0].id, 'published', {});
		expect(afterTarget(p.id)).toBeNull();
		expect(getDb().prepare('SELECT notified_at FROM posts WHERE id = ?').get(p.id)).not.toMatchObject({ notified_at: null });
	});
});

describe('several accounts per platform', () => {
	it('always offers an account choice when signing in', async () => {
		const { ADAPTERS } = await import('../server/platforms/index.js');
		expect(ADAPTERS.youtube.authorizeUrl('s', 'c')).toContain('prompt=select_account+consent');
		expect(ADAPTERS.tiktok.authorizeUrl('s', 'c')).toContain('disable_auto_auth=1');
		expect(ADAPTERS.instagram.authorizeUrl('s', 'c')).toContain('force_reauth=true');
	});

	it('keeps two channels on one platform as separate accounts and posts to both with their own settings', async () => {
		const a = seedAccount('youtube', { externalId: 'UC-one' });
		const b = seedAccount('youtube', { externalId: 'UC-two' });
		expect(a.id).not.toBe(b.id);
		const accts = (await get('/api/accounts')).json().filter((x: any) => x.platform === 'youtube');
		expect(accts).toHaveLength(2);
		const m = seedMedia(3 * 1024 * 1024);
		const r = await post('/api/posts', { idempotencyKey: `k-${Math.random()}`, mediaId: m, caption: 'two channels', targets: [{ accountId: a.id, settings: { ...YT, title: 'First' } }, { accountId: b.id, settings: { ...YT, title: 'Second', privacy: 'unlisted' } }] });
		expect(r.statusCode).toBe(200);
		const ts = r.json().post.targets;
		expect(ts).toHaveLength(2);
		expect(ts.map((t: any) => t.settings.title).sort()).toEqual(['First', 'Second']);
	});
});

describe('cancelled sign-in', () => {
	it('explains a cancelled Google sign-in in plain words', async () => {
		const r = await app.inject({ method: 'GET', url: '/api/oauth/youtube/callback?error=access_denied&state=x' });
		expect(decodeURIComponent(String(r.headers.location ?? r.body))).toContain('Back to safety');
	});
});

describe('saved account groups', () => {
	it('saves, lists and deletes a group, skipping accounts that were disconnected since', async () => {
		const a = seedAccount('youtube', { externalId: 'UC-a' });
		const b = seedAccount('youtube', { externalId: 'UC-b' });
		const r = await post('/api/groups', { name: '  Main channels ', accountIds: [a.id, b.id, 'nope', a.id] });
		expect(r.statusCode).toBe(200);
		expect(r.json()).toMatchObject({ name: 'Main channels', accountIds: [a.id, b.id] });
		expect((await post('/api/groups', { name: '', accountIds: [a.id] })).statusCode).toBe(422);
		expect((await post('/api/groups', { name: 'Empty', accountIds: ['nope'] })).statusCode).toBe(422);
		getDb().prepare("UPDATE accounts SET status = 'disconnected' WHERE id = ?").run(b.id);
		expect((await get('/api/groups')).json()[0].accountIds).toEqual([a.id]);
		const del = await app.inject({ method: 'DELETE', url: `/api/groups/${r.json().id}`, headers: { cookie, ...H } });
		expect(del.json()).toEqual([]);
	});
});

describe('Instagram through Meta Unified login', () => {
	it('signs in with the configuration, connects every shared account, and publishes on graph.facebook.com', async () => {
		const { saveSettings } = await import('../server/settings.js');
		saveSettings({ INSTAGRAM_APP_ID: '1234567', INSTAGRAM_APP_SECRET: 'sec', INSTAGRAM_CONFIG_ID: '7654321' });
		resetSettingsCache();
		const begin = await post('/api/oauth/instagram/begin', {});
		const url = new URL(begin.json().url);
		expect(url.origin + url.pathname).toBe('https://www.facebook.com/v27.0/dialog/oauth');
		expect(url.searchParams.get('config_id')).toBe('7654321');
		const calls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: any) => {
			const s = String(u);
			calls.push(s);
			if (s.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'portfolio-token' }), { status: 200 });
			if (s.includes('/me/assigned_instagram_accounts')) return new Response(JSON.stringify({ data: [{ id: '1789', username: 'voltsys', name: 'Voltsys' }, { id: '1790', username: 'onuhafx', name: 'Onuha FX' }] }), { status: 200 });
			return new Response('{}', { status: 200 });
		});
		const cb = await app.inject({ method: 'GET', url: `/api/oauth/instagram/callback?code=abc&state=${url.searchParams.get('state')}` });
		expect(decodeURIComponent(String(cb.headers.location ?? cb.body))).toContain('Voltsys, Onuha FX');
		const ig = (await get('/api/accounts')).json().filter((a: any) => a.platform === 'instagram');
		expect(ig.map((a: any) => a.handle).sort()).toEqual(['@onuhafx', '@voltsys']);
		expect(calls.some((c) => c.startsWith('https://graph.facebook.com/v27.0/oauth/access_token'))).toBe(true);
		const { viaUnified } = await import('../server/platforms/instagram.js');
		const { getAccount } = await import('../server/accounts.js');
		expect(viaUnified(getAccount(ig[0].id))).toBe(true);
	});
});

describe('Instagram through Facebook Login (no business portfolio)', () => {
	it('connects every Instagram account linked to the chosen Pages, each with its own Page token', async () => {
		const { saveSettings } = await import('../server/settings.js');
		saveSettings({ INSTAGRAM_APP_ID: '1234567', INSTAGRAM_APP_SECRET: 'sec', INSTAGRAM_LOGIN: 'facebook' });
		resetSettingsCache();
		const url = new URL((await post('/api/oauth/instagram/begin', {})).json().url);
		expect(url.origin + url.pathname).toBe('https://www.facebook.com/v27.0/dialog/oauth');
		expect(url.searchParams.get('scope')).toContain('instagram_content_publish');
		expect(url.searchParams.get('config_id')).toBeNull();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: any) => {
			const s = String(u);
			if (s.includes('fb_exchange_token')) return new Response(JSON.stringify({ access_token: 'long-user', expires_in: 5184000 }), { status: 200 });
			if (s.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'short-user' }), { status: 200 });
			if (s.includes('/me/accounts')) return new Response(JSON.stringify({ data: [
				{ id: 'p1', name: 'Voltsys Page', access_token: 'page-token-1', instagram_business_account: { id: '1789', username: 'voltsys' } },
				{ id: 'p2', name: 'No IG Page', access_token: 'page-token-2' },
				{ id: 'p3', name: 'Onuha Page', access_token: 'page-token-3', instagram_business_account: { id: '1790', username: 'onuhafx' } },
			] }), { status: 200 });
			return new Response('{}', { status: 200 });
		});
		await app.inject({ method: 'GET', url: `/api/oauth/instagram/callback?code=abc&state=${url.searchParams.get('state')}` });
		const ig = (await get('/api/accounts')).json().filter((a: any) => a.platform === 'instagram');
		expect(ig.map((a: any) => a.handle).sort()).toEqual(['@onuhafx', '@voltsys']);
		const { accessToken } = await import('../server/accounts.js');
		const tokens = await Promise.all(ig.map((a: any) => accessToken(a.id)));
		expect(tokens.sort()).toEqual(['page-token-1', 'page-token-3']);
	});
});
