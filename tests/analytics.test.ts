// Account stats against stand-ins for the platforms' analytics APIs (port of windows/core/tests/analytics.rs).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { report, clearAnalyticsCache } from '../server/analytics.js';
import { getDb } from '../server/db.js';
import { markAccount } from '../server/accounts.js';
import { freshDb, seedAccount } from './helpers.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function mockFetch(routes: [RegExp, Handler][]) {
	const calls: { url: string; method: string; body?: string }[] = [];
	const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any = {}) => {
		const url = String(input);
		calls.push({ url, method: init.method ?? 'GET', body: init.body ? String(init.body) : undefined });
		const r = routes.find(([re]) => re.test(url));
		if (!r) throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`);
		return r[1](url, init);
	});
	return Object.assign(calls, { spy });
}
const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const table = (headers: string[], rows: unknown[]) => ({ columnHeaders: headers.map((name) => ({ name })), rows });

beforeEach(() => {
	freshDb();
	clearAnalyticsCache();
});
afterEach(() => vi.restoreAllMocks());

const youtubeRoutes = (): [RegExp, Handler][] => [
	[/youtube\/v3\/channels\?part=statistics&mine=true/, () => ok({ items: [{ statistics: { subscriberCount: '1234' } }] })],
	[/youtubeanalytics\.googleapis\.com\/v2\/reports.*dimensions=day/, () =>
		ok(table(['day', 'views', 'likes', 'comments', 'shares', 'estimatedMinutesWatched', 'subscribersGained', 'subscribersLost'], [['2026-11-01', 100, 10, 2, 3, 250, 5, 1], ['2026-11-02', 50, 4, 1, 0, 90, 2, 0]]))],
	[/youtubeanalytics\.googleapis\.com\/v2\/reports.*dimensions=country/, () => ok(table(['country', 'views'], [['US', 90], ['BR', 60]]))],
	[/youtubeanalytics\.googleapis\.com\/v2\/reports.*dimensions=ageGroup/, () => ok(table(['ageGroup', 'gender', 'viewerPercentage'], [['age18-24', 'female', 30.0], ['age18-24', 'male', 20.0], ['age25-34', 'male', 50.0]]))],
	[/youtubeanalytics\.googleapis\.com\/v2\/reports.*dimensions=video/, () => ok(table(['video', 'views', 'likes', 'comments', 'shares'], [['v1', 120, 12, 3, 2]]))],
	[/youtube\/v3\/videos\?part=snippet/, () => ok({ items: [{ id: 'v1', snippet: { title: 'My best video', publishedAt: '2026-11-01T10:00:00Z', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/v1/mq.jpg' } } } }] })],
];

describe('YouTube', () => {
	it('takes stats from the analytics reports, for exactly the chosen period, and caches them', async () => {
		const calls = mockFetch(youtubeRoutes());
		const a = seedAccount('youtube');
		const r = await report(28, undefined, false);
		expect(r.days).toBe(28);
		const s = r.accounts[0];
		expect([s.status, s.accountId]).toEqual(['ok', a.id]);
		expect(s.followers).toBe(1234);
		expect(s.totals).toEqual({ views: 150, likes: 14, comments: 3, shares: 3, watchMinutes: 340, followersGained: 6 });
		expect(s.daily[0]).toEqual({ views: 100, likes: 10, comments: 2, shares: 3, watchMinutes: 250, date: '2026-11-01' });
		expect(s.countries).toEqual([{ code: 'US', value: 90, share: 0.6 }, { code: 'BR', value: 60, share: 0.4 }]);
		expect(s.countriesOf).toBe('views');
		expect(s.ages).toEqual([{ age: '18-24', female: 30, male: 20, other: 0 }, { age: '25-34', female: 0, male: 50, other: 0 }]);
		expect(s.top[0]).toMatchObject({ id: 'v1', title: 'My best video', views: 120, thumbnail: 'https://i.ytimg.com/vi/v1/mq.jpg', permalink: 'https://www.youtube.com/watch?v=v1' });
		expect(s.notes).toEqual([]);
		// The channel's own reports, for exactly the chosen period.
		const daily = calls.find((c) => c.url.includes('dimensions=day'))!;
		const today = new Date().toISOString().slice(0, 10);
		const start = new Date(Date.now() - 27 * 86_400_000).toISOString().slice(0, 10);
		expect(daily.url).toContain('ids=channel%3D%3DMINE');
		expect(daily.url).toContain(`startDate=${start}`);
		expect(daily.url).toContain(`endDate=${today}`);
		// Tokens go in the header only.
		expect(calls.every((c) => !c.url.includes('secret-access'))).toBe(true);

		// Cached for a few minutes: a second look asks nothing; fresh asks again.
		const before = calls.length;
		await report(28, undefined, false);
		expect(calls.length).toBe(before);
		await report(28, undefined, true);
		expect(calls.length).toBeGreaterThan(before);
	});

	it('asks an account connected before stats existed to reconnect, without marking the account broken', async () => {
		mockFetch([
			[/youtube\/v3\/channels/, () => ok({ items: [{ statistics: {} }] })],
			[/./, () => new Response(JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }), { status: 403 })],
		]);
		seedAccount('youtube');
		const s = (await report(7, undefined, false)).accounts[0];
		expect(s.status).toBe('reconnect');
		expect(s.message).toContain('Reconnect this YouTube account');
		expect(s.followers).toBeNull();
		// Asking for stats never marks the account itself as broken.
		expect((getDb().prepare('SELECT status FROM accounts').get() as any).status).toBe('connected');
	});

	it('reports other failures as errors and does not cache them', async () => {
		const calls = mockFetch([[/./, () => new Response(JSON.stringify({ error: { code: 400, message: 'Bad request' } }), { status: 400 })]]);
		seedAccount('youtube');
		const s = (await report(7, undefined, false)).accounts[0];
		expect(s.status).toBe('error');
		expect(s.message).toMatch(/^Could not load stats right now \(.*Bad request.*\)\.$/);
		const before = calls.length;
		await report(7, undefined, false);
		expect(calls.length).toBeGreaterThan(before);
	});
});

describe('expired sign-in', () => {
	it('asks for a reconnect when the token cannot be refreshed', async () => {
		mockFetch([[/oauth2\.googleapis\.com\/token/, () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })]]);
		seedAccount('youtube', { expiresIn: -1000 });
		const s = (await report(28, undefined, false)).accounts[0];
		expect(s.status).toBe('reconnect');
		expect(s.message).toContain('Reconnect');
	});

	it('does not call the platform for an account already waiting for a reconnect', async () => {
		const calls = mockFetch([]);
		const a = seedAccount('instagram');
		markAccount(a.id, 'reconnect_required', 'expired');
		const s = (await report(28, undefined, false)).accounts[0];
		expect(s.status).toBe('reconnect');
		expect(s.message).toContain('Reconnect this Instagram account');
		expect(calls).toHaveLength(0);
	});
});

describe('Instagram', () => {
	it('reads account insights, follower demographics and recent posts', async () => {
		const now = new Date();
		const calls = mockFetch([
			[/graph\.instagram\.com\/v[\d.]+\/me\?fields=followers_count/, () => ok({ followers_count: 4200, media_count: 2 })],
			[/\/instagram-1\/insights\?metric=views,reach.*metric_type=total_value/, () =>
				ok({ data: [{ name: 'views', total_value: { value: 900 } }, { name: 'reach', total_value: { value: 600 } }, { name: 'likes', total_value: { value: 80 } }, { name: 'comments', total_value: { value: 9 } }, { name: 'shares', total_value: { value: 7 } }, { name: 'saves', total_value: { value: 5 } }] })],
			[/\/instagram-1\/insights\?metric=reach&period=day/, () => ok({ data: [{ name: 'reach', values: [{ value: 40, end_time: `${now.toISOString().slice(0, 10)}T07:00:00+0000` }] }] })],
			[/follower_demographics.*breakdown=country/, () => ok({ data: [{ total_value: { breakdowns: [{ results: [{ dimension_values: ['US'], value: 30 }, { dimension_values: ['DE'], value: 10 }] }] } }] })],
			[/follower_demographics.*breakdown=age,gender/, () => ok({ data: [{ total_value: { breakdowns: [{ results: [{ dimension_values: ['18-24', 'F'], value: 3 }, { dimension_values: ['18-24', 'M'], value: 1 }] }] } }] })],
			[/\/instagram-1\/media\?fields=/, () =>
				ok({ data: [
					{ id: 'p1', caption: 'First line\nsecond', media_type: 'VIDEO', thumbnail_url: 'https://cdn/t1.jpg', media_url: 'https://cdn/v1.mp4', permalink: 'https://www.instagram.com/reel/p1/', timestamp: '2026-11-10T10:00:00+0000', like_count: 12, comments_count: 2 },
					{ id: 'p2', caption: 'Photo', media_type: 'IMAGE', media_url: 'https://cdn/i2.jpg', permalink: 'https://www.instagram.com/p/p2/', timestamp: '2026-11-09T10:00:00+0000', like_count: 50, comments_count: 4 },
				] })],
			[/\/p1\/insights\?metric=views,shares,saved/, () => ok({ data: [{ name: 'views', values: [{ value: 100 }] }, { name: 'shares', values: [{ value: 3 }] }] })],
			[/\/p2\/insights\?metric=views,shares,saved/, () => ok({ data: [{ name: 'views', total_value: { value: 300 } }] })],
		]);
		seedAccount('instagram');
		const s = (await report(7, undefined, false)).accounts[0];
		expect(s.status).toBe('ok');
		expect(s.platform).toBe('instagram');
		expect(s.followers).toBe(4200);
		expect(s.totals).toEqual({ views: 900, reach: 600, likes: 80, comments: 9, shares: 7, saves: 5 });
		expect(s.daily).toEqual([{ reach: 40, date: now.toISOString().slice(0, 10) }]);
		expect(s.countriesOf).toBe('followers');
		expect(s.countries).toEqual([{ code: 'US', value: 30, share: 0.75 }, { code: 'DE', value: 10, share: 0.25 }]);
		expect(s.ages).toEqual([{ age: '18-24', female: 75, male: 25, other: 0 }]);
		// Most viewed first; image posts use the media URL as the picture.
		expect(s.top.map((t) => [t.id, t.title, t.views, t.shares, t.thumbnail])).toEqual([
			['p2', 'Photo', 300, null, 'https://cdn/i2.jpg'],
			['p1', 'First line', 100, 3, 'https://cdn/t1.jpg'],
		]);
		expect(s.notes).toEqual(['Instagram reports accounts reached per day; views are totals for the period.']);
		// One 7-day window: since is midnight UTC six days ago, until is tomorrow midnight.
		const totals = calls.find((c) => c.url.includes('metric_type=total_value&since='))!;
		const midnight = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) / 1000;
		expect(totals.url).toContain(`since=${midnight - 6 * 86400}&until=${midnight + 86400}`);
	});

	it('splits long periods into 30-day requests and notes when demographics are unavailable', async () => {
		const calls = mockFetch([
			[/\/me\?fields=followers_count/, () => ok({ followers_count: 50 })],
			[/metric=views,reach/, () => ok({ data: [{ name: 'views', total_value: { value: 10 } }] })],
			[/metric=reach&period=day/, () => ok({ data: [{ values: [] }] })],
			[/follower_demographics/, () => new Response(JSON.stringify({ error: { code: 100, message: 'Not enough followers' } }), { status: 400 })],
			[/\/media\?fields=/, () => ok({ data: [] })],
		]);
		seedAccount('instagram');
		const s = (await report(90, undefined, false)).accounts[0];
		expect(s.status).toBe('ok');
		expect(calls.filter((c) => c.url.includes('metric=views,reach'))).toHaveLength(3);
		expect(s.totals.views).toBe(30);
		expect(s.countries).toEqual([]);
		expect(s.notes[0]).toContain('100 or more followers');
	});

	it('asks for a reconnect when the insights permission is missing', async () => {
		mockFetch([
			[/\/me\?fields=followers_count/, () => ok({ followers_count: 50 })],
			[/insights/, () => new Response(JSON.stringify({ error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10 } }), { status: 400 })],
		]);
		seedAccount('instagram');
		const s = (await report(28, undefined, false)).accounts[0];
		expect(s.status).toBe('reconnect');
		expect(s.followers).toBe(50);
	});
});

describe('TikTok', () => {
	it('covers recent videos and says what TikTok does not share', async () => {
		const now = Math.floor(Date.now() / 1000);
		const calls = mockFetch([
			[/open\.tiktokapis\.com\/v2\/user\/info\//, () => ok({ data: { user: { follower_count: 500, likes_count: 9000, video_count: 3 } }, error: { code: 'ok' } })],
			[/open\.tiktokapis\.com\/v2\/video\/list\//, () =>
				ok({ data: { videos: [
					{ id: 'a', title: 'New one', view_count: 300, like_count: 30, comment_count: 3, share_count: 1, create_time: now - 3600, share_url: 'https://www.tiktok.com/@me/video/a' },
					{ id: 'b', title: 'Old one', view_count: 9999, like_count: 1, comment_count: 0, share_count: 0, create_time: now - 400 * 86400 },
				], has_more: false }, error: { code: 'ok' } })],
		]);
		seedAccount('tiktok');
		const s = (await report(28, undefined, false)).accounts[0];
		expect(s.status).toBe('ok');
		expect(s.followers).toBe(500);
		// Only videos from this period count.
		expect(s.totals).toEqual({ allTimeLikes: 9000, views: 300, likes: 30, comments: 3, shares: 1 });
		expect(s.top).toHaveLength(1);
		expect(s.top[0]).toMatchObject({ id: 'a', title: 'New one', publishedAt: (now - 3600) * 1000, permalink: 'https://www.tiktok.com/@me/video/a' });
		expect(s.countries).toEqual([]);
		expect(s.daily).toEqual([]);
		expect(s.notes[0]).toContain('does not give apps');
		expect(s.notes[0]).toContain('the 1 video posted');
		const list = calls.find((c) => c.url.includes('video/list'))!;
		expect(list.method).toBe('POST');
		expect(JSON.parse(list.body!)).toEqual({ max_count: 20 });
	});
});

describe('demo accounts', () => {
	it('get steady made-up numbers and never call a platform', async () => {
		const calls = mockFetch([]);
		for (const p of ['youtube', 'instagram', 'tiktok'] as const) seedAccount(p, { demo: true });
		const a = await report(28, undefined, false);
		const b = await report(28, undefined, true);
		expect(calls).toHaveLength(0);
		expect(a.accounts).toHaveLength(3);
		for (let i = 0; i < 3; i++) {
			const [x, y] = [a.accounts[i], b.accounts[i]];
			expect(x.status).toBe('ok');
			expect(x.isDemo).toBe(true);
			expect(x.totals).toEqual(y.totals);
			expect(x.notes[0].startsWith('Demo data')).toBe(true);
			expect(x.top.map((t) => t.title)).toEqual(['Demo video 1', 'Demo video 2', 'Demo video 3', 'Demo video 4', 'Demo video 5']);
		}
		const yt = a.accounts.find((s) => s.platform === 'youtube')!;
		expect(yt.daily).toHaveLength(28);
		expect(yt.daily.every((d) => typeof d.views === 'number')).toBe(true);
		expect(yt.totals.watchMinutes).toBeGreaterThan(0);
		expect(yt.countries).toHaveLength(10);
		expect(yt.countries.reduce((t, c) => t + c.share, 0)).toBeCloseTo(1, 9);
		expect(yt.ages).toHaveLength(7);
		const ig = a.accounts.find((s) => s.platform === 'instagram')!;
		expect(ig.countriesOf).toBe('followers');
		expect(ig.daily.every((d) => typeof d.reach === 'number' && d.views === undefined)).toBe(true);
		const tt = a.accounts.find((s) => s.platform === 'tiktok')!;
		expect(tt.daily).toEqual([]);
		expect(tt.countries).toEqual([]);
		expect(tt.notes[1]).toContain('TikTok does not give apps audience countries');
	});
});

describe('filters', () => {
	it('limits to one account, clamps days to 7..90 and skips disconnected accounts', async () => {
		mockFetch([]);
		const yt = seedAccount('youtube', { demo: true });
		seedAccount('instagram', { demo: true });
		const gone = seedAccount('tiktok', { demo: true });
		getDb().prepare("UPDATE accounts SET status = 'disconnected' WHERE id = ?").run(gone.id);

		const all = await report(28, undefined, false);
		expect(all.accounts.map((s) => s.platform).sort()).toEqual(['instagram', 'youtube']);

		const one = await report(7, yt.id, false);
		expect(one.accounts).toHaveLength(1);
		expect(one.accounts[0].accountId).toBe(yt.id);
		expect(one.accounts[0].days).toBe(7);
		expect(one.accounts[0].daily).toHaveLength(7);

		expect((await report(3, yt.id, false)).days).toBe(7);
		expect((await report(365, yt.id, false)).accounts[0].daily).toHaveLength(90);
		expect((await report(28, 'nope', false)).accounts).toEqual([]);
	});
});
