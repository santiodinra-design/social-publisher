// YouTube Data API v3, resumable uploads with videos.insert.
// Docs: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
// As of 2 Nov 2026, uploads from unverified projects are no longer forced to private.
// videos.insert has its own quota bucket (100 calls a day by default).
import fs from 'node:fs';
import { config, redirectUri } from '../config.js';
import * as covers from '../covers.js';
import { isShortsShape } from '../media.js';
import { form, http, json, classify } from './http.js';
import type { Adapter, Outcome, PublishContext } from './types.js';
import { AttentionError, PermanentError, RejectedError, TransientError } from './types.js';

const CHUNK = 16 * 1024 * 1024; // multiple of 256 KB

export const youtube: Adapter = {
	platform: 'youtube',

	availability() {
		return { available: true, mode: 'upload', note: 'Uploads videos and Shorts (vertical or square, up to 3 minutes).' };
	},

	validateSettings(s) {
		const out = [];
		const title = String(s.title ?? '').trim();
		if (!title) out.push({ field: 'youtube.title', message: 'YouTube needs a title.' });
		if (title.length > 100) out.push({ field: 'youtube.title', message: 'Titles can be up to 100 characters.' });
		if (/[<>]/.test(title)) out.push({ field: 'youtube.title', message: 'Titles cannot contain < or >.' });
		const d = String(s.description ?? '');
		if (Buffer.byteLength(d, 'utf8') > 5000) out.push({ field: 'youtube.description', message: 'Descriptions can be up to 5,000 bytes.' });
		if (/[<>]/.test(d)) out.push({ field: 'youtube.description', message: 'Descriptions cannot contain < or >.' });
		if (!['public', 'unlisted', 'private'].includes(s.privacy)) out.push({ field: 'youtube.privacy', message: 'Choose public, unlisted or private.' });
		if (typeof s.madeForKids !== 'boolean') out.push({ field: 'youtube.madeForKids', message: 'Say whether this video is made for kids. YouTube requires it.' });
		return out;
	},

	authorizeUrl(state, challenge) {
		const q = new URLSearchParams({
			client_id: config.youtube.clientId,
			redirect_uri: redirectUri('youtube'),
			response_type: 'code',
			scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
			access_type: 'offline',
			// Always show Google's account chooser, so a second channel can be added instead of reusing the signed-in one.
			prompt: 'select_account consent',
			include_granted_scopes: 'true',
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		});
		return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
	},

	async exchangeCode(code, verifier) {
		const t = await json('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form({ code, client_id: config.youtube.clientId, client_secret: config.youtube.clientSecret, redirect_uri: redirectUri('youtube'), grant_type: 'authorization_code', code_verifier: verifier }),
		});
		return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, accessExpiresAt: Date.now() + (t.expires_in ?? 3600) * 1000, scopes: t.scope ?? null };
	},

	async refresh(_a, refreshToken) {
		if (!refreshToken) throw new PermanentError('No refresh token stored');
		const t = await json('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form({ client_id: config.youtube.clientId, client_secret: config.youtube.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
		});
		return { accessToken: t.access_token, refreshToken, accessExpiresAt: Date.now() + (t.expires_in ?? 3600) * 1000, scopes: t.scope ?? null };
	},

	async identity(accessToken) {
		const r = await json('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${accessToken}` } });
		const ch = r.items?.[0];
		if (!ch) throw new PermanentError('This Google account has no YouTube channel. Create one first.');
		return { externalId: ch.id, displayName: ch.snippet.title, handle: ch.snippet.customUrl ?? null, avatarUrl: ch.snippet.thumbnails?.default?.url ?? null };
	},

	async revoke(accessToken, refreshToken) {
		const t = refreshToken ?? accessToken;
		if (t) await http(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => undefined);
	},

	async reconcile(ctx) {
		// A video ID means YouTube has the video: keep checking it, never upload again.
		if (ctx.target.remote_id) return 'resume';
		// No upload session was ever stored, so no bytes were sent and YouTube cannot have created a video.
		if (!ctx.ref.sessionUrl) return 'restart';
		// Ask the upload session where it stands. Lookup errors (timeouts, outages, sign-in) are thrown
		// so the runner keeps the session and checks again later.
		const st = await uploadOffset(ctx);
		if (st.videoId) ctx.save({ remoteId: st.videoId });
		return 'resume';
	},

	async run(ctx) {
		const size = ctx.media.size;
		if (!ctx.target.remote_id) {
			if (!ctx.ref.sessionUrl) {
				ctx.needFile();
				const token = await ctx.token();
				ctx.save({ state: 'uploading', phase: 'init', progress: 0 });
				const s = ctx.settings;
				const res = await http('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': ctx.media.mime || 'video/*' },
					body: JSON.stringify({
						snippet: { title: String(s.title).trim(), description: String(s.description ?? ''), categoryId: String(s.categoryId ?? '22') },
						status: { privacyStatus: s.privacy, selfDeclaredMadeForKids: Boolean(s.madeForKids), embeddable: true },
					}),
				});
				if (!res.ok) throw classify(res.status, await res.json().catch(() => null), 'YouTube');
				const sessionUrl = res.headers.get('location');
				if (!sessionUrl) throw new TransientError('YouTube did not return an upload session');
				ctx.save({ phase: 'upload', providerRef: { sessionUrl } });
			}

			let { offset, videoId } = await uploadOffset(ctx);
			if (!videoId && offset < size) ctx.needFile();
			const fd = videoId || offset >= size ? null : fs.openSync(ctx.media.path, 'r');
			try {
				while (!videoId && offset < size) {
					const end = Math.min(offset + CHUNK, size) - 1;
					const buf = Buffer.alloc(end - offset + 1);
					fs.readSync(fd!, buf, 0, buf.length, offset);
					const token = await ctx.token();
					// Record that the final part is about to go out: after this, an expired session no longer proves nothing was created.
					if (end === size - 1 && !ctx.ref.finalSent) ctx.save({ providerRef: { ...ctx.ref, finalSent: true } });
					const res = await http(ctx.ref.sessionUrl, {
						method: 'PUT',
						headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(buf.length), 'Content-Range': `bytes ${offset}-${end}/${size}` },
						body: buf,
						timeoutMs: 10 * 60_000,
					});
					if (res.status === 308) {
						offset = rangeEnd(res.headers.get('range'));
					} else if (res.status === 200 || res.status === 201) {
						videoId = (await res.json()).id;
					} else if (res.status === 404) {
						sessionGone(ctx);
					} else {
						throw classify(res.status, await res.json().catch(() => null), 'YouTube upload');
					}
					ctx.save({ state: 'uploading', progress: Math.min(1, offset / size) });
				}
			} finally {
				if (fd !== null) fs.closeSync(fd);
			}
			if (!videoId) throw new TransientError('Upload finished without a video ID; checking again');
			ctx.save({ remoteId: videoId, state: 'processing', phase: 'processing', progress: 1 });
		}

		await setThumbnail(ctx);

		// Wait for YouTube to accept the upload before calling it published.
		const id = ctx.target.remote_id!;
		for (let i = 0; i < 180; i++) {
			const token = await ctx.token();
			const r = await json(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${id}`, { headers: { Authorization: `Bearer ${token}` } });
			const v = r.items?.[0];
			const up = v?.status?.uploadStatus;
			if (up === 'rejected' || up === 'failed') throw new RejectedError(`YouTube ${up} the video: ${v.status.rejectionReason ?? v.status.failureReason ?? 'no reason given'}`);
			if (up === 'processed' || (up === 'uploaded' && v?.processingDetails?.processingStatus === 'succeeded')) {
				const short = isShortsShape(ctx.media);
				return { state: 'published', remoteId: id, permalink: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}` } satisfies Outcome;
			}
			if (up === 'uploaded' && i > 6) {
				// Uploaded and accepted; processing can take a long time, so report it with a link.
				return { state: 'published', remoteId: id, permalink: `https://www.youtube.com/watch?v=${id}`, message: 'Uploaded. YouTube is still processing higher resolutions.' };
			}
			await ctx.sleep(10_000);
		}
		throw new TransientError('YouTube is still processing the video');
	},
};

async function uploadOffset(ctx: PublishContext): Promise<{ offset: number; videoId?: string }> {
	const token = await ctx.token();
	const res = await http(ctx.ref.sessionUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${ctx.media.size}`, 'Content-Length': '0' } });
	if (res.status === 308) return { offset: rangeEnd(res.headers.get('range')) };
	if (res.status === 200 || res.status === 201) return { offset: ctx.media.size, videoId: (await res.json()).id };
	if (res.status === 404) sessionGone(ctx);
	throw classify(res.status, await res.json().catch(() => null), 'YouTube upload');
}

/**
 * Sets the custom thumbnail the owner chose, once the video exists. Best effort: YouTube only allows
 * custom thumbnails on verified channels, and a refused thumbnail must never fail a video that
 * uploaded fine, so problems are recorded as events and YouTube keeps its own thumbnail.
 */
async function setThumbnail(ctx: PublishContext) {
	const coverId = covers.chosen(ctx.settings);
	const videoId = ctx.target.remote_id;
	if (!coverId || !videoId || ctx.ref.thumbDone) return;
	const done = (msg: string) => {
		ctx.save({ providerRef: { ...ctx.ref, thumbDone: true } });
		ctx.log(msg);
	};
	const cover = covers.get(coverId);
	if (!cover) return done('The chosen thumbnail is no longer on this computer, so YouTube keeps its own.');
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(cover.path);
	} catch {
		return done('Could not read the chosen thumbnail, so YouTube keeps its own.');
	}
	let token: string;
	try {
		token = await ctx.token();
	} catch {
		return;
	}
	try {
		await json(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': cover.mime }, body: new Uint8Array(bytes), timeoutMs: 120_000 });
		done('Custom thumbnail set.');
	} catch (e: any) {
		// A network problem is worth another try on the next attempt; anything else is final.
		if (e instanceof TransientError) ctx.log(`Thumbnail not set yet: ${e.message}`);
		else done(`YouTube did not accept the thumbnail (${e?.message ?? e}). Custom thumbnails need a verified channel: youtube.com/verify.`);
	}
}

/** The resumable session no longer exists. Restarting is only safe if the final part was never sent. */
function sessionGone(ctx: PublishContext): never {
	if (!ctx.ref.finalSent) {
		ctx.save({ providerRef: null, phase: null, progress: 0 });
		throw new TransientError('YouTube upload session expired before the upload finished; starting a new one');
	}
	throw new AttentionError(
		`YouTube's upload session expired after the last part was sent, so it is not known whether the video was created. Check YouTube Studio → Content for "${String(ctx.settings.title ?? '').trim()}" before posting it again.`,
	);
}

const rangeEnd = (range: string | null) => (range ? Number(range.split('-')[1]) + 1 : 0);
