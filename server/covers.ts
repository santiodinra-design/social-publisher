// Cover images: a YouTube thumbnail or an Instagram cover, chosen per destination (settings.coverId).
// Same rules as the Windows build (windows/core/src/covers.rs). Stored in the media table as images.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getDb, now } from './db.js';
import { randomId } from './crypto.js';
import type { Issue } from './media.js';
import type { MediaRow } from './platforms/types.js';

export const MAX_BYTES = 8 * 1024 * 1024;
export const YOUTUBE_MAX_BYTES = 2 * 1024 * 1024;

/** The image type, from the file's first bytes. Only JPEG and PNG are accepted. */
export function sniff(b: Buffer): 'image/jpeg' | 'image/png' | null {
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
	return null;
}

/** Width and height from a PNG header or a JPEG frame header, when they can be read. */
export function dimensions(b: Buffer): [number, number] | null {
	if (b.length >= 24 && sniff(b) === 'image/png') return [b.readUInt32BE(16), b.readUInt32BE(20)];
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return null;
		const marker = b[i + 1];
		const len = b.readUInt16BE(i + 2);
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
		i += 2 + len;
	}
	return null;
}

export const view = (m: MediaRow) => ({ id: m.id, mime: m.mime, size: m.size, width: m.width, height: m.height, url: `/api/covers/${m.id}` });

export function save(bytes: Buffer): { ok: true; view: ReturnType<typeof view> } | { ok: false; message: string } {
	if (!bytes.length) return { ok: false, message: 'Choose an image.' };
	if (bytes.length > MAX_BYTES) return { ok: false, message: 'Cover images can be up to 8 MB.' };
	const mime = sniff(bytes);
	if (!mime) return { ok: false, message: 'Use a JPEG or PNG image.' };
	const ext = mime === 'image/png' ? 'png' : 'jpg';
	const id = `c${randomId(8)}`;
	const dir = path.join(config.dataDir, 'media');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `cover-${id}.${ext}`);
	fs.writeFileSync(file, bytes);
	const [w, h] = dimensions(bytes) ?? [null, null];
	getDb()
		.prepare('INSERT INTO media (id, path, filename, mime, size, duration, width, height, video_codec, audio_codec, fps, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?)')
		.run(id, file, `cover.${ext}`, mime, bytes.length, w, h, now());
	const m = get(id);
	return m ? { ok: true, view: view(m) } : { ok: false, message: 'Could not save the image.' };
}

/** A cover image that is still on this computer. */
export function get(id: string): MediaRow | undefined {
	const m = getDb().prepare('SELECT * FROM media WHERE id = ? AND deleted_at IS NULL').get(id) as MediaRow | undefined;
	return m && m.mime.startsWith('image/') && fs.existsSync(m.path) ? m : undefined;
}

export const chosen = (settings: Record<string, any>) => (typeof settings?.coverId === 'string' && settings.coverId ? (settings.coverId as string) : null);

/** Checks a destination's cover before the post is saved. */
export function issues(platform: string, settings: Record<string, any>): Issue[] {
	const id = chosen(settings);
	if (!id) return [];
	const field = `${platform}.cover`;
	const m = get(id);
	if (!m) return [{ field, message: 'The cover image is no longer available. Choose it again.' }];
	if (platform === 'tiktok') return [{ field, message: 'TikTok sets the cover when you finish the draft in the TikTok app.' }];
	if (platform === 'youtube' && m.size > YOUTUBE_MAX_BYTES) return [{ field, message: 'YouTube thumbnails can be up to 2 MB.' }];
	if (platform === 'instagram' && m.mime !== 'image/jpeg') return [{ field, message: 'Instagram covers must be JPEG images.' }];
	return [];
}
