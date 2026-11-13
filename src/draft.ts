// Composer drafts, kept in this browser only. Holds text, choices and the server's media ID:
// never credentials, tokens or the video itself.
import type { Platform } from './api';

export type Draft = {
	v: 1;
	caption: string;
	selected: string[];
	settings: Record<string, Record<string, unknown>>;
	tab: string | null;
	previewAs: Platform;
	mediaId: string | null;
	/** Reused on restore, so publishing a draft that already went out returns that post instead of a second one. */
	key: string;
	savedAt: number;
};

const KEY = 'sp.draft.v1';
const ALLOWED = new Set(['overrideOn', 'captionOverride', 'mode', 'privacy', 'allowComments', 'allowDuet', 'allowStitch', 'shareToFeed', 'thumbSec', 'title', 'titleTouched', 'description', 'madeForKids', 'categoryId', 'coverId', 'coverUrl']);

export function loadDraft(): Draft | null {
	try {
		const d = JSON.parse(localStorage.getItem(KEY) ?? 'null');
		if (!d || d.v !== 1 || typeof d.key !== 'string') return null;
		return d as Draft;
	} catch {
		return null;
	}
}

export function saveDraft(d: Omit<Draft, 'v' | 'savedAt'>) {
	const empty = !d.caption.trim() && !d.mediaId && !d.selected.length;
	try {
		if (empty) return localStorage.removeItem(KEY);
		// Only known form fields are stored.
		const settings = Object.fromEntries(Object.entries(d.settings).map(([id, s]) => [id, Object.fromEntries(Object.entries(s).filter(([k]) => ALLOWED.has(k)))]));
		localStorage.setItem(KEY, JSON.stringify({ ...d, settings, v: 1, savedAt: Date.now() }));
	} catch {}
}

export function clearDraft() {
	try {
		localStorage.removeItem(KEY);
	} catch {}
}

// "Post again" from Post history: the composer picks this up once, then forgets it.
const REPOST = 'sp.repost';
export function queueRepost(postId: string) {
	try {
		sessionStorage.setItem(REPOST, postId);
	} catch {}
}
export function takeRepost(): string | null {
	try {
		const id = sessionStorage.getItem(REPOST);
		sessionStorage.removeItem(REPOST);
		return id;
	} catch {
		return null;
	}
}
