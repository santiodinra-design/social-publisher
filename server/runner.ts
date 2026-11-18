import fs from 'node:fs';
import { getDb, now, TERMINAL } from './db.js';
import { accessToken, getAccount, markAccount } from './accounts.js';
import { addEvent, claimNext, finish, getTarget, heartbeat, patchTarget, scheduleRetry, unknownOutcomeMessage } from './jobs.js';
import { adapterFor } from './platforms/index.js';
import type { MediaRow, Outcome, PublishContext, TargetRow } from './platforms/types.js';
import { AttentionError, AuthError, MissingMediaError, PermanentError, RejectedError, TransientError } from './platforms/types.js';
import { config } from './config.js';
import { afterTarget, type Notice } from './notify.js';

export type RunnerOptions = { sleep?: (ms: number) => Promise<void> };

/** The worker sets this to pass finish notices to the desktop app. */
let onNotice: ((n: Notice) => void) | null = null;
export const setNoticeHandler = (f: ((n: Notice) => void) | null) => (onNotice = f);
function announce(postId: string) {
	try {
		const n = afterTarget(postId);
		if (n && onNotice) onNotice(n);
	} catch {}
}

/** Runs one claimed target to its next stable state. Exported for tests. */
export async function runTarget(t: TargetRow, owner: string, opts: RunnerOptions = {}) {
	const db = getDb();
	const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(t.post_id) as any;
	const media = db.prepare('SELECT * FROM media WHERE id = ?').get(post.media_id) as MediaRow;
	const account = getAccount(t.account_id);
	if (!account) return finish(t.id, 'failed', { error: 'Account no longer exists' });
	if (Boolean(account.is_demo) !== Boolean(post.is_demo)) return finish(t.id, 'failed', { error: 'Demo and real posts cannot be mixed' });

	const adapter = adapterFor(t.platform, Boolean(account.is_demo));
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const beat = setInterval(() => heartbeat(t.id, owner), 15_000);
	let current = t;
	const ctx: PublishContext = {
		get target() {
			return current;
		},
		settings: JSON.parse(t.settings),
		caption: captionFor(post.caption, JSON.parse(t.settings)),
		media,
		account,
		get ref() {
			return current.provider_ref ? JSON.parse(current.provider_ref) : {};
		},
		token: () => accessToken(account.id),
		save(p) {
			patchTarget(t.id, p);
			current = getTarget(t.id)!;
		},
		log: (m) => addEvent(t.id, m),
		sleep: async (ms) => {
			heartbeat(t.id, owner);
			await sleep(ms);
		},
		postCreatedAt: post.created_at,
		// The file is checked only when bytes must be sent, so status checks still work after cleanup.
		needFile() {
			if (!fs.existsSync(media.path)) throw new MissingMediaError('The uploaded video file is no longer on this computer (it was cleaned up after the retention period). Upload it again in a new post.');
		},
	};

	let reconciling = false;
	try {
		let outcome: Outcome | null = null;
		if (current.uncertain) {
			// Establish what happened last time before doing anything that could post a second copy.
			reconciling = true;
			const r = await adapter.reconcile(ctx);
			reconciling = false;
			if (typeof r === 'object') outcome = r;
			else if (r === 'restart') ctx.save({ providerRef: null, phase: null, remoteId: null, progress: 0, uncertain: false });
			else ctx.save({ uncertain: false });
			if (!outcome) addEvent(t.id, r === 'restart' ? 'The platform confirmed nothing was posted last time; starting the upload again.' : 'Resuming where the last attempt stopped.');
		}
		outcome ??= await adapter.run(ctx);
		finish(t.id, outcome.state, { permalink: outcome.permalink ?? null, remoteId: (outcome as any).remoteId ?? null, error: outcome.state === 'needs_attention' ? outcome.message : null });
		addEvent(t.id, outcome.state === 'published' ? outcome.message ?? 'Confirmed published by the platform.' : outcome.message);
	} catch (e: any) {
		const msg = e?.message ?? String(e);
		// If the platform may already hold something from this attempt, the next attempt must check first.
		const mayExist = reconciling || Boolean(current.uncertain) || current.phase === 'publishing' || Boolean(current.provider_ref) || Boolean(current.remote_id);
		if (e instanceof TransientError) {
			if (mayExist) ctx.save({ uncertain: true });
			scheduleRetry(getTarget(t.id)!, reconciling ? `Status check failed: ${msg}` : msg, e.retryAfterMs);
		} else if (e instanceof AuthError) {
			if (mayExist) ctx.save({ uncertain: true });
			markAccount(account.id, 'reconnect_required', msg);
			finish(t.id, 'needs_attention', { error: `Reconnect ${account.display_name} in Connected accounts, then use Check again. (${msg})` });
		} else if (e instanceof AttentionError) {
			finish(t.id, 'needs_attention', { error: msg });
		} else if (e instanceof RejectedError) {
			// The platform itself confirmed the failure, so a later retry may safely upload afresh.
			finish(t.id, 'failed', { error: msg, clearRef: true });
		} else if (e instanceof PermanentError) {
			// A refused status lookup is not proof the earlier upload failed.
			if (mayExist) {
				ctx.save({ uncertain: true });
				finish(t.id, 'needs_attention', { error: unknownOutcomeMessage(t.platform, e instanceof MissingMediaError ? 'the local video was cleaned up, so the upload cannot be continued' : msg) });
			} else finish(t.id, 'failed', { error: msg });
		} else {
			// Unknown errors are treated as uncertain: check with the platform before retrying.
			ctx.save({ uncertain: true });
			scheduleRetry(getTarget(t.id)!, `Unexpected error: ${msg}`);
		}
	} finally {
		clearInterval(beat);
		const end = getTarget(t.id);
		if (end && TERMINAL.includes(end.state)) announce(t.post_id);
	}
}

/** Per-platform caption override, else the shared caption. */
export function captionFor(shared: string, settings: Record<string, any>) {
	const o = typeof settings.captionOverride === 'string' ? settings.captionOverride : '';
	return o.trim() ? o : shared;
}

export async function tick(owner: string, maxParallel = 3, opts: RunnerOptions = {}) {
	const running: Promise<void>[] = [];
	for (let i = 0; i < maxParallel; i++) {
		const t = claimNext(owner);
		if (!t) break;
		running.push(runTarget(t, owner, opts));
	}
	await Promise.all(running);
	return running.length;
}

/** Deletes uploaded video files once every destination is finished and the retention period has passed. */
export function cleanupMedia() {
	const db = getDb();
	const cutoff = now() - config.mediaRetentionHours * 3_600_000;
	const rows = db
		.prepare(`SELECT m.id, m.path FROM media m WHERE m.deleted_at IS NULL AND m.created_at < ?
			AND NOT EXISTS (SELECT 1 FROM posts p JOIN targets t ON t.post_id = p.id WHERE p.media_id = m.id AND t.state IN ('queued','uploading','processing'))
			AND NOT EXISTS (SELECT 1 FROM targets t WHERE t.state IN ('queued','uploading','processing') AND t.settings LIKE '%"coverId":"' || m.id || '"%')`)
		.all(cutoff) as { id: string; path: string }[];
	for (const r of rows) {
		try {
			fs.rmSync(r.path, { force: true });
		} catch {}
		db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(now(), r.id);
	}
	return rows.length;
}
