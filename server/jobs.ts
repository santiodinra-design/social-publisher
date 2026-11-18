import { getDb, now, TERMINAL, type TargetState } from './db.js';
import { randomId, redact } from './crypto.js';
import type { Patch, TargetRow } from './platforms/types.js';

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 60_000;

export function backoffMs(attempt: number, hint?: number) {
	const base = Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));
	return Math.max(hint ?? 0, Math.round(base * (0.8 + Math.random() * 0.4)));
}

type NewTarget = { accountId: string; platform: string; settings: Record<string, unknown> };

/** Creates a post once. Submitting the same idempotency key again returns the original post. */
/** With `scheduledAt`, every destination waits in the queue until that time. */
export function createPost(input: { idempotencyKey: string; mediaId: string; caption: string; isDemo: boolean; targets: NewTarget[]; scheduledAt?: number | null }) {
	const db = getDb();
	const existing = db.prepare('SELECT id FROM posts WHERE idempotency_key = ?').get(input.idempotencyKey) as { id: string } | undefined;
	if (existing) return { id: existing.id, duplicate: true };
	const id = randomId(10);
	const t = now();
	const due = input.scheduledAt ?? t;
	db.exec('BEGIN IMMEDIATE');
	try {
		db.prepare('INSERT INTO posts (id, idempotency_key, media_id, caption, is_demo, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, input.idempotencyKey, input.mediaId, input.caption, input.isDemo ? 1 : 0, t, input.scheduledAt ?? null);
		const ins = db.prepare('INSERT INTO targets (id, post_id, account_id, platform, settings, state, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, \'queued\', ?, ?, ?)');
		for (const tg of input.targets) ins.run(randomId(10), id, tg.accountId, tg.platform, JSON.stringify(tg.settings), due, t, t);
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		const again = db.prepare('SELECT id FROM posts WHERE idempotency_key = ?').get(input.idempotencyKey) as { id: string } | undefined;
		if (again) return { id: again.id, duplicate: true };
		throw e;
	}
	return { id, duplicate: false };
}

/**
 * Takes the next due target. A target whose worker died mid-run (lease expired) is picked up again
 * and flagged uncertain, so the adapter checks with the platform before doing anything.
 */
export function claimNext(owner: string): TargetRow | null {
	const db = getDb();
	const t = now();
	db.exec('BEGIN IMMEDIATE');
	try {
		const row = db
			.prepare(`SELECT * FROM targets WHERE
				(state = 'queued' AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?))
				OR (state IN ('uploading','processing') AND (lease_until IS NULL OR lease_until < ?))
				ORDER BY next_run_at LIMIT 1`)
			.get(t, t, t) as TargetRow | undefined;
		if (!row) {
			db.exec('COMMIT');
			return null;
		}
		const recovered = row.state !== 'queued';
		db.prepare('UPDATE targets SET lease_owner = ?, lease_until = ?, uncertain = CASE WHEN ? THEN 1 ELSE uncertain END, updated_at = ? WHERE id = ?').run(owner, t + LEASE_MS, recovered ? 1 : 0, t, row.id);
		db.exec('COMMIT');
		if (recovered) addEvent(row.id, 'Worker restarted during this step; checking with the platform before continuing.');
		return getTarget(row.id)!;
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
}

export const getTarget = (id: string) => getDb().prepare('SELECT * FROM targets WHERE id = ?').get(id) as TargetRow | undefined;

export function heartbeat(id: string, owner: string) {
	getDb().prepare('UPDATE targets SET lease_until = ? WHERE id = ? AND lease_owner = ?').run(now() + LEASE_MS, id, owner);
}

export function patchTarget(id: string, p: Patch) {
	const sets: string[] = ['updated_at = :t'];
	const v: Record<string, any> = { id, t: now() };
	if (p.state) (sets.push('state = :state'), (v.state = p.state));
	if (p.phase !== undefined) (sets.push('phase = :phase'), (v.phase = p.phase));
	if (p.progress !== undefined) (sets.push('progress = :progress'), (v.progress = Math.max(0, Math.min(1, p.progress))));
	if (p.providerRef !== undefined) (sets.push('provider_ref = :ref'), (v.ref = p.providerRef ? JSON.stringify(p.providerRef) : null));
	if (p.remoteId !== undefined) (sets.push('remote_id = :rid'), (v.rid = p.remoteId));
	if (p.uncertain !== undefined) (sets.push('uncertain = :u'), (v.u = p.uncertain ? 1 : 0));
	getDb().prepare(`UPDATE targets SET ${sets.join(', ')} WHERE id = :id`).run(v);
}

export function addEvent(targetId: string, message: string) {
	getDb().prepare('INSERT INTO events (target_id, at, message) VALUES (?, ?, ?)').run(targetId, now(), redact(message));
}

/**
 * Ends an attempt. The "outcome unknown" flag and provider references are kept unless the post is
 * confirmed published or `clearRef` says the platform confirmed nothing was posted.
 */
export function finish(id: string, state: TargetState, fields: { permalink?: string | null; error?: string | null; remoteId?: string | null; clearRef?: boolean }) {
	const clear = fields.clearRef ? 1 : 0;
	getDb()
		.prepare(`UPDATE targets SET state = :state, permalink = COALESCE(:permalink, permalink), error = :error, remote_id = CASE WHEN :clear = 1 THEN NULL ELSE COALESCE(:rid, remote_id) END,
			provider_ref = CASE WHEN :clear = 1 THEN NULL ELSE provider_ref END, phase = CASE WHEN :clear = 1 THEN NULL ELSE phase END,
			lease_owner = NULL, lease_until = NULL, uncertain = CASE WHEN :state = 'published' OR :clear = 1 THEN 0 ELSE uncertain END,
			progress = CASE WHEN :state = 'published' THEN 1 ELSE progress END, updated_at = :t WHERE id = :id`)
		.run({ state, permalink: fields.permalink ?? null, error: fields.error ? redact(fields.error) : null, rid: fields.remoteId ?? null, clear, t: now(), id });
}

/**
 * Called when the worker is told to stop (app quit). Hands its in-flight targets back to the queue,
 * marked so the next start checks with the platform before sending anything again.
 */
export function releaseLeases(owner: string) {
	const db = getDb();
	const rows = db.prepare("SELECT id FROM targets WHERE lease_owner = ? AND state IN ('queued','uploading','processing')").all(owner) as { id: string }[];
	for (const r of rows) {
		db.prepare("UPDATE targets SET state = 'queued', uncertain = CASE WHEN provider_ref IS NOT NULL OR remote_id IS NOT NULL OR phase IS NOT NULL THEN 1 ELSE uncertain END, lease_owner = NULL, lease_until = NULL, next_run_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), r.id);
		addEvent(r.id, 'Paused because the app quit. It will check with the platform and continue on the next start.');
	}
	return rows.length;
}

/** Where the owner should look when the app cannot tell whether a post went through. */
export const CHECK_WHERE: Record<string, string> = {
	youtube: 'YouTube Studio → Content',
	instagram: 'your Instagram profile (Reels tab)',
	tiktok: 'your TikTok inbox notifications and profile',
};
export const PLATFORM_LABEL: Record<string, string> = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };

export function unknownOutcomeMessage(platform: string, detail: string) {
	return `The app could not confirm whether this reached ${PLATFORM_LABEL[platform] ?? platform}. Check ${CHECK_WHERE[platform] ?? 'the platform'} before posting it again. "Check again" only asks the platform; it never uploads a second copy. (${detail})`;
}

/** Schedules another attempt, or fails the target after MAX_ATTEMPTS. */
export function scheduleRetry(t: TargetRow, message: string, hintMs?: number) {
	const attempts = t.attempts + 1;
	if (attempts >= MAX_ATTEMPTS) {
		// If the platform may already have the post, "failed" would be misleading and a blind retry unsafe.
		if (t.uncertain) finish(t.id, 'needs_attention', { error: unknownOutcomeMessage(t.platform, `${message}; stopped checking after ${attempts} attempts`) });
		else finish(t.id, 'failed', { error: `${message} (gave up after ${attempts} attempts)` });
		return false;
	}
	const wait = backoffMs(attempts, hintMs);
	getDb()
		.prepare("UPDATE targets SET state = 'queued', attempts = ?, next_run_at = ?, error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
		.run(attempts, now() + wait, redact(message), now(), t.id);
	addEvent(t.id, `Temporary problem: ${message}. Retrying in ${Math.round(wait / 1000)} s.`);
	return true;
}

/** Re-queues only the failed (or attention-needed, when asked) destinations of a post. */
export function retryTargets(postId: string, targetIds?: string[]) {
	const db = getDb();
	const rows = db.prepare('SELECT * FROM targets WHERE post_id = ?').all(postId) as TargetRow[];
	const picked = rows.filter((r) => (r.state === 'failed' || r.state === 'needs_attention') && (!targetIds || targetIds.includes(r.id)));
	for (const r of picked) {
		// Keep provider_ref and mark uncertain so the adapter reconciles before posting again.
		db.prepare("UPDATE targets SET state = 'queued', attempts = 0, next_run_at = ?, error = NULL, uncertain = CASE WHEN uncertain = 1 OR provider_ref IS NOT NULL OR remote_id IS NOT NULL THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?").run(now(), now(), r.id);
		addEvent(r.id, 'Retry requested.');
	}
	if (picked.length) db.prepare('UPDATE posts SET notified_at = NULL WHERE id = ?').run(postId);
	return picked.map((r) => r.id);
}

// ---------- scheduling, "I posted it" (same rules as the Windows build) ----------
export const MAX_SCHEDULE_MS = 60 * 86_400_000;
/** Destinations still only waiting for their scheduled time: never started, nothing sent. */
const WAITING = "state = 'queued' AND attempts = 0 AND uncertain = 0 AND provider_ref IS NULL AND remote_id IS NULL AND lease_owner IS NULL";
export const validScheduleTime = (at: unknown) => typeof at === 'number' && Number.isInteger(at) && at > now() + 60_000 && at < now() + MAX_SCHEDULE_MS;

/** Moves a scheduled post to another time, or to now when `at` is null. Only destinations that have not started move. */
export function reschedule(postId: string, at: number | null) {
	const db = getDb();
	const ids = (db.prepare(`SELECT id FROM targets WHERE post_id = ? AND ${WAITING}`).all(postId) as { id: string }[]).map((r) => r.id);
	for (const id of ids) {
		db.prepare('UPDATE targets SET next_run_at = ?, updated_at = ? WHERE id = ?').run(at ?? now(), now(), id);
		addEvent(id, at != null ? 'Schedule changed.' : 'Publishing now instead of at the scheduled time.');
	}
	if (ids.length) db.prepare('UPDATE posts SET scheduled_at = ?, notified_at = NULL WHERE id = ?').run(at, postId);
	return ids.length;
}

/** Cancels the not-yet-started destinations of a scheduled post. They end as failed; Retry posts them now. */
export function cancelScheduled(postId: string) {
	const db = getDb();
	const ids = (db.prepare(`SELECT id FROM targets WHERE post_id = ? AND next_run_at > ? AND ${WAITING}`).all(postId, now()) as { id: string }[]).map((r) => r.id);
	for (const id of ids) {
		finish(id, 'failed', { error: 'Cancelled before the scheduled time. Retry posts it now.' });
		addEvent(id, 'Schedule cancelled.');
	}
	return ids.length;
}

export const canMarkPosted = (t: Pick<TargetRow, 'platform' | 'state'>) => t.platform === 'tiktok' && t.state === 'needs_attention';

/** A TikTok address, if one was given. Anything else is refused rather than stored. */
export function tiktokLink(raw: string): { ok: true; link: string | null } | { ok: false; message: string } {
	const s = raw.trim();
	if (!s) return { ok: true, link: null };
	try {
		const u = new URL(s);
		if (u.protocol === 'https:' && (u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com'))) return { ok: true, link: s };
	} catch {}
	return { ok: false, message: 'Paste the post\'s TikTok link (https://www.tiktok.com/…), or leave it empty.' };
}

/** The owner finished a TikTok inbox draft by hand. Returns the post ID. */
export function markPosted(targetId: string, permalink: string | null) {
	const t = getTarget(targetId);
	if (!t) throw new Error('Not found');
	if (!canMarkPosted(t)) throw new Error('Only TikTok drafts waiting in the inbox can be marked as posted.');
	finish(t.id, 'published', { permalink });
	getDb().prepare('UPDATE targets SET error = NULL WHERE id = ?').run(t.id);
	addEvent(t.id, 'Marked as posted by hand in TikTok.');
	return t.post_id;
}

export function postView(postId: string) {
	const db = getDb();
	const post = db.prepare('SELECT p.*, m.filename, m.duration, m.width, m.height, m.size, m.deleted_at FROM posts p JOIN media m ON m.id = p.media_id WHERE p.id = ?').get(postId) as any;
	if (!post) return null;
	const waiting = (r: any) => post.scheduled_at != null && r.state === 'queued' && r.attempts === 0 && !r.uncertain && !r.provider_ref && !r.remote_id && r.next_run_at > now();
	const targets = db
		.prepare('SELECT t.*, a.display_name, a.handle, a.avatar_url, a.is_demo AS account_demo, a.status AS account_status FROM targets t JOIN accounts a ON a.id = t.account_id WHERE t.post_id = ? ORDER BY t.platform')
		.all(postId) as any[];
	const events = db.prepare(`SELECT target_id, at, message FROM events WHERE target_id IN (${targets.map(() => '?').join(',') || "''"}) ORDER BY id DESC LIMIT 60`).all(...targets.map((t) => t.id)) as any[];
	return {
		id: post.id,
		caption: post.caption,
		isDemo: Boolean(post.is_demo),
		createdAt: post.created_at,
		scheduledAt: post.scheduled_at ?? null,
		scheduled: targets.some((t) => waiting(t)),
		media: { id: post.media_id, filename: post.filename, duration: post.duration, width: post.width, height: post.height, size: post.size, deleted: Boolean(post.deleted_at) },
		targets: targets.map((t) => ({
			id: t.id,
			platform: t.platform,
			account: { name: t.display_name, handle: t.handle, avatarUrl: t.avatar_url, isDemo: Boolean(t.account_demo) },
			settings: JSON.parse(t.settings),
			state: t.state,
			phase: t.phase,
			progress: t.progress,
			attempts: t.attempts,
			outcomeUnknown: Boolean(t.uncertain) && !['published'].includes(t.state),
			accountStatus: t.account_status,
			nextRunAt: t.state === 'queued' ? t.next_run_at : null,
			scheduled: waiting(t),
			canMarkPosted: canMarkPosted(t),
			accountId: t.account_id,
			error: t.error,
			permalink: post.is_demo ? null : t.permalink,
			updatedAt: t.updated_at,
			events: events.filter((e) => e.target_id === t.id).slice(0, 8).map((e) => ({ at: e.at, message: e.message })),
		})),
		done: targets.every((t) => TERMINAL.includes(t.state)),
	};
}

export function listPosts(limit = 50) {
	const ids = getDb().prepare('SELECT id FROM posts ORDER BY created_at DESC LIMIT ?').all(limit) as { id: string }[];
	return ids.map((r) => postView(r.id));
}
