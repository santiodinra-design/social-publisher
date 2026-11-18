// Inbox folder: the owner's Claude sessions (or the owner) drop a finished video plus a small JSON
// file here, and Publisher sends it to the chosen accounts: YouTube with the chosen visibility
// (Public unless the JSON says otherwise) and TikTok to the inbox, where the owner adds the caption
// and posts. Instagram is never used from the inbox.
//
// It goes through the app's own upload and publish routes, so every normal check still applies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { listAccounts } from './accounts.js';
import { listGroups } from './groups.js';
import type { Platform } from './db.js';

const VIDEO_EXT: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const SENT = 'Sent';
const FAILED = 'Needs attention';

export type Drop = {
	caption?: string;
	title?: string;
	description?: string;
	/** A saved group's name in Publisher. */
	group?: string;
	/** Account names or handles, for example "Voltsys" or "@voltsysan". */
	accounts?: string[];
	madeForKids?: boolean;
	categoryId?: string;
	/** YouTube visibility: public (default), unlisted or private. */
	privacy?: 'public' | 'unlisted' | 'private';
};
type Entry = { name: string; at: number; status: 'sent' | 'failed' | 'working'; message: string; postId?: string };

export const inboxDir = () => process.env.INBOX_DIR || path.join(os.homedir(), 'Movies', 'Publisher Inbox');
let running = false;
const recent: Entry[] = [];

export function inboxStatus() {
	return { enabled: running, dir: inboxDir(), recent: recent.slice(0, 20) };
}

function note(e: Entry) {
	const i = recent.findIndex((r) => r.name === e.name && r.status === 'working');
	if (i >= 0) recent.splice(i, 1);
	recent.unshift(e);
	recent.length = Math.min(recent.length, 50);
}

/** Which connected accounts a drop goes to. Only YouTube and TikTok: both have drafts. */
export function pickAccounts(drop: Drop) {
	const live = listAccounts().filter((a) => a.status === 'connected' && !a.isDemo && (a.platform === 'youtube' || a.platform === 'tiktok'));
	if (drop.group) {
		const g = listGroups().find((x) => x.name.trim().toLowerCase() === drop.group!.trim().toLowerCase());
		if (!g) throw new Error(`There is no group called "${drop.group}" in Publisher. Groups: ${listGroups().map((x) => x.name).join(', ') || 'none yet'}.`);
		return live.filter((a) => g.accountIds.includes(a.id));
	}
	if (drop.accounts?.length) {
		const want = drop.accounts.map((n) => n.trim().toLowerCase().replace(/^@/, ''));
		const out = live.filter((a) => want.some((w) => a.displayName.toLowerCase() === w || (a.handle ?? '').toLowerCase().replace(/^@/, '') === w));
		const missing = want.filter((w) => !out.some((a) => a.displayName.toLowerCase() === w || (a.handle ?? '').toLowerCase().replace(/^@/, '') === w));
		if (missing.length) throw new Error(`No connected YouTube or TikTok account called ${missing.map((m) => `"${m}"`).join(', ')}.`);
		return out;
	}
	return live;
}

function settingsFor(platform: Platform, drop: Drop, filename: string) {
	const caption = (drop.caption ?? '').trim();
	if (platform === 'tiktok') return { captionOverride: '', mode: 'inbox', privacy: 'SELF_ONLY', allowComments: true, allowDuet: false, allowStitch: false };
	const title = (drop.title ?? caption.split('\n')[0] ?? '').trim() || filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
	return { title: title.slice(0, 100), description: (drop.description ?? caption).slice(0, 5000), privacy: ['public', 'unlisted', 'private'].includes(String(drop.privacy)) ? drop.privacy : 'public', madeForKids: drop.madeForKids ?? false, categoryId: drop.categoryId ?? '20' };
}

function move(dir: string, sub: string, files: string[]) {
	const to = path.join(dir, sub);
	fs.mkdirSync(to, { recursive: true });
	for (const f of files) {
		if (!fs.existsSync(f)) continue;
		let dest = path.join(to, path.basename(f));
		if (fs.existsSync(dest)) dest = path.join(to, `${Date.now()}-${path.basename(f)}`);
		fs.renameSync(f, dest);
	}
	return to;
}

const auth = () => ({ headers: { 'x-requested-with': 'social-publisher' }, cookies: config.desktop ? { sp_desktop: config.desktopToken } : undefined });

/** Sends one drop. Returns the new post's ID. */
export async function sendDrop(app: FastifyInstance, video: string, drop: Drop) {
	const filename = path.basename(video);
	const ext = filename.split('.').pop()!.toLowerCase();
	const accounts = pickAccounts(drop);
	if (!accounts.length) throw new Error('No connected YouTube or TikTok account to send it to.');
	const size = fs.statSync(video).size;
	const a = auth();
	const up = await app.inject({ method: 'PUT', url: '/api/media', payload: fs.createReadStream(video), headers: { ...a.headers, 'content-type': VIDEO_EXT[ext], 'content-length': String(size), 'x-filename': encodeURIComponent(filename) }, cookies: a.cookies });
	if (up.statusCode !== 200) throw new Error(`Upload failed: ${up.json().error ?? up.statusCode}`);
	const media = up.json() as { id: string };
	const res = await app.inject({
		method: 'POST',
		url: '/api/posts',
		headers: a.headers,
		cookies: a.cookies,
		payload: {
			idempotencyKey: `inbox-${media.id}`,
			mediaId: media.id,
			caption: (drop.caption ?? '').trim(),
			targets: accounts.map((acc) => ({ accountId: acc.id, settings: settingsFor(acc.platform, drop, filename) })),
		},
	});
	const body = res.json();
	if (res.statusCode !== 200) throw new Error([body.error, ...(body.issues ?? []).map((i: any) => i.message)].filter(Boolean).join(' '));
	return { postId: body.post.id as string, accounts: accounts.map((x) => `${x.displayName} (${x.platform === 'youtube' ? `YouTube, ${(settingsFor('youtube', drop, filename) as any).privacy}` : 'TikTok inbox'})`) };
}

const README = `Publisher inbox
===============

Put a finished video here and Publisher sends it:
  - YouTube: posted with the visibility in the JSON ("privacy"), Public if left out.
  - TikTok: sent to your TikTok inbox. Publisher copies the caption to the clipboard
    (it reaches your iPhone too with Universal Clipboard): open the draft, paste it, add a sound, post.
  - Instagram: never from this folder.

How to drop a video
-------------------
1. Copy the video in first, for example  my-story.mp4  (MP4, MOV, M4V or WebM).
2. THEN write a JSON file with the same name:  my-story.json
   Publisher starts only when the JSON file is there, so always write it last.

my-story.json
{
  "title": "YouTube title (100 characters max)",
  "caption": "Caption with #hashtags. Used for TikTok and as the YouTube description.",
  "description": "Optional: a different YouTube description",
  "group": "Optional: a saved group name in Publisher, for example Roblox",
  "accounts": ["Optional: account names or handles, for example Voltsys or @voltsysan"],
  "privacy": "public",
  "madeForKids": false
}

Leave out "group" and "accounts" to send to every connected YouTube and TikTok account.
Never send the same video to two accounts on the same platform: YouTube and TikTok push reused videos down.

After sending, both files move to "Sent" with a .result.json next to them.
If something is wrong they move to "Needs attention" with a .error.txt that says why.
Publisher must be open for this to work.
`;

/** Watches the inbox folder. Polls every few seconds; a drop is taken once its JSON exists and the video stopped growing. */
export function startInbox(app: FastifyInstance, every = 4000) {
	const dir = inboxDir();
	fs.mkdirSync(dir, { recursive: true });
	const readme = path.join(dir, 'README.txt');
	if (!fs.existsSync(readme) || fs.readFileSync(readme, 'utf8') !== README) fs.writeFileSync(readme, README);
	running = true;
	const sizes = new Map<string, number>();
	const busy = new Set<string>();

	async function scan() {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const j of names.filter((n) => n.toLowerCase().endsWith('.json') && !n.endsWith('.result.json'))) {
			const base = j.slice(0, -5);
			const vid = names.find((n) => n !== j && n.slice(0, n.lastIndexOf('.')) === base && VIDEO_EXT[n.split('.').pop()!.toLowerCase()]);
			if (!vid || busy.has(base)) continue;
			const video = path.join(dir, vid);
			const json = path.join(dir, j);
			const size = fs.statSync(video).size;
			if (sizes.get(base) !== size) {
				sizes.set(base, size); // still copying, or first sight: check again next round
				continue;
			}
			busy.add(base);
			note({ name: vid, at: Date.now(), status: 'working', message: 'Sending as drafts…' });
			try {
				const drop = JSON.parse(fs.readFileSync(json, 'utf8')) as Drop;
				const r = await sendDrop(app, video, drop);
				const to = move(dir, SENT, [video, json]);
				fs.writeFileSync(path.join(to, `${base}.result.json`), JSON.stringify({ sentAt: new Date().toISOString(), postId: r.postId, to: r.accounts }, null, 2));
				note({ name: vid, at: Date.now(), status: 'sent', message: `Sent as drafts to ${r.accounts.join(', ')}`, postId: r.postId });
			} catch (e: any) {
				const msg = e instanceof SyntaxError ? `${j} is not valid JSON: ${e.message}` : String(e?.message ?? e);
				const to = move(dir, FAILED, [video, json]);
				fs.writeFileSync(path.join(to, `${base}.error.txt`), `${msg}\n\nFix it and put both files back in the inbox folder.\n`);
				note({ name: vid, at: Date.now(), status: 'failed', message: msg });
			} finally {
				sizes.delete(base);
				busy.delete(base);
			}
		}
	}
	const t = setInterval(() => void scan(), every);
	t.unref?.();
	return { scan, stop: () => (clearInterval(t), (running = false)) };
}
