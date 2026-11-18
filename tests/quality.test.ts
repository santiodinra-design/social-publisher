import { describe, expect, it } from 'vitest';
import { mbps, musicNotes, qualityNotes } from '../src/quality.js';

const media = (w: number, h: number, mb: number, secs: number, fps = 30) => ({ id: 'm', filename: 'a.mp4', size: mb * 1e6, duration: secs, width: w, height: h, videoCodec: 'h264', audioCodec: 'aac', fps, shortsShape: true, issues: { youtube: [], instagram: [], tiktok: [] } });

describe('quality checks', () => {
	it('passes a sharp 1080×1920 export and says it goes untouched', () => {
		const n = qualityNotes(media(1080, 1920, 45, 30), 'instagram'); // 12 Mbps
		expect(n[0]).toMatchObject({ kind: 'ok' });
		expect(n[0].text).toContain('untouched');
		expect(mbps(media(1080, 1920, 45, 30))).toBeCloseTo(12);
	});
	it('warns about low resolution, low bitrate and low frame rate', () => {
		expect(qualityNotes(media(540, 960, 20, 30), 'tiktok')[0]).toMatchObject({ kind: 'warn' });
		expect(qualityNotes(media(1080, 1920, 6, 30), 'youtube').some((q) => q.kind === 'warn' && q.text.includes('bitrate'))).toBe(true);
		expect(qualityNotes(media(1080, 1920, 45, 30, 15), 'youtube').some((q) => q.text.includes('frame rate'))).toBe(true);
	});
	it('gives the right platform tip', () => {
		expect(qualityNotes(media(1080, 1920, 45, 30), 'youtube').some((q) => q.text.includes('1440p or 4K'))).toBe(true);
		expect(qualityNotes(media(2160, 3840, 150, 30), 'instagram').some((q) => q.text.includes('scales larger videos down'))).toBe(true);
	});
});

describe('music copyright checks', () => {
	const short = { duration: 45, audioCodec: 'aac' };
	const long = { duration: 90, audioCodec: 'aac' };
	it('says nothing for own sounds', () => expect(musicNotes('none', short, 'youtube')).toEqual([]));
	it('notes a silent video has nothing to claim', () => expect(musicNotes('song', { duration: 90, audioCodec: null }, 'youtube')[0].text).toMatch(/no sound track/));
	it('warns that YouTube can block a song Short over a minute', () => {
		expect(musicNotes('song', long, 'youtube')[0]).toMatchObject({ kind: 'warn', text: expect.stringMatching(/block/) });
		expect(musicNotes('song', short, 'youtube')[0].text).toMatch(/Content ID/);
	});
	it('warns about Instagram muting', () => expect(musicNotes('song', short, 'instagram')[0].text).toMatch(/mute/));
	it('points TikTok inbox posts at TikTok Sounds', () => {
		expect(musicNotes('song', short, 'tiktok', 'inbox')[0]).toMatchObject({ kind: 'info', text: expect.stringMatching(/Sounds/) });
		expect(musicNotes('song', short, 'tiktok', 'direct')[0].kind).toBe('warn');
	});
	it('reminds about credit for royalty-free music', () => expect(musicNotes('free', short, 'instagram')[0].text).toMatch(/credit/));
});
