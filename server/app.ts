import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { config, configured } from './config.js';
import { getDb, now, workerStatus, type Platform } from './db.js';
import { pkcePair, randomId, readSignedToken, redact, signedToken } from './crypto.js';
import { accessToken, disconnect, getAccount, listAccounts, markAccount, upsertAccount } from './accounts.js';
import { cancelScheduled, createPost, listPosts, markPosted, PLATFORM_LABEL, postView, reschedule, retryTargets, tiktokLink, validScheduleTime } from './jobs.js';
import * as covers from './covers.js';
import { report } from './analytics.js';
import { clean as cleanGroup, createGroup, deleteGroup, listGroups, updateGroup } from './groups.js';
import { enabled as notifyEnabled } from './notify.js';
import { LIMITS, isShortsShape, probe, validateMedia, VIDEO_MIME, type Issue } from './media.js';
import { ADAPTERS, adapterFor, PLATFORMS } from './platforms/index.js';
import { checkKeys, draftsOnly, FIELDS, saveSettings, setupView } from './settings.js';
import { inboxStatus } from './inbox.js';
import type { MediaRow } from './platforms/types.js';
import { AuthError } from './platforms/types.js';

/** Extras shared with the Windows build that the Node server provides too. */
const FEATURES = ['schedule', 'markPosted', 'repost', 'covers', 'analytics', 'groups', 'draftsOnly'];

/**
 * Drafts only: TikTok always goes to the inbox (the owner finishes it in TikTok) and Instagram, which
 * has no drafts in its API, is refused. YouTube keeps the visibility the owner chose.
 */
export function asDraft(platform: Platform, s: Record<string, unknown>): Record<string, unknown> | null {
	if (platform === 'youtube') return s;
	if (platform === 'tiktok') return { ...s, mode: 'inbox', privacy: 'SELF_ONLY' };
	return null;
}
export const DRAFTS_INSTAGRAM = 'Drafts only is on, and Instagram has no drafts for apps. Post this Reel from the Instagram app, or turn off Drafts only.';
const SESSION = 'sp_session';
const DESKTOP = 'sp_desktop';
const OAUTH = 'sp_oauth';

export async function buildApp(opts: { logger?: boolean } = {}) {
	const app = Fastify({
		logger: opts.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'], serializers: { req: (r) => ({ method: r.method, url: redact(r.url) }) } } : false,
		bodyLimit: 1024 * 1024,
		// Signed media links (/m/:token) are longer than Fastify's 100-character default.
		maxParamLength: 2048,
		trustProxy: true,
	});
	await app.register(cookie, { secret: config.sessionSecret });
	app.addContentTypeParser(['application/octet-stream', ...VIDEO_MIME], (_req, payload, done) => done(null, payload));
	// Cover images arrive as raw JPEG/PNG bytes (checked again by their first bytes in covers.ts).
	app.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: covers.MAX_BYTES + 1024 }, (_req, body, done) => done(null, body));

	const secure = config.appUrl.startsWith('https');
	const desktopOk = (req: FastifyRequest) => {
		const got = Buffer.from(String(req.cookies[DESKTOP] ?? ''));
		const want = Buffer.from(config.desktopToken);
		return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
	};
	// Desktop: only the app's own window holds the per-launch cookie. Loopback alone is not trusted.
	const authed = (req: FastifyRequest) => (config.desktop ? desktopOk(req) : config.noSignIn || Boolean(readSignedToken<{ u: string }>(req.cookies[SESSION])));
	const isOpen = (url: string) => url === '/api/session' || url.startsWith('/m/') || /^\/api\/oauth\/[a-z]+\/callback$/.test(url) || !url.startsWith('/api/');

	app.addHook('onRequest', async (req, reply) => {
		const url = req.url.split('?')[0];
		const open = isOpen(url);
		if (!open && !authed(req)) return reply.code(401).send({ error: 'Sign in first.' });
		// Simple CSRF guard: state-changing API calls must come from this app.
		if (!open && !['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'social-publisher') return reply.code(403).send({ error: 'Blocked request.' });
	});

	// ---------- Terms and Privacy pages (public; platform developer consoles ask for these links) ----------
	const page = (title: string, body: string) =>
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publisher · ${title}</title><style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#ddd;background:#16161a}h1{font-size:24px}h2{font-size:17px;margin-top:28px}</style><h1>${title}</h1>${body}<p style="color:#888;margin-top:32px">Last updated 16 November 2026</p></html>`;
	app.get('/terms', async (_req, reply) =>
		reply.type('text/html').send(page('Terms of Service', `
<p>Publisher is a private, single-user tool. Its owner uses it to upload their own videos to their own YouTube, Instagram and TikTok accounts. It is not offered to the public.</p>
<h2>Use</h2><p>Only the owner may use Publisher, and only with accounts they own or are allowed to manage. Each post is started by the owner. Publisher never posts on its own.</p>
<h2>Platforms</h2><p>Using Publisher with YouTube, Instagram or TikTok is also subject to those platforms' own terms and community guidelines. The owner is responsible for the content they post, including having the rights to any music.</p>
<h2>No warranty</h2><p>Publisher is provided as is, without any warranty.</p>`)));
	app.get('/privacy', async (_req, reply) =>
		reply.type('text/html').send(page('Privacy Policy', `
<p>Publisher is a private tool that runs on its owner's own computer. It has no other users and no servers of its own.</p>
<h2>What it stores</h2><p>When the owner connects an account, Publisher stores the sign-in token and basic profile details (name, handle, avatar) on the owner's computer, encrypted with a key protected by the macOS Keychain. It also keeps the owner's videos, captions and post history there.</p>
<h2>How it is used</h2><p>This data is used only to upload the owner's videos and to show their own post statistics. Publisher has no ads or analytics trackers, and it does not sell or share data with anyone except the platform a video is being posted to.</p>
<h2>Deleting data</h2><p>Disconnecting an account in Publisher deletes its token. Access can also be removed at any time in the platform's own app settings. Uploaded video copies are deleted automatically after a few days.</p>`)));

	// ---------- session ----------
	const tries = new Map<string, { n: number; at: number }>();
	app.post('/api/session', async (req, reply) => {
		if (config.desktop) return reply.code(403).send({ error: 'This server belongs to the Publisher desktop app. Open the app instead.' });
		const ip = req.ip;
		const t = tries.get(ip);
		if (t && t.n >= 8 && now() - t.at < 10 * 60_000) return reply.code(429).send({ error: 'Too many attempts. Try again in 10 minutes.' });
		const body = z.object({ password: z.string().min(1) }).safeParse(req.body);
		const a = Buffer.from(body.success ? body.data.password : '');
		const b = Buffer.from(config.appPassword);
		if (!body.success || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
			tries.set(ip, { n: (t?.n ?? 0) + 1, at: now() });
			return reply.code(401).send({ error: 'Wrong password.' });
		}
		tries.delete(ip);
		reply.setCookie(SESSION, signedToken({ u: 'owner' }, 14 * 86400), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 14 * 86400 });
		return { ok: true };
	});
	app.get('/api/session', async (req) => ({ signedIn: authed(req), demoMode: config.demoMode, noSignIn: config.noSignIn && !config.desktop, desktop: config.desktop }));
	// Worker health comes from the worker's own heartbeat, not from this server answering.
	app.get('/api/status', async () => {
		const db = getDb();
		const active = (db.prepare("SELECT COUNT(*) AS n FROM targets WHERE state IN ('queued','uploading','processing')").get() as { n: number }).n;
		return { worker: workerStatus(), activeJobs: active, noSignIn: config.noSignIn && !config.desktop, demoMode: config.demoMode, now: now() };
	});
	app.delete('/api/session', async (_req, reply) => {
		reply.clearCookie(SESSION, { path: '/' });
		return { ok: true };
	});

	// ---------- config ----------
	app.get('/api/config', async () => ({
		demoMode: config.demoMode,
		publicBaseUrl: Boolean(config.publicBaseUrl),
		// Extras shared with the Windows build. The UI shows a feature only when it is listed here.
		features: [...FEATURES, ...(config.desktop ? ['notifications', 'inbox'] : [])],
		draftsOnly: draftsOnly(),
		platforms: Object.fromEntries(PLATFORMS.map((p) => [p, { configured: configured[p](), ...ADAPTERS[p].availability(), limits: LIMITS[p] }])),
	}));

	// ---------- platform app keys (entered in the app) ----------
	app.get('/api/setup', async () => setupView());
	app.put('/api/setup/:platform', async (req, reply) => {
		const platform = (req.params as any).platform as Platform;
		if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: 'Unknown platform' });
		const b = z.object({ id: z.string().max(300).default(''), secret: z.string().max(300).default(''), publicBaseUrl: z.string().max(300).optional(), configId: z.string().max(60).optional(), loginMode: z.enum(['unified', 'facebook', 'instagram']).optional() }).safeParse(req.body ?? {});
		if (!b.success) return reply.code(400).send({ error: 'Check the fields.' });
		const issues = checkKeys(platform, b.data.id, b.data.secret);
		if (b.data.publicBaseUrl && !/^https:\/\/[^\s/]+(\/.*)?$/.test(b.data.publicBaseUrl.trim())) issues.push({ field: 'publicBaseUrl', message: 'Use the full https:// address of your tunnel.' });
		const igMode = platform === 'instagram' ? (b.data.loginMode ?? (b.data.configId?.trim() ? 'unified' : undefined)) : undefined;
		if (igMode === 'unified' && !b.data.configId?.trim() && !config.instagram.configId) issues.push({ field: 'configId', message: 'Paste the Configuration ID from your Unified login configuration.' });
		if (platform === 'instagram' && b.data.configId?.trim() && !/^\d{6,}$/.test(b.data.configId.trim())) issues.push({ field: 'configId', message: 'The configuration ID is a number.' });
		if (issues.length) return reply.code(422).send({ error: 'Check the highlighted fields.', issues });
		const f = FIELDS[platform];
		saveSettings({ [f.id]: b.data.id.trim(), [f.secret]: b.data.secret.trim(), ...(b.data.publicBaseUrl !== undefined ? { PUBLIC_BASE_URL: b.data.publicBaseUrl.trim().replace(/\/$/, '') } : {}), ...(platform === 'instagram' && b.data.configId?.trim() && igMode === 'unified' ? { INSTAGRAM_CONFIG_ID: b.data.configId.trim() } : {}),
			// The connection type decides the sign-in: only Unified login keeps a configuration ID.
			...(igMode && igMode !== 'unified' ? { INSTAGRAM_CONFIG_ID: null, INSTAGRAM_LOGIN: igMode === 'facebook' ? 'facebook' : null } : {}),
			...(igMode === 'unified' ? { INSTAGRAM_LOGIN: null } : {}) });
		return setupView();
	});
	app.delete('/api/setup/:platform', async (req, reply) => {
		const platform = (req.params as any).platform as Platform;
		if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: 'Unknown platform' });
		const f = FIELDS[platform];
		saveSettings({ [f.id]: null, [f.secret]: null });
		return setupView();
	});
	app.put('/api/setup/public-url', async (req, reply) => {
		const b = z.object({ publicBaseUrl: z.string().max(300) }).safeParse(req.body ?? {});
		const v = b.success ? b.data.publicBaseUrl.trim().replace(/\/$/, '') : '';
		if (v && !/^https:\/\/[^\s/]+(\/.*)?$/.test(v)) return reply.code(422).send({ error: 'Use the full https:// address of your tunnel.', issues: [{ field: 'publicBaseUrl', message: 'Use the full https:// address of your tunnel.' }] });
		saveSettings({ PUBLIC_BASE_URL: v || null });
		return setupView();
	});

	// ---------- accounts and OAuth ----------
	app.get('/api/accounts', async () => listAccounts());
	app.delete('/api/accounts/:id', async (req, reply) => {
		try {
			await disconnect((req.params as any).id);
			return { ok: true };
		} catch (e: any) {
			return reply.code(409).send({ error: e.message });
		}
	});
	// Live, read-only check: asks the platform who this token belongs to. Nothing is posted.
	app.post('/api/accounts/:id/verify', async (req, reply) => {
		const a = getAccount((req.params as any).id);
		if (!a || a.status === 'disconnected') return reply.code(404).send({ error: 'Account not found.' });
		const checkedAt = now();
		if (a.is_demo) return { ok: true, simulated: true, checkedAt, message: 'Demo account: no live check is possible.' };
		try {
			const token = await accessToken(a.id);
			const who = await adapterFor(a.platform, false).identity(token, { accessToken: token });
			if (String(who.externalId) !== String(a.external_id)) return { ok: false, checkedAt, message: `Signed in as ${who.displayName}, which is a different account from the one saved here. Reconnect the right account.` };
			markAccount(a.id, 'connected', null);
			return { ok: true, checkedAt, message: `${PLATFORM_LABEL[a.platform]} confirmed this is ${who.displayName}.` };
		} catch (e: any) {
			const auth = e instanceof AuthError;
			if (auth) markAccount(a.id, 'reconnect_required', e.message);
			return { ok: false, checkedAt, reconnect: auth, message: auth ? 'Sign-in expired or was revoked. Reconnect this account.' : `Could not reach ${PLATFORM_LABEL[a.platform]} right now (${e?.message ?? e}). This does not mean the connection is broken.` };
		}
	});
	app.post('/api/demo/accounts', async (_req, reply) => {
		if (!config.demoMode) return reply.code(404).send({ error: 'Demo mode is off.' });
		const demo = [
			['tiktok', 'demo-tt', 'Demo TikTok', '@demo.tiktok'],
			['instagram', 'demo-ig', 'Demo Instagram', '@demo.reels'],
			['youtube', 'demo-yt', 'Demo YouTube', '@demochannel'],
		] as const;
		for (const [p, id, name, handle] of demo) upsertAccount(p, { externalId: id, displayName: name, handle }, { accessToken: 'demo' }, true);
		return listAccounts();
	});

	// Sign-in state lives on the server (one use, 10 minutes), so the callback works even when it
	// arrives in the system browser, which does not share the app window's cookies.
	const pending = new Map<string, { verifier: string; platform: Platform; exp: number }>();
	const beginOAuth = (platform: Platform) => {
		for (const [k, v] of pending) if (v.exp < now()) pending.delete(k);
		const state = randomId(18);
		const { verifier, challenge } = pkcePair();
		pending.set(state, { verifier, platform, exp: now() + 600_000 });
		return ADAPTERS[platform].authorizeUrl(state, challenge);
	};
	app.post('/api/oauth/:platform/begin', async (req, reply) => {
		const platform = (req.params as any).platform as Platform;
		if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: 'Unknown platform' });
		if (!configured[platform]()) return reply.code(409).send({ error: `${PLATFORM_LABEL[platform]} is not set up yet. Add its app keys first.` });
		return { url: beginOAuth(platform) };
	});
	app.get('/api/oauth/:platform/start', async (req, reply) => {
		const platform = (req.params as any).platform as Platform;
		if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: 'Unknown platform' });
		if (!configured[platform]()) return reply.redirect(`${config.appUrl}/accounts?error=${encodeURIComponent(`${platform} is not set up yet. Add its app keys first.`)}`);
		return reply.redirect(beginOAuth(platform));
	});

	app.get('/api/oauth/:platform/callback', async (req, reply) => {
		const platform = (req.params as any).platform as Platform;
		const q = req.query as Record<string, string>;
		const saved = q.state ? pending.get(q.state) : undefined;
		if (q.state) pending.delete(q.state); // one use only
		// The desktop app's callback opens in the system browser, so answer with a small page there.
		const done = (ok: boolean, msg: string) =>
			config.desktop
				? reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(callbackPage(ok, msg))
				: reply.redirect(`${config.appUrl}/accounts?${ok ? 'connected' : 'error'}=${encodeURIComponent(msg)}`);
		const fail = (msg: string) => done(false, msg);
		if (q.error === 'access_denied' || q.error_reason === 'user_denied')
			return fail(
				platform === 'youtube'
					? 'Google cancelled the sign-in. Try Connect again: on "Google hasn\'t verified this app" click Continue (not Back to safety), then tick every permission box and click Continue. The Google account must also be a Test user on your consent screen while the app is in Testing.'
					: `${PLATFORM_LABEL[platform] ?? platform} cancelled the sign-in. Try Connect again and allow every permission it asks for. While your developer app is in testing, this account must be added as a tester there.`,
			);
		if (q.error) return fail(`${platform}: ${q.error_description || q.error_reason || q.error}`);
		if (!saved || saved.platform !== platform || saved.exp < now()) return fail('The sign-in link expired or did not match. Please try connecting again from the app.');
		if (!q.code) return fail('The platform did not return an authorization code.');
		try {
			const adapter = ADAPTERS[platform];
			const tokens = await adapter.exchangeCode(q.code, saved.verifier);
			const ids = adapter.identities ? await adapter.identities(tokens.accessToken, tokens) : [await adapter.identity(tokens.accessToken, tokens)];
			const names = ids.map((id) => upsertAccount(platform, id, id.tokens ?? tokens).display_name);
			return done(true, names.join(', '));
		} catch (e: any) {
			req.log?.warn({ platform }, 'oauth exchange failed');
			return fail(`Could not connect ${platform}: ${redact(e?.message ?? String(e))}`);
		}
	});

	// ---------- media ----------
	app.put('/api/media', async (req, reply) => {
		const mime = String(req.headers['content-type'] ?? '').split(';')[0];
		const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'video.mp4')).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
		const length = Number(req.headers['content-length'] ?? 0);
		if (!VIDEO_MIME.includes(mime) && mime !== 'application/octet-stream') return reply.code(415).send({ error: 'Only video files can be published.' });
		if (length > config.maxUploadBytes) return reply.code(413).send({ error: 'File is too large.' });
		const id = randomId(12);
		const ext = (filename.split('.').pop() ?? 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
		const dir = path.join(config.dataDir, 'media');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${id}.${ext}`);
		let size = 0;
		const counter = new Transform({
			transform(chunk, _e, cb) {
				size += chunk.length;
				if (size > config.maxUploadBytes) return cb(new Error('too large'));
				cb(null, chunk);
			},
		});
		try {
			await pipeline(req.body as NodeJS.ReadableStream, counter, fs.createWriteStream(file));
		} catch {
			fs.rmSync(file, { force: true });
			return reply.code(400).send({ error: 'Upload was interrupted. Try again.' });
		}
		const info = await probe(file, size);
		if (!info.videoCodec) {
			fs.rmSync(file, { force: true });
			return reply.code(422).send({ error: 'This file has no video stream. Only videos can be published.' });
		}
		const detected = mime === 'application/octet-stream' ? ({ mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4' } as any)[ext] ?? mime : mime;
		getDb()
			.prepare('INSERT INTO media (id, path, filename, mime, size, duration, width, height, video_codec, audio_codec, fps, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
			.run(id, file, filename, detected, size, info.duration, info.width, info.height, info.videoCodec, info.audioCodec, info.fps, now());
		return mediaView(getDb().prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow);
	});

	// Lets a saved draft find its video again. Returns 404 once the file is cleaned up.
	app.get('/api/media/:id', async (req, reply) => {
		const m = getDb().prepare('SELECT * FROM media WHERE id = ? AND deleted_at IS NULL').get((req.params as any).id) as MediaRow | undefined;
		if (!m || !fs.existsSync(m.path)) return reply.code(404).send({ error: 'This video is no longer on this computer. Upload it again.' });
		return { ...mediaView(m), previewUrl: `/m/${signedToken({ media: m.id }, 2 * 3600)}` };
	});

	// Signed, short-lived public URL so Instagram can download the video.
	app.get('/m/:token', async (req, reply) => {
		const data = readSignedToken<{ media: string }>((req.params as any).token);
		if (!data) return reply.code(404).send('Not found');
		const m = getDb().prepare('SELECT * FROM media WHERE id = ? AND deleted_at IS NULL').get(data.media) as MediaRow | undefined;
		if (!m || !fs.existsSync(m.path)) return reply.code(404).send('Not found');
		return sendFile(req, reply, m);
	});

	// ---------- posts ----------
	const targetSchema = z.object({ accountId: z.string().min(1), settings: z.record(z.string(), z.any()).default({}) });
	const scheduleMsg = 'Pick a time at least a minute from now and within 60 days.';
	const postSchema = z.object({
		idempotencyKey: z.string().min(8).max(100),
		mediaId: z.string().min(1),
		caption: z.string().max(5000).default(''),
		targets: z.array(targetSchema).min(1, 'Choose at least one destination.'),
		scheduledAt: z.number().nullish().refine((v) => v == null || validScheduleTime(v), scheduleMsg),
	});

	app.post('/api/posts', async (req, reply) => {
		const parsed = postSchema.safeParse(req.body);
		if (!parsed.success) return reply.code(400).send({ error: 'Check the highlighted fields.', issues: parsed.error.issues.map((i) => ({ field: i.path.join('.') || 'form', message: i.message })) });
		const body = parsed.data;
		const db = getDb();
		const already = db.prepare('SELECT id FROM posts WHERE idempotency_key = ?').get(body.idempotencyKey) as { id: string } | undefined;
		if (already) return { post: postView(already.id), duplicate: true };
		const media = db.prepare('SELECT * FROM media WHERE id = ? AND deleted_at IS NULL').get(body.mediaId) as MediaRow | undefined;
		if (!media) return reply.code(400).send({ error: 'Upload the video again.', issues: [{ field: 'media', message: 'The uploaded video is no longer available.' }] });
		const issues: Issue[] = [];
		const targets = [] as { accountId: string; platform: Platform; settings: Record<string, unknown> }[];
		const seen = new Set<string>();
		let demo: boolean | null = null;
		for (const t of body.targets) {
			const a = getAccount(t.accountId);
			if (!a || a.status === 'disconnected') {
				issues.push({ field: `target.${t.accountId}`, message: 'This account is not connected.' });
				continue;
			}
			if (seen.has(a.id)) continue;
			seen.add(a.id);
			if (demo === null) demo = Boolean(a.is_demo);
			if (demo !== Boolean(a.is_demo)) issues.push({ field: `target.${a.id}`, message: 'Demo accounts and real accounts cannot be in the same post.' });
			if (a.status === 'reconnect_required') issues.push({ field: `target.${a.id}`, message: `Reconnect ${a.display_name} before publishing.` });
			let settings = t.settings;
			if (draftsOnly()) {
				const d = asDraft(a.platform, settings);
				if (!d) {
					issues.push({ field: `target.${a.id}`, message: DRAFTS_INSTAGRAM });
					continue;
				}
				settings = d;
			}
			const adapter = adapterFor(a.platform, Boolean(a.is_demo));
			const av = adapter.availability();
			if (!av.available) issues.push({ field: `target.${a.id}`, message: av.note });
			const caption = String(settings.captionOverride ?? '').trim() || body.caption;
			for (const i of [...validateMedia(a.platform, { ...mediaInfo(media), mime: media.mime, filename: media.filename }), ...adapter.validateSettings(settings, caption, mediaInfo(media)), ...covers.issues(a.platform, settings)]) {
				issues.push({ field: i.field === 'media' ? `media.${a.platform}` : i.field, message: i.message });
			}
			targets.push({ accountId: a.id, platform: a.platform, settings });
		}
		if (issues.length) return reply.code(422).send({ error: 'Fix the highlighted fields before publishing.', issues });
		const r = createPost({ idempotencyKey: body.idempotencyKey, mediaId: media.id, caption: body.caption, isDemo: Boolean(demo), targets, scheduledAt: body.scheduledAt ?? null });
		return { post: postView(r.id), duplicate: r.duplicate };
	});

	app.get('/api/posts', async () => listPosts());
	app.get('/api/posts/:id', async (req, reply) => postView((req.params as any).id) ?? reply.code(404).send({ error: 'Not found' }));
	app.post('/api/posts/:id/retry', async (req, reply) => {
		const b = z.object({ targetIds: z.array(z.string()).optional() }).safeParse(req.body ?? {});
		const ids = retryTargets((req.params as any).id, b.success ? b.data.targetIds : undefined);
		if (!ids.length) return reply.code(409).send({ error: 'Nothing to retry. Only failed destinations can be retried.' });
		return { retried: ids, post: postView((req.params as any).id) };
	});

	app.post('/api/posts/:id/schedule', async (req, reply) => {
		const at = (req.body as any)?.at ?? null;
		if (at !== null && !validScheduleTime(at)) return reply.code(422).send({ error: scheduleMsg, issues: [{ field: 'scheduledAt', message: scheduleMsg }] });
		if (!reschedule((req.params as any).id, at)) return reply.code(409).send({ error: 'This post has already started publishing, so its time cannot change.' });
		return { post: postView((req.params as any).id) };
	});
	app.post('/api/posts/:id/cancel', async (req, reply) => {
		if (!cancelScheduled((req.params as any).id)) return reply.code(409).send({ error: 'Nothing to cancel. Only destinations still waiting for their time can be cancelled.' });
		return { post: postView((req.params as any).id) };
	});
	app.post('/api/targets/:id/posted', async (req, reply) => {
		const link = tiktokLink(String((req.body as any)?.permalink ?? ''));
		if (!link.ok) return reply.code(422).send({ error: link.message, issues: [{ field: 'permalink', message: link.message }] });
		try {
			return { post: postView(markPosted((req.params as any).id, link.link)) };
		} catch (e: any) {
			return reply.code(e.message === 'Not found' ? 404 : 409).send({ error: e.message });
		}
	});

	// ---------- cover images ----------
	app.put('/api/covers', { bodyLimit: covers.MAX_BYTES + 1024 }, async (req, reply) => {
		let body = req.body as any;
		if (body && typeof body.pipe === 'function') {
			const chunks: Buffer[] = [];
			let n = 0;
			for await (const c of body as AsyncIterable<Buffer>) {
				n += c.length;
				if (n > covers.MAX_BYTES) return reply.code(422).send({ error: 'Cover images can be up to 8 MB.' });
				chunks.push(c);
			}
			body = Buffer.concat(chunks);
		}
		const r = covers.save(Buffer.isBuffer(body) ? body : Buffer.alloc(0));
		return r.ok ? r.view : reply.code(422).send({ error: r.message });
	});
	app.get('/api/covers/:id', async (req, reply) => {
		const m = covers.get((req.params as any).id);
		return m ? sendFile(req, reply, m) : reply.code(404).send('Not found');
	});

	// ---------- saved account groups ----------
	app.get('/api/groups', async () => listGroups());
	app.post('/api/groups', async (req, reply) => {
		const c = cleanGroup((req.body as any)?.name, (req.body as any)?.accountIds);
		return c.ok ? createGroup(c.name, c.ids) : reply.code(422).send({ error: c.message });
	});
	app.put('/api/groups/:id', async (req, reply) => {
		const c = cleanGroup((req.body as any)?.name, (req.body as any)?.accountIds);
		if (!c.ok) return reply.code(422).send({ error: c.message });
		return updateGroup((req.params as any).id, c.name, c.ids) ? listGroups() : reply.code(404).send({ error: 'Not found' });
	});
	app.delete('/api/groups/:id', async (req, reply) => (deleteGroup((req.params as any).id) ? listGroups() : reply.code(404).send({ error: 'Not found' })));

	// ---------- stats ----------
	app.get('/api/analytics', async (req) => {
		const q = req.query as Record<string, string | undefined>;
		return report(Number(q.days ?? 28), q.account || undefined, q.fresh === '1');
	});

	// ---------- desktop preferences ----------
	const prefs = () => ({ notifications: notifyEnabled(), draftsOnly: draftsOnly() });
	app.get('/api/desktop/prefs', async () => prefs());
	app.put('/api/desktop/prefs', async (req) => {
		const b = (req.body as any) ?? {};
		if (typeof b.notifications === 'boolean') saveSettings({ NOTIFY: b.notifications ? null : 'off' });
		if (typeof b.draftsOnly === 'boolean') saveSettings({ DRAFTS_ONLY: b.draftsOnly ? null : 'off' });
		return prefs();
	});

	// ---------- inbox folder (videos dropped by the owner's Claude sessions) ----------
	app.get('/api/inbox', async () => inboxStatus());

	// ---------- built UI ----------
	const dist = config.uiDist;
	if (fs.existsSync(dist)) {
		await app.register(fastifyStatic, { root: dist, wildcard: false });
		app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
	}
	return app;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function callbackPage(ok: boolean, msg: string) {
	const title = ok ? `Connected ${esc(msg)}` : 'Could not connect';
	const body = ok ? 'You can close this tab and go back to Publisher. The account appears in Connected accounts.' : esc(msg);
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publisher</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0c0d;color:#ecebe8;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:420px;padding:28px;border:1px solid #2a2a2c;border-radius:14px;background:#151516}b{display:block;font-size:17px;margin-bottom:6px}i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;background:${ok ? '#3ccf8b' : '#f0605e'}}</style>
<main><b><i></i>${title}</b><span>${body}</span></main>`;
}

function mediaInfo(m: MediaRow) {
	return { size: m.size, duration: m.duration, width: m.width, height: m.height, videoCodec: m.video_codec, audioCodec: m.audio_codec, fps: m.fps, container: null };
}

function mediaView(m: MediaRow) {
	return {
		id: m.id,
		filename: m.filename,
		size: m.size,
		duration: m.duration,
		width: m.width,
		height: m.height,
		videoCodec: m.video_codec,
		audioCodec: m.audio_codec,
		fps: m.fps,
		shortsShape: isShortsShape(m),
		issues: Object.fromEntries(PLATFORMS.map((p) => [p, validateMedia(p, { ...mediaInfo(m), mime: m.mime, filename: m.filename }).map((i) => i.message)])),
	};
}

function sendFile(req: FastifyRequest, reply: FastifyReply, m: MediaRow) {
	const stat = fs.statSync(m.path);
	const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
	reply.header('Accept-Ranges', 'bytes').header('Content-Type', m.mime).header('Cache-Control', 'no-store');
	if (range) {
		const start = range[1] ? Number(range[1]) : 0;
		const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
		if (start > end || start >= stat.size) return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
		reply.code(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', end - start + 1);
		return reply.send(fs.createReadStream(m.path, { start, end }));
	}
	reply.header('Content-Length', stat.size);
	return reply.send(fs.createReadStream(m.path));
}
