// Finish notifications (same wording as the Windows build, windows/core/src/notify.rs): when every
// destination of a post has reached its end state, announce it once. A retry or schedule change
// clears the mark, so the post is announced again when it next finishes.
import { overrides } from './config.js';
import { getDb, now, TERMINAL } from './db.js';
import { PLATFORM_LABEL } from './jobs.js';

/** `copy`: text the desktop app puts on the clipboard (the TikTok caption, which TikTok drafts cannot carry). */
export type Notice = { postId: string; title: string; body: string; ok: boolean; copy?: string };
type Row = { platform: string; state: string; error: string | null };

/** Notifications are on unless the owner turned them off in the app (setting NOTIFY=off, see settings.ts). */
export const enabled = () => overrides.get('NOTIFY') !== 'off';

/** Call after a destination of `postId` reaches an end state. Returns the notice if this post should be announced now. */
export function afterTarget(postId: string): Notice | null {
	const db = getDb();
	const rows = db.prepare('SELECT platform, state, error FROM targets WHERE post_id = ? ORDER BY platform').all(postId) as Row[];
	if (!rows.length || !rows.every((r) => TERMINAL.includes(r.state as any))) return null;
	// Claim the announcement; a second job finishing at the same moment finds it taken.
	const claimed = db.prepare('UPDATE posts SET notified_at = ? WHERE id = ? AND notified_at IS NULL').run(now(), postId).changes;
	if (!claimed) return null;
	const p = db.prepare('SELECT p.caption, m.filename, p.is_demo FROM posts p JOIN media m ON m.id = p.media_id WHERE p.id = ?').get(postId) as { caption: string; filename: string; is_demo: number } | undefined;
	if (!p || !enabled()) return null;
	const tt = db.prepare("SELECT settings FROM targets WHERE post_id = ? AND platform = 'tiktok' LIMIT 1").get(postId) as { settings: string } | undefined;
	let own = '';
	try {
		own = String(JSON.parse(tt?.settings ?? '{}').captionOverride ?? '').trim();
	} catch {}
	return summarize(postId, rows, p.caption, p.filename, Boolean(p.is_demo), own || p.caption.trim());
}

function names(list: Row[]) {
	const labels = [...new Set(list.map((r) => PLATFORM_LABEL[r.platform] ?? r.platform))];
	return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
export function short(text: string, max: number) {
	const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
	const chars = [...line];
	return chars.length <= max ? line : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export function summarize(postId: string, rows: Row[], caption: string, filename: string, isDemo: boolean, tiktokCaption = ''): Notice {
	const what = caption.trim() ? short(caption, 80) : filename;
	const inbox = (r: Row) => r.platform === 'tiktok' && r.state === 'needs_attention' && (r.error ?? '').includes('TikTok inbox');
	const published = rows.filter((r) => r.state === 'published');
	const drafts = rows.filter(inbox);
	const problems = rows.filter((r) => r.state === 'failed' || (r.state === 'needs_attention' && !inbox(r)));
	const n = (title: string, body: string, ok: boolean): Notice => ({ postId, title, body, ok });
	if (isDemo) return n('Simulation finished', `Nothing was posted. ${what}`, problems.length === 0);
	const done = published.length ? `Published to ${names(published)}. ` : '';
	if (problems.length) return n(`Couldn't finish ${names(problems)}`, `${done}${short(problems[0].error ?? '', 140)}`, false);
	if (drafts.length) {
		if (!tiktokCaption) return n('Sent to your TikTok inbox', `${done}Open TikTok to finish posting: ${what}`, true);
		return { ...n('Sent to your TikTok inbox', `${done}Caption copied. Open the TikTok draft and paste it.`, true), copy: tiktokCaption };
	}
	return n(`Published to ${names(published)}`, what, true);
}
