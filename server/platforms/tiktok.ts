// TikTok Content Posting API.
// Docs: https://developers.tiktok.com/docs/en/content-posting-api-get-started
//
// Direct Post from an unaudited app only works for private accounts with SELF_ONLY visibility,
// and TikTok's guidelines exclude personal tools that post to accounts you manage from the audit.
// So the default is the supported alternative: upload to the creator's TikTok inbox as a draft
// (scope video.upload), which the user finishes in the TikTok app.
import fs from 'node:fs';
import { config, redirectUri } from '../config.js';
import { form, http, json, classify } from './http.js';
import type { Adapter, Outcome, PublishContext } from './types.js';
import { AttentionError, PermanentError, RejectedError, TransientError } from './types.js';

const API = 'https://open.tiktokapis.com';
const MB = 1024 * 1024;

export function chunkPlan(size: number) {
	// Chunks must be 5–64 MB; the final chunk may be up to 128 MB. Files under 5 MB go in one chunk.
	if (size < 5 * MB) return { chunkSize: size, count: 1 };
	const chunkSize = 10 * MB;
	const count = Math.max(1, Math.floor(size / chunkSize));
	return { chunkSize, count };
}

export const tiktok: Adapter = {
	platform: 'tiktok',

	availability() {
		return config.tiktok.directPostEnabled
			? { available: true, mode: 'direct', note: 'Direct Post is enabled. TikTok blocks public posts from unaudited apps; only private (Only me) posts to a private account will go through.' }
			: { available: true, mode: 'inbox', note: 'Direct posting is unavailable for personal tools. Videos go to your TikTok inbox as drafts, and you finish posting in the TikTok app.' };
	},

	validateSettings(s, caption) {
		const out = [];
		if (caption.length > 2200) out.push({ field: 'caption.tiktok', message: 'TikTok captions are limited to 2,200 characters.' });
		if (s.mode === 'direct') {
			if (!config.tiktok.directPostEnabled) out.push({ field: 'tiktok.mode', message: 'Direct Post is not available for this app.' });
			if (!s.privacy) out.push({ field: 'tiktok.privacy', message: 'Choose who can view the post.' });
		}
		return out;
	},

	authorizeUrl(state) {
		const scopes = ['user.info.basic', 'user.info.stats', 'video.list', 'video.upload', ...(config.tiktok.directPostEnabled ? ['video.publish'] : [])];
		// disable_auto_auth=1: ask which TikTok account to use instead of silently reusing the signed-in one.
		const q = new URLSearchParams({ client_key: config.tiktok.clientKey, scope: scopes.join(','), response_type: 'code', redirect_uri: redirectUri('tiktok'), state, disable_auto_auth: '1' });
		return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
	},

	async exchangeCode(code) {
		const t = await json(`${API}/v2/oauth/token/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri('tiktok') }),
		});
		return tokenSet(t);
	},

	async refresh(_a, refreshToken) {
		if (!refreshToken) throw new PermanentError('No refresh token stored');
		const t = await json(`${API}/v2/oauth/token/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
		});
		return tokenSet(t);
	},

	async identity(accessToken, tokens) {
		const r = await json(`${API}/v2/user/info/?fields=open_id,avatar_url,display_name`, { headers: { Authorization: `Bearer ${accessToken}` } });
		const u = r.data?.user ?? {};
		return { externalId: u.open_id ?? String(tokens.scopes ?? 'tiktok'), displayName: u.display_name || 'TikTok account', avatarUrl: u.avatar_url ?? null };
	},

	async revoke(accessToken) {
		if (!accessToken) return;
		await http(`${API}/v2/oauth/revoke/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form({ client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret, token: accessToken }),
		}).catch(() => undefined);
	},

	async reconcile(ctx) {
		const publishId = ctx.ref.publishId;
		// No publish ID stored means TikTok never gave us an upload address, so no video bytes were sent.
		if (!publishId) return 'restart';
		// Lookup errors are thrown so the publish ID is kept and checked again later.
		const st = await status(ctx, publishId);
		const done = outcomeFor(ctx, st);
		if (done) return done;
		if (st.status === 'PROCESSING_UPLOAD' && !ctx.ref.uploaded) {
			// TikTok is still waiting for parts. If the last part was never sent, this upload cannot complete,
			// so starting a new one cannot produce a second video.
			if (!ctx.ref.finalSent) {
				ctx.save({ providerRef: null, phase: null, progress: 0 });
				return 'restart';
			}
			throw new TransientError('TikTok received the last part but has not confirmed the upload yet');
		}
		// TikTok has moved past the upload stage: keep checking the same publish ID.
		if (!ctx.ref.uploaded) ctx.save({ state: 'processing', phase: 'poll', progress: 1, providerRef: { ...ctx.ref, uploaded: true } });
		return 'resume';
	},

	async run(ctx) {
		const direct = ctx.settings.mode === 'direct';
		if (direct && !config.tiktok.directPostEnabled) throw new PermanentError('Direct Post is not available for this app.');
		const token = await ctx.token();
		const size = ctx.media.size;

		if (!ctx.ref.publishId || !ctx.ref.uploaded) {
			ctx.needFile();
			const plan = chunkPlan(size);
			const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count };
			let body: any = { source_info };
			if (direct) {
				const info = (await json(`${API}/v2/post/publish/creator_info/query/`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' } })).data;
				if (!info?.privacy_level_options?.includes(ctx.settings.privacy)) throw new AttentionError(`TikTok does not allow the "${ctx.settings.privacy}" privacy setting for this account right now.`);
				if (ctx.media.duration && info.max_video_post_duration_sec && ctx.media.duration > info.max_video_post_duration_sec) throw new PermanentError(`This TikTok account can post videos up to ${info.max_video_post_duration_sec} s.`);
				body.post_info = {
					title: ctx.caption,
					privacy_level: ctx.settings.privacy,
					disable_comment: !ctx.settings.allowComments,
					disable_duet: !ctx.settings.allowDuet,
					disable_stitch: !ctx.settings.allowStitch,
				};
			}
			ctx.save({ state: 'uploading', phase: 'init', progress: 0 });
			const init = await json(`${API}/v2/post/publish/${direct ? 'video' : 'inbox/video'}/init/`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
				body: JSON.stringify(body),
			});
			const publishId = init.data?.publish_id;
			const uploadUrl = init.data?.upload_url;
			if (!publishId || !uploadUrl) throw new TransientError('TikTok did not return an upload address');
			ctx.save({ phase: 'upload', providerRef: { publishId, uploaded: false } });
			ctx.log(`TikTok upload started (${plan.count} part${plan.count > 1 ? 's' : ''}).`);

			const fd = fs.openSync(ctx.media.path, 'r');
			try {
				for (let i = 0; i < plan.count; i++) {
					const start = i * plan.chunkSize;
					const end = i === plan.count - 1 ? size - 1 : start + plan.chunkSize - 1;
					const buf = Buffer.alloc(end - start + 1);
					fs.readSync(fd, buf, 0, buf.length, start);
					if (i === plan.count - 1) ctx.save({ providerRef: { publishId, uploaded: false, finalSent: true } });
					const res = await http(uploadUrl, {
						method: 'PUT',
						headers: { 'Content-Type': ctx.media.mime || 'video/mp4', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
						body: buf,
						timeoutMs: 10 * 60_000,
					});
					if (![200, 201, 206].includes(res.status)) throw classify(res.status, await res.json().catch(() => null), 'TikTok upload');
					ctx.save({ progress: (end + 1) / size });
				}
			} finally {
				fs.closeSync(fd);
			}
			ctx.save({ state: 'processing', phase: 'poll', progress: 1, providerRef: { publishId, uploaded: true } });
		}

		// Poll until TikTok confirms the outcome (about 20 minutes at most).
		for (let i = 0; i < 240; i++) {
			const st = await status(ctx, ctx.ref.publishId);
			const done = outcomeFor(ctx, st);
			if (done) return done;
			await ctx.sleep(5000);
		}
		throw new TransientError('TikTok is still processing the video');
	},
};

async function status(ctx: PublishContext, publishId: string) {
	const token = await ctx.token();
	const r = await json(`${API}/v2/post/publish/status/fetch/`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
		body: JSON.stringify({ publish_id: publishId }),
	});
	return r.data as { status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] };
}

function outcomeFor(ctx: PublishContext, st: { status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }): Outcome | null {
	switch (st.status) {
		case 'SEND_TO_USER_INBOX':
			return { state: 'needs_attention', message: 'Sent to your TikTok inbox. Open TikTok, tap the inbox notification and finish posting there.' };
		case 'PUBLISH_COMPLETE': {
			const id = st.publicaly_available_post_id?.[0];
			const handle = ctx.account.handle?.replace(/^@/, '');
			return { state: 'published', remoteId: id ? String(id) : null, permalink: id && handle ? `https://www.tiktok.com/@${handle}/video/${id}` : null, message: id ? undefined : 'Posted privately; TikTok does not give a public link for private posts.' };
		}
		case 'FAILED':
			throw new RejectedError(`TikTok rejected the video: ${st.fail_reason ?? 'unknown reason'}`);
		default:
			return null;
	}
}

function tokenSet(t: any) {
	const n = Date.now();
	return {
		accessToken: t.access_token,
		refreshToken: t.refresh_token ?? null,
		accessExpiresAt: t.expires_in ? n + t.expires_in * 1000 : null,
		refreshExpiresAt: t.refresh_expires_in ? n + t.refresh_expires_in * 1000 : null,
		scopes: t.scope ?? null,
	};
}
