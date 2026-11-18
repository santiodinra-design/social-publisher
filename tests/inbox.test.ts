// Drafts only, and the inbox folder that turns dropped videos into drafts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../server/media.js', async (orig) => ({
	...(await orig<typeof import('../server/media.js')>()),
	probe: async (_f: string, size: number) => ({ size, duration: 30, width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac', fps: 30, container: 'mp4' }),
}));

const { buildApp } = await import('../server/app.js');
const { config } = await import('../server/config.js');
const { getDb } = await import('../server/db.js');
const { createGroup } = await import('../server/groups.js');
const { saveSettings } = await import('../server/settings.js');
const { startInbox, pickAccounts } = await import('../server/inbox.js');
const { freshDb, seedAccount, seedMedia } = await import('./helpers.js');

let app: FastifyInstance;
let dir: string;
const H = { 'x-requested-with': 'social-publisher' };

beforeEach(async () => {
	freshDb();
	config.noSignIn = true;
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-inbox-'));
	process.env.INBOX_DIR = dir;
	app = await buildApp();
});
afterEach(async () => {
	config.noSignIn = false;
	delete process.env.INBOX_DIR;
	await app.close();
});

const settingsOf = (postId: string) => (getDb().prepare('SELECT platform, settings FROM targets WHERE post_id = ? ORDER BY platform').all(postId) as { platform: string; settings: string }[]).map((r) => ({ platform: r.platform, ...JSON.parse(r.settings) }));
const drop = (name: string, json: object) => {
	fs.writeFileSync(path.join(dir, `${name}.mp4`), Buffer.alloc(4096, 1));
	fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(json));
};

describe('drafts only', () => {
	it('is on by default: keeps the chosen YouTube visibility and turns TikTok Direct into the inbox', async () => {
		expect((await app.inject({ method: 'GET', url: '/api/config' })).json().draftsOnly).toBe(true);
		const yt = seedAccount('youtube');
		const tt = seedAccount('tiktok');
		const m = seedMedia();
		const r = await app.inject({ method: 'POST', url: '/api/posts', headers: H, payload: { idempotencyKey: 'drafts-1234', mediaId: m, caption: 'hi', targets: [{ accountId: yt.id, settings: { title: 'T', privacy: 'public', madeForKids: false } }, { accountId: tt.id, settings: { mode: 'direct', privacy: 'PUBLIC_TO_EVERYONE' } }] } });
		expect(r.statusCode).toBe(200);
		const s = settingsOf(r.json().post.id);
		expect(s.find((x) => x.platform === 'youtube').privacy).toBe('public');
		expect(s.find((x) => x.platform === 'tiktok')).toMatchObject({ mode: 'inbox', privacy: 'SELF_ONLY' });
	});
	it('refuses Instagram while on, and allows it when turned off', async () => {
		const ig = seedAccount('instagram');
		const body = () => ({ idempotencyKey: `ig-${Math.random()}`, mediaId: seedMedia(), caption: 'hi', targets: [{ accountId: ig.id, settings: { shareToFeed: true } }] });
		const r = await app.inject({ method: 'POST', url: '/api/posts', headers: H, payload: body() });
		expect(r.statusCode).toBe(422);
		expect(JSON.stringify(r.json())).toMatch(/Instagram has no drafts/);
		await app.inject({ method: 'PUT', url: '/api/desktop/prefs', headers: H, payload: { draftsOnly: false } });
		expect((await app.inject({ method: 'GET', url: '/api/desktop/prefs' })).json().draftsOnly).toBe(false);
		expect((await app.inject({ method: 'POST', url: '/api/posts', headers: H, payload: body() })).statusCode).toBe(200);
	});
});

describe('inbox folder', () => {
	it('lets the JSON choose the YouTube visibility', async () => {
		seedAccount('youtube');
		const inbox = startInbox(app, 60_000);
		drop('quiet', { title: 'Quiet one', caption: 'x', privacy: 'unlisted' });
		await inbox.scan();
		await inbox.scan();
		inbox.stop();
		const r = JSON.parse(fs.readFileSync(path.join(dir, 'Sent', 'quiet.result.json'), 'utf8'));
		expect(settingsOf(r.postId)[0].privacy).toBe('unlisted');
	});
	it('sends a dropped video to YouTube (Public by default) and the TikTok inbox, never Instagram, then files it under Sent', async () => {
		const yt = seedAccount('youtube');
		seedAccount('tiktok');
		seedAccount('instagram');
		const inbox = startInbox(app, 60_000);
		expect(fs.existsSync(path.join(dir, 'README.txt'))).toBe(true);
		drop('story-1', { title: 'Roblox story', caption: 'Wait for it #roblox' });
		await inbox.scan(); // first sight: waits for the file to stop growing
		await inbox.scan();
		inbox.stop();
		expect(fs.readdirSync(dir).filter((f) => f.startsWith('story-1'))).toEqual([]);
		const result = JSON.parse(fs.readFileSync(path.join(dir, 'Sent', 'story-1.result.json'), 'utf8'));
		const s = settingsOf(result.postId);
		expect(s.map((x) => x.platform)).toEqual(['tiktok', 'youtube']);
		expect(s.find((x) => x.platform === 'youtube')).toMatchObject({ title: 'Roblox story', description: 'Wait for it #roblox', privacy: 'public' });
		expect(s.find((x) => x.platform === 'tiktok')).toMatchObject({ mode: 'inbox' });
		expect(getDb().prepare('SELECT caption FROM posts WHERE id = ?').get(result.postId)).toMatchObject({ caption: 'Wait for it #roblox' });
		expect(yt.id).toBeTruthy();
	});
	it('uses a saved group or named accounts', async () => {
		const a = seedAccount('youtube', { externalId: 'a' });
		const b = seedAccount('youtube', { externalId: 'b' });
		getDb().prepare("UPDATE accounts SET display_name = 'Voltsys', handle = '@voltsysan' WHERE id = ?").run(a.id);
		const t = seedAccount('tiktok');
		createGroup('Roblox', [a.id, t.id]);
		expect(pickAccounts({ group: 'roblox' }).map((x) => x.id).sort()).toEqual([a.id, t.id].sort());
		expect(pickAccounts({ accounts: ['@voltsysan'] }).map((x) => x.id)).toEqual([a.id]);
		expect(() => pickAccounts({ group: 'Nope' })).toThrow(/no group called "Nope"/);
		expect(() => pickAccounts({ accounts: ['ghost'] })).toThrow(/"ghost"/);
		expect(b.id).toBeTruthy();
	});
	it('moves a broken drop to Needs attention with the reason', async () => {
		seedAccount('youtube');
		const inbox = startInbox(app, 60_000);
		fs.writeFileSync(path.join(dir, 'bad.mp4'), Buffer.alloc(10, 1));
		fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
		await inbox.scan();
		await inbox.scan();
		inbox.stop();
		const err = fs.readFileSync(path.join(dir, 'Needs attention', 'bad.error.txt'), 'utf8');
		expect(err).toMatch(/not valid JSON/);
		expect((await app.inject({ method: 'GET', url: '/api/inbox' })).json().recent[0]).toMatchObject({ name: 'bad.mp4', status: 'failed' });
	});
	it('waits for the JSON file before sending', async () => {
		seedAccount('youtube');
		const inbox = startInbox(app, 60_000);
		fs.writeFileSync(path.join(dir, 'later.mp4'), Buffer.alloc(10, 1));
		await inbox.scan();
		await inbox.scan();
		inbox.stop();
		expect(fs.existsSync(path.join(dir, 'later.mp4'))).toBe(true);
	});
});
void saveSettings;

describe('TikTok caption hand-off', () => {
	it('puts the TikTok caption in the finish notice so the app can copy it', async () => {
		const { summarize } = await import('../server/notify.js');
		const n = summarize('p', [{ platform: 'tiktok', state: 'needs_attention', error: 'Sent to your TikTok inbox' }], 'Wait for it #roblox', 'a.mp4', false, 'Wait for it #roblox');
		expect(n).toMatchObject({ title: 'Sent to your TikTok inbox', copy: 'Wait for it #roblox' });
		expect(n.body).toMatch(/Caption copied/);
	});
});
