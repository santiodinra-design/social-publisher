// Quality checks for the chosen video. Publisher never re-encodes: the exact file goes to each
// platform. These checks only warn when the file itself is likely to look soft after the
// platform's own compression, and give each platform's best-practice tip.
import type { Media, Platform } from './api.js';

export type QualityNote = { kind: 'ok' | 'warn' | 'info'; text: string };

/** Average bitrate in Mbps, from file size and duration (audio included). */
export const mbps = (m: Pick<Media, 'size' | 'duration'>) => (m.duration && m.duration > 0 ? (m.size * 8) / m.duration / 1e6 : null);

export function qualityNotes(m: Media, platform: Platform): QualityNote[] {
	const out: QualityNote[] = [];
	const w = m.width ?? 0;
	const h = m.height ?? 0;
	const short = Math.min(w, h);
	const rate = mbps(m);
	const res = w && h ? `${w}×${h}` : 'unknown size';
	const fps = m.fps ? `, ${Math.round(m.fps)} fps` : '';
	const kbps = rate != null ? `, ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} Mbps` : '';

	if (!w || !h) return [{ kind: 'info', text: 'Sent as the original file, untouched' }];
	if (short < 720) out.push({ kind: 'warn', text: `Low resolution (${res}). It will look blurry; export at 1080×1920 or higher` });
	else if (short < 1080) out.push({ kind: 'warn', text: `Below 1080p (${res}). Export at 1080×1920 or higher for a sharp result` });
	if (rate != null && short >= 720) {
		const floor = short >= 2160 ? 20 : short >= 1440 ? 12 : 6;
		if (rate < floor) out.push({ kind: 'warn', text: `Low bitrate (${rate.toFixed(1)} Mbps). Export at ${floor * 2}+ Mbps so the platform's compression keeps detail` });
	}
	if (m.fps && m.fps < 23.5) out.push({ kind: 'warn', text: `Low frame rate (${Math.round(m.fps)} fps). Export at 24, 30 or 60 fps` });
	if (!out.length) out.push({ kind: 'ok', text: `Original quality, sent untouched (${res}${fps}${kbps})` });

	if (platform === 'youtube' && short >= 1080 && short < 1440) out.push({ kind: 'info', text: 'Tip: export at 1440p or 4K; YouTube then uses its sharper encoding, even for 1080p viewers' });
	if (platform === 'youtube' && short >= 1080) out.push({ kind: 'info', text: 'HD and 4K versions appear a few minutes after upload, while YouTube processes them' });
	if (platform === 'instagram' && short > 1080) out.push({ kind: 'info', text: 'Instagram shows Reels at up to 1080×1920 and scales larger videos down' });
	if (platform === 'tiktok') out.push({ kind: 'info', text: 'When you finish the draft in TikTok, make sure its high-quality (HD) upload setting is on' });
	return out;
}

/** What music the video carries, chosen by the owner in the composer. */
export type Music = 'none' | 'free' | 'song';

export const MUSIC_OPTIONS: { value: Music; label: string }[] = [
	{ value: 'none', label: 'No music / my own' },
	{ value: 'free', label: 'Royalty-free' },
	{ value: 'song', label: 'Popular song' },
];

/**
 * Copyright guidance per platform. None of the platforms lets an app add their licensed music
 * library through the API, so the safe route for a popular song is: export the video without it,
 * post, and add the song inside the platform's own app where that is possible.
 */
export function musicNotes(music: Music, m: Pick<Media, 'duration' | 'audioCodec'> | undefined, platform: Platform, tiktokMode: 'inbox' | 'direct' = 'inbox'): QualityNote[] {
	if (m && m.audioCodec == null) return [{ kind: 'info', text: 'This video has no sound track, so there is nothing to claim' }];
	if (music === 'none') return [];
	if (music === 'free')
		return [{ kind: 'info', text: 'Royalty-free music: if its licence asks for credit, put it in the caption or description. Even royalty-free tracks can get an automatic claim; keep the licence handy to dispute it' }];
	const long = (m?.duration ?? 0) > 60;
	if (platform === 'youtube')
		return long
			? [{ kind: 'warn', text: 'Over 1 minute with a copyrighted song: YouTube can block this Short in every country. Cut it to 60 seconds or less, or post without the song' }]
			: [{ kind: 'warn', text: 'Copyrighted song: expect a Content ID claim (the song owner may take the ad money). To use it safely, export without the song and add it with Add sound in the YouTube app instead of posting here' }];
	if (platform === 'instagram')
		return [{ kind: 'warn', text: 'Copyrighted song: Instagram may mute the sound or block the Reel. Its music library cannot be added by apps; to use it, post this Reel from the Instagram app' }];
	return tiktokMode === 'inbox'
		? [{ kind: 'info', text: 'Safest for TikTok: export without the song, send it here, then add the song from Sounds when you finish the draft in TikTok' }]
		: [{ kind: 'warn', text: 'Copyrighted song with Direct Post: TikTok may mute it. Use Inbox mode and add the song from Sounds in TikTok instead' }];
}
