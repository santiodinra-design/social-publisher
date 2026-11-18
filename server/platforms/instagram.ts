// Instagram API with Instagram Login (professional accounts: Business or Creator).
// Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing/
//
// With Instagram Login, Reels are published from a public video URL that Instagram downloads.
// Direct file upload (rupload) is documented only for the Facebook Login path, so this app serves
// each video at a short-lived signed URL under PUBLIC_BASE_URL.
import { config, redirectUri } from '../config.js';
import * as covers from '../covers.js';
import { signedToken } from '../crypto.js';
import { form, http, json } from './http.js';
import type { Adapter, Outcome, PublishContext } from './types.js';
import { AttentionError, AuthError, PermanentError, RejectedError, TransientError } from './types.js';

/**
 * Two ways in. New Meta apps get "Unified login": sign-in through Facebook Login for Business with a
 * configuration ID, a token owned by the business portfolio, and calls on graph.facebook.com.
 * Older apps use Instagram Login (graph.instagram.com). Each account remembers which one it came from.
 */
export const FB_GRAPH = 'https://graph.facebook.com/v27.0';
/** Accounts connected through Unified login or Facebook Login live on graph.facebook.com. */
export const viaUnified = (a?: { meta?: string | null } | null) => {
	try {
		return ['unified', 'facebook'].includes(JSON.parse(a?.meta ?? '{}')?.via);
	} catch {
		return false;
	}
};
export type IgLogin = 'unified' | 'facebook' | 'instagram';
export const loginMode = (): IgLogin => (config.instagram.configId ? 'unified' : config.instagram.loginMode === 'facebook' ? 'facebook' : 'instagram');
const unifiedSetup = () => loginMode() === 'unified';
const facebookSetup = () => loginMode() === 'facebook';
const FB_SCOPES = 'instagram_basic,instagram_content_publish,instagram_manage_insights,pages_show_list,pages_read_engagement,business_management';
const G = (a?: { meta?: string | null } | null) => (viaUnified(a) ? FB_GRAPH : `https://graph.instagram.com/${config.instagram.apiVersion}`);
const DAY = 86_400_000;

export const publicMediaUrl = (mediaId: string) => `${config.publicBaseUrl.replace(/\/$/, '')}/m/${signedToken({ media: mediaId }, 6 * 3600)}`;

export const instagram: Adapter = {
	platform: 'instagram',

	availability() {
		return /^https:\/\//.test(config.publicBaseUrl)
			? { available: true, mode: 'reels', note: 'Publishes Reels to a professional (Business or Creator) account.' }
			: { available: false, mode: 'reels', note: 'Instagram downloads the video from a public HTTPS address. Set PUBLIC_BASE_URL (for example a tunnel to this app) to publish.' };
	},

	validateSettings(s, caption) {
		const out = [];
		if (caption.length > 2200) out.push({ field: 'caption.instagram', message: 'Instagram captions are limited to 2,200 characters.' });
		if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) out.push({ field: 'caption.instagram', message: 'Instagram allows up to 30 hashtags.' });
		if ((caption.match(/@[\w.]+/g) ?? []).length > 20) out.push({ field: 'caption.instagram', message: 'Instagram allows up to 20 @mentions.' });
		if (s.thumbOffsetMs != null && (Number.isNaN(Number(s.thumbOffsetMs)) || Number(s.thumbOffsetMs) < 0)) out.push({ field: 'instagram.thumb', message: 'Cover frame must be a time in the video.' });
		return out;
	},

	authorizeUrl(state) {
		if (unifiedSetup()) {
			// Unified login: the configuration (set up in Meta) decides the permissions and token lifetime.
			const q = new URLSearchParams({ client_id: config.instagram.appId, config_id: config.instagram.configId, redirect_uri: redirectUri('instagram'), response_type: 'code', override_default_response_type: 'true', state });
			return `https://www.facebook.com/v27.0/dialog/oauth?${q}`;
		}
		if (facebookSetup()) {
			// Facebook Login: sign in with Facebook, then choose the Pages whose Instagram accounts to share.
			const q = new URLSearchParams({ client_id: config.instagram.appId, redirect_uri: redirectUri('instagram'), response_type: 'code', scope: FB_SCOPES, auth_type: 'rerequest', state });
			return `https://www.facebook.com/v27.0/dialog/oauth?${q}`;
		}
		const q = new URLSearchParams({
			client_id: config.instagram.appId,
			redirect_uri: redirectUri('instagram'),
			response_type: 'code',
			scope: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights',
			// Ask for the account's credentials even when Instagram is already signed in, so a second account can be added.
			force_reauth: 'true',
			state,
		});
		return `https://www.instagram.com/oauth/authorize?${q}`;
	},

	async exchangeCode(code) {
		if (unifiedSetup()) {
			const q = new URLSearchParams({ client_id: config.instagram.appId, client_secret: config.instagram.appSecret, redirect_uri: redirectUri('instagram'), code });
			const t = await json(`${FB_GRAPH}/oauth/access_token?${q}`);
			// Portfolio-owned token. Its lifetime comes from the configuration ("Never" is recommended).
			return { accessToken: t.access_token, accessExpiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null, scopes: null };
		}
		if (facebookSetup()) {
			const q = new URLSearchParams({ client_id: config.instagram.appId, client_secret: config.instagram.appSecret, redirect_uri: redirectUri('instagram'), code });
			const short = await json(`${FB_GRAPH}/oauth/access_token?${q}`);
			// Long-lived user token; each Page's token taken from it does not expire.
			const l = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: config.instagram.appId, client_secret: config.instagram.appSecret, fb_exchange_token: short.access_token });
			const long = await json(`${FB_GRAPH}/oauth/access_token?${l}`);
			return { accessToken: long.access_token, accessExpiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : null, scopes: null };
		}
		const short = await json('https://api.instagram.com/oauth/access_token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form({ client_id: config.instagram.appId, client_secret: config.instagram.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri('instagram'), code }),
		});
		// Swap the 1-hour token for a 60-day one.
		const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: config.instagram.appSecret, access_token: short.access_token });
		const long = await json(`https://graph.instagram.com/access_token?${q}`);
		return { accessToken: long.access_token, accessExpiresAt: Date.now() + (long.expires_in ?? 60 * 86400) * 1000, scopes: (short.permissions ?? []).join?.(',') ?? null };
	},

	async refresh(account, _r, accessToken) {
		if (!accessToken) throw new PermanentError('No token stored');
		if (viaUnified(account)) {
			// Unified-login tokens are not refreshed by the app; an expired one means signing in again.
			if (account.access_expires_at == null || account.access_expires_at > Date.now()) return { accessToken, accessExpiresAt: account.access_expires_at };
			throw new AuthError('This Instagram sign-in has expired. Reconnect it in Connected accounts.');
		}
		// Long-lived tokens can be refreshed once they are at least 24 hours old and not yet expired.
		if (Date.now() - account.updated_at < DAY && (account.access_expires_at ?? 0) > Date.now()) return { accessToken, accessExpiresAt: account.access_expires_at };
		const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: accessToken });
		const t = await json(`https://graph.instagram.com/refresh_access_token?${q}`);
		return { accessToken: t.access_token, accessExpiresAt: Date.now() + (t.expires_in ?? 60 * 86400) * 1000 };
	},

	/** Unified login can share several Instagram accounts in one sign-in; all of them are connected. */
	async identities(accessToken, tokens) {
		if (facebookSetup()) {
			const r = await json(`${FB_GRAPH}/me/accounts?fields=name,access_token,instagram_business_account{id,username,name,profile_picture_url}&limit=100`, { headers: { Authorization: `Bearer ${accessToken}` } });
			const pages = ((r.data ?? []) as any[]).filter((p) => p.instagram_business_account?.id);
			if (!pages.length)
				throw new AttentionError('No Instagram account came through. Link each Instagram account to a Facebook Page you manage, then connect again and tick those Pages when Facebook asks.');
			return pages.map((p) => {
				const a = p.instagram_business_account;
				return { externalId: String(a.id), displayName: a.name || a.username || p.name, handle: a.username ? `@${a.username}` : null, avatarUrl: a.profile_picture_url ?? null, meta: { via: 'facebook', pageId: p.id }, tokens: { accessToken: p.access_token, accessExpiresAt: null } };
			});
		}
		if (!unifiedSetup()) return [await instagram.identity(accessToken, tokens)];
		const r = await json(`${FB_GRAPH}/me/assigned_instagram_accounts?fields=id,username,name,profile_picture_url`, { headers: { Authorization: `Bearer ${accessToken}` } });
		const list = (r.data ?? []) as any[];
		if (!list.length)
			throw new AttentionError('Meta did not share any Instagram account. Sign in again and tick your Instagram account(s) when asked, and make sure your Meta configuration includes the business_management permission.');
		return list.map((a) => ({ externalId: String(a.id), displayName: a.name || a.username || 'Instagram account', handle: a.username ? `@${a.username}` : null, avatarUrl: a.profile_picture_url ?? null, meta: { via: 'unified' } }));
	},

	async identity(accessToken, tokens) {
		if (unifiedSetup() || facebookSetup()) return (await instagram.identities!(accessToken, tokens))[0];
		const me = await json(`${G()}/me?fields=user_id,username,name,profile_picture_url,account_type`, { headers: { Authorization: `Bearer ${accessToken}` } });
		if (me.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(me.account_type))) {
			throw new AttentionError('This Instagram account is personal. Switch it to a Professional (Business or Creator) account to publish.');
		}
		return { externalId: String(me.user_id ?? me.id), displayName: me.name || me.username, handle: me.username ? `@${me.username}` : null, avatarUrl: me.profile_picture_url ?? null, meta: { accountType: me.account_type } };
	},

	async reconcile(ctx) {
		const containerId = ctx.ref.containerId;
		if (ctx.target.remote_id) return finishWith(ctx, ctx.target.remote_id);
		// A Reel only goes live through media_publish with a container ID. Without a stored container,
		// that call was never made, so a new container cannot duplicate anything.
		if (!containerId) return 'restart';
		// Lookup errors are thrown so the container is kept and checked again later.
		const c = await container(ctx, containerId);
		if (c.status_code === 'PUBLISHED') return matchPublished(ctx);
		// Instagram says this container was never published (it failed or expired), so a fresh one is safe.
		if (c.status_code === 'ERROR' || c.status_code === 'EXPIRED') {
			ctx.save({ providerRef: null, phase: null, progress: 0 });
			return 'restart';
		}
		// FINISHED or IN_PROGRESS: not published yet. Publishing the same container again cannot create a second Reel.
		return 'resume';
	},

	async run(ctx) {
		if (!/^https:\/\//.test(config.publicBaseUrl)) throw new AttentionError('Set PUBLIC_BASE_URL to a public HTTPS address so Instagram can download the video.');
		const token = await ctx.token();
		const igId = ctx.account.external_id;

		if (!ctx.ref.containerId) {
			ctx.needFile();
			const limit = await json(`${G(ctx.account)}/${igId}/content_publishing_limit?fields=quota_usage,config`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
			const used = limit?.data?.[0]?.quota_usage;
			const total = limit?.data?.[0]?.config?.quota_total;
			if (used != null && total != null && used >= total) throw new TransientError(`Instagram's publishing limit is reached (${used}/${total} in 24 h)`, 60 * 60_000);
			ctx.save({ state: 'uploading', phase: 'container', progress: 0.05 });
			const params: Record<string, string> = { media_type: 'REELS', video_url: publicMediaUrl(ctx.media.id), caption: ctx.caption, share_to_feed: String(ctx.settings.shareToFeed !== false) };
			if (ctx.settings.thumbOffsetMs != null && ctx.settings.thumbOffsetMs !== '') params.thumb_offset = String(Math.round(Number(ctx.settings.thumbOffsetMs)));
			// A cover image the owner chose replaces the cover frame. A missing one is skipped, never fatal.
			const coverId = covers.chosen(ctx.settings);
			if (coverId) {
				const c = covers.get(coverId);
				if (c) params.cover_url = publicMediaUrl(c.id);
				else ctx.log('The chosen cover image is no longer on this computer, so Instagram picks the cover.');
			}
			const c = await json(`${G(ctx.account)}/${igId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(params) });
			ctx.save({ phase: 'processing', state: 'processing', providerRef: { containerId: c.id }, progress: 0.1 });
			ctx.log('Instagram is downloading and processing the video.');
		}

		if (ctx.target.phase !== 'publishing') {
			for (let i = 0; ; i++) {
				const c = await container(ctx, ctx.ref.containerId);
				if (c.status_code === 'FINISHED') break;
				if (c.status_code === 'PUBLISHED') return matchPublished(ctx);
				if (c.status_code === 'ERROR') throw new RejectedError(`Instagram could not process the video: ${c.status ?? 'unknown error'}`);
				if (c.status_code === 'EXPIRED') {
					ctx.save({ providerRef: null, phase: null });
					throw new TransientError('Instagram container expired before publishing');
				}
				if (i > 180) throw new TransientError('Instagram is still processing the video');
				ctx.save({ progress: Math.min(0.9, 0.1 + i * 0.01) });
				await ctx.sleep(5000);
			}
		}

		// From here a lost response could mean the Reel is live, so mark the attempt uncertain first.
		ctx.save({ phase: 'publishing', uncertain: true, providerRef: { ...ctx.ref, publishAt: Date.now() } });
		const pub = await json(`${G(ctx.account)}/${igId}/media_publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ creation_id: ctx.ref.containerId }) });
		ctx.save({ remoteId: pub.id, uncertain: false });
		return finishWith(ctx, pub.id);
	},
};

async function container(ctx: PublishContext, id: string) {
	const token = await ctx.token();
	return json(`${G(ctx.account)}/${id}?fields=status_code,status`, { headers: { Authorization: `Bearer ${token}` } });
}

async function recentMedia(ctx: PublishContext) {
	const token = await ctx.token();
	const r = await json(`${G(ctx.account)}/${ctx.account.external_id}/media?fields=id,permalink,timestamp,caption,media_product_type&limit=25`, { headers: { Authorization: `Bearer ${token}` } });
	return r.data ?? [];
}

/**
 * The container says PUBLISHED but the publish response was lost. Instagram returns no media ID on the
 * container, so look for exactly one recent Reel with this caption posted after the publish call.
 * Identical captions are common, so anything other than exactly one match needs the owner to check.
 */
async function matchPublished(ctx: PublishContext): Promise<Outcome> {
	const since = (ctx.ref.publishAt ?? ctx.postCreatedAt) - 60_000;
	const media = await recentMedia(ctx);
	const matches = media.filter((m: any) => new Date(m.timestamp).getTime() >= since && (m.caption ?? '') === ctx.caption && (!m.media_product_type || m.media_product_type === 'REELS'));
	if (matches.length === 1) return finishWith(ctx, matches[0].id, matches[0].permalink);
	if (matches.length > 1)
		return { state: 'needs_attention', message: `Instagram confirmed this Reel was published, but ${matches.length} recent posts have the same caption, so the app cannot tell which one it is. Open your Instagram profile to find it. Do not post it again.` };
	// Published but not listed yet: the media list can lag. Check again later; repeated misses end in needs_attention.
	throw new TransientError('Instagram says the Reel was published but it is not in your recent posts yet');
}

async function finishWith(ctx: PublishContext, mediaId: string, permalink?: string): Promise<Outcome> {
	if (!permalink) {
		const token = await ctx.token();
		const m = await json(`${G(ctx.account)}/${mediaId}?fields=permalink`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
		permalink = m?.permalink;
	}
	return { state: 'published', remoteId: mediaId, permalink: permalink ?? null };
}

export const _test = { http };
