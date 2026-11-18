// Account statistics: followers, views, likes, comments and shares, audience countries and ages,
// and the best recent posts, read from each platform's own analytics API. Nothing is posted.
// Port of windows/core/src/analytics.rs; keep the two in step.
//
// What each platform shares with apps differs, and the page says so:
// - YouTube (YouTube Analytics API, `yt-analytics.readonly`): daily views, likes, comments,
//   shares, watch time and subscribers; viewers by country, age and gender; top videos.
// - Instagram (`instagram_business_manage_insights`): views, reach, likes, comments, shares and
//   saves; followers by country, age and gender (Instagram needs 100+ followers); recent posts.
// - TikTok (`user.info.stats`, `video.list`): followers and total likes; views, likes, comments
//   and shares of recent videos. TikTok does not give apps audience countries or daily numbers.
//
// Results are cached for 10 minutes per account and period.
import { FB_GRAPH, viaUnified } from './platforms/instagram.js';
import { accessToken, getAccount, listAccounts } from './accounts.js';
import { config } from './config.js';
import type { Platform } from './db.js';
import { json } from './platforms/http.js';
import { AuthError } from './platforms/types.js';

const CACHE_MS = 600_000;
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2';
const INSTAGRAM_GRAPH = 'https://graph.instagram.com';
const TIKTOK_API = 'https://open.tiktokapis.com';

const LABEL: Record<Platform, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };

export type TopItem = {
	id: unknown;
	title: unknown;
	thumbnail: unknown;
	permalink: unknown;
	publishedAt: unknown;
	views: unknown;
	likes: unknown;
	comments: unknown;
	shares: unknown;
};

export type AccountStats = {
	accountId: string;
	platform: Platform;
	name: string;
	handle: string | null;
	avatarUrl: string | null;
	isDemo: boolean;
	days: number;
	status: 'ok' | 'reconnect' | 'error';
	message: string | null;
	followers: number | null;
	totals: Record<string, number>;
	daily: ({ date: string } & Record<string, number | string>)[];
	countries: { code: string; value: number; share: number }[];
	countriesOf: 'views' | 'followers';
	ages: { age: string; female: number; male: number; other: number }[];
	top: TopItem[];
	notes: string[];
};

export type StatsReport = { days: number; generatedAt: number; accounts: AccountStats[] };

/** Account stats by "account:days", kept for a few minutes. */
const cache = new Map<string, { at: number; v: AccountStats }>();

/** For tests. */
export function clearAnalyticsCache() {
	cache.clear();
}

/** Stats for every connected account (or one), for the last `days` days. */
export async function report(days: number, accountId: string | undefined, fresh: boolean): Promise<StatsReport> {
	const d = Math.min(90, Math.max(7, Number.isFinite(days) ? Math.trunc(days) : 28));
	const accounts = listAccounts().filter((a) => a.status !== 'disconnected' && (accountId === undefined || a.id === accountId));
	const out = await Promise.all(accounts.map((a) => account(a, d, fresh)));
	return { days: d, generatedAt: Date.now(), accounts: out };
}

type PublicAccount = ReturnType<typeof listAccounts>[number];

async function account(a: PublicAccount, days: number, fresh: boolean): Promise<AccountStats> {
	const id = a.id;
	const key = `${id}:${days}`;
	if (!fresh) {
		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
	}
	const platform: Platform = (['tiktok', 'instagram', 'youtube'] as const).includes(a.platform as any) ? a.platform : 'youtube';
	const s = new Stats(a, platform, days);
	try {
		if (a.isDemo) demo(s);
		else if (a.status === 'reconnect_required') throw new AuthError('Sign-in expired');
		else {
			const token = await accessToken(id);
			if (platform === 'youtube') await youtube(token, s);
			else if (platform === 'instagram') await instagram(token, getAccount(id)?.external_id ?? '', s, viaUnified(getAccount(id)));
			else await tiktok(token, s);
		}
	} catch (e: any) {
		const msg = String(e?.message ?? e);
		const scope = e instanceof AuthError || ['insufficient', 'scope', 'permission', '(#10)', '(#200)'].some((w) => msg.toLowerCase().includes(w));
		s.status = scope ? 'reconnect' : 'error';
		s.message = scope
			? `Reconnect this ${LABEL[platform]} account in Connected accounts to allow stats. Accounts connected before stats existed did not grant them.`
			: `Could not load stats right now (${msg}).`;
	}
	const v = s.finish();
	// Problems are not cached, so a reconnect shows up straight away.
	if (v.status === 'ok') cache.set(key, { at: Date.now(), v });
	return v;
}

// ---------- JSON helpers (serde_json semantics) ----------

/** Value::as_f64: numbers only. */
const f64 = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
/** Value::as_i64: integers only. */
const i64 = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
/** Indexing a missing serde_json field yields Null. */
const val = (v: unknown) => (v === undefined ? null : v);
/** util::js_str. */
function str(v: unknown): string {
	if (v == null) return '';
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return JSON.stringify(v);
}
/** str::parse::<f64>() of a decimal string. */
function parseF64(v: unknown): number | null {
	if (typeof v !== 'string' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return null;
	return Number(v);
}
/** First `n` Unicode scalar values. */
const chars = (s: string, n: number) => Array.from(s).slice(0, n).join('');
/** str::lines().next(): first line without its line ending. */
const firstLine = (s: string) => s.split('\n')[0].replace(/\r$/, '');
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/// What one account's stats are made of. Totals that a platform does not report stay absent, so the
/// page can say "not available" instead of showing a misleading zero.
class Stats {
	head: Pick<AccountStats, 'accountId' | 'platform' | 'name' | 'handle' | 'avatarUrl' | 'isDemo'>;
	status: AccountStats['status'] = 'ok';
	message: string | null = null;
	followers: number | null = null;
	totals: Record<string, number> = {};
	daily = new Map<string, Record<string, number>>();
	countries: [string, number][] = [];
	countriesOf: AccountStats['countriesOf'] = 'views';
	ages: AccountStats['ages'] = [];
	top: TopItem[] = [];
	notes: string[] = [];

	constructor(a: PublicAccount, platform: Platform, readonly days: number) {
		this.head = { accountId: a.id, platform, name: a.displayName, handle: val(a.handle) as string | null, avatarUrl: val(a.avatarUrl) as string | null, isDemo: a.isDemo };
	}
	total(k: string, v: number) {
		this.totals[k] = (this.totals[k] ?? 0) + v;
	}
	day(date: string, k: string, v: number) {
		let d = this.daily.get(date);
		if (!d) this.daily.set(date, (d = {}));
		d[k] = (d[k] ?? 0) + v;
	}
	finish(): AccountStats {
		const sum = this.countries.reduce((t, c) => t + c[1], 0);
		const sorted = [...this.countries].sort((a, b) => b[1] - a[1]);
		const countries = sorted.slice(0, 10).map(([code, value]) => ({ code, value, share: sum > 0 ? value / sum : 0 }));
		const daily = [...this.daily.keys()].sort().map((date) => ({ ...this.daily.get(date)!, date }));
		return {
			...this.head,
			days: this.days,
			status: this.status,
			message: this.message,
			followers: this.followers,
			totals: this.totals,
			daily,
			countries,
			countriesOf: this.countriesOf,
			ages: this.ages,
			top: this.top,
			notes: this.notes,
		};
	}
}

const DAY = 86_400_000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Today (UTC) as midnight milliseconds. */
const todayMs = () => Date.parse(`${isoDate(Date.now())}T00:00:00Z`);
/** First and last day of the period, as UTC-midnight milliseconds. */
function range(days: number): [number, number] {
	const end = todayMs();
	return [end - (days - 1) * DAY, end];
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

// ---------- YouTube ----------

/** Rows of a YouTube Analytics report, keyed by column name. */
function rows(r: any): Record<string, unknown>[] {
	const names: string[] = Array.isArray(r?.columnHeaders) ? r.columnHeaders.map((c: any) => str(c?.name)) : [];
	if (!Array.isArray(r?.rows)) return [];
	return r.rows
		.filter((row: unknown) => Array.isArray(row))
		.map((cells: unknown[]) => {
			const o: Record<string, unknown> = {};
			for (let i = 0; i < Math.min(names.length, cells.length); i++) o[names[i]] = cells[i];
			return o;
		});
}

async function youtube(token: string, s: Stats) {
	const [start, end] = range(s.days);
	const ch = await json(`${YOUTUBE_API}/channels?part=statistics&mine=true`, bearer(token));
	s.followers = parseF64(ch?.items?.[0]?.statistics?.subscriberCount);
	const report = (q: string) => `${YOUTUBE_ANALYTICS}/reports?ids=channel%3D%3DMINE&startDate=${isoDate(start)}&endDate=${isoDate(end)}&${q}`;

	const daily = await json(report('metrics=views,likes,comments,shares,estimatedMinutesWatched,subscribersGained,subscribersLost&dimensions=day&sort=day'), bearer(token));
	for (const r of rows(daily)) {
		const date = str(r.day);
		for (const [k, col] of [['views', 'views'], ['likes', 'likes'], ['comments', 'comments'], ['shares', 'shares'], ['watchMinutes', 'estimatedMinutesWatched']]) {
			const v = f64(r[col]) ?? 0;
			s.day(date, k, v);
			s.total(k, v);
		}
		s.total('followersGained', (f64(r.subscribersGained) ?? 0) - (f64(r.subscribersLost) ?? 0));
	}
	// The audience breakdowns are best effort: small channels often have none.
	const c = await json(report('metrics=views&dimensions=country&sort=-views&maxResults=25'), bearer(token)).catch(() => undefined);
	if (c !== undefined) s.countries = rows(c).map((r) => [str(r.country), f64(r.views) ?? 0]);
	const ag = await json(report('metrics=viewerPercentage&dimensions=ageGroup,gender&sort=ageGroup'), bearer(token)).catch(() => undefined);
	if (ag !== undefined) s.ages = ages(rows(ag).map((r) => [str(r.ageGroup).replaceAll('age', ''), str(r.gender), f64(r.viewerPercentage) ?? 0]));
	if (s.countries.length === 0) s.notes.push('YouTube shows audience countries once enough people have watched.');
	const t = await json(report('metrics=views,likes,comments,shares&dimensions=video&sort=-views&maxResults=6'), bearer(token)).catch(() => undefined);
	if (t !== undefined) {
		const list = rows(t);
		const ids = list.map((r) => str(r.video));
		const snippets: any = ids.length === 0 ? null : await json(`${YOUTUBE_API}/videos?part=snippet&id=${encodeURIComponent(ids.join(','))}`, bearer(token)).catch(() => null);
		for (const r of list) {
			const id = str(r.video);
			const sn = (Array.isArray(snippets?.items) ? snippets.items.find((v: any) => v?.id === id)?.snippet : undefined) ?? null;
			s.top.push({
				id,
				title: val(sn?.title),
				thumbnail: val(sn?.thumbnails?.medium?.url),
				publishedAt: val(sn?.publishedAt),
				permalink: `https://www.youtube.com/watch?v=${id}`,
				views: val(r.views),
				likes: val(r.likes),
				comments: val(r.comments),
				shares: val(r.shares),
			});
		}
	}
}

/** Turns (age group, gender, percentage) rows into one row per age group. */
function ages(list: [string, string, number][]): AccountStats['ages'] {
	const by = new Map<string, [number, number, number]>();
	for (const [age, gender, pct] of list) {
		let e = by.get(age);
		if (!e) by.set(age, (e = [0, 0, 0]));
		const g = gender.toLowerCase();
		if (g === 'female' || g === 'f') e[0] += pct;
		else if (g === 'male' || g === 'm') e[1] += pct;
		else e[2] += pct;
	}
	return [...by.keys()].sort().map((age) => {
		const [female, male, other] = by.get(age)!;
		return { age, female, male, other };
	});
}

// ---------- Instagram ----------

async function instagram(token: string, igId: string, s: Stats, unified = false) {
	// Unified-login accounts are read on graph.facebook.com, where /me is the business, not the account.
	const g = unified ? FB_GRAPH : `${INSTAGRAM_GRAPH}/${config.instagram.apiVersion}`;
	const me = await json(`${g}/${unified ? igId : 'me'}?fields=followers_count,media_count`, bearer(token));
	s.followers = f64(me?.followers_count) ?? null;
	s.countriesOf = 'followers';

	// Instagram answers at most 30 days per request.
	const [start, end] = range(s.days);
	for (let from = start; from <= end; ) {
		const to = Math.min(from + 29 * DAY, end);
		const since = from / 1000;
		const until = (to + DAY) / 1000;
		const totals = await json(`${g}/${igId}/insights?metric=views,reach,likes,comments,shares,saves&period=day&metric_type=total_value&since=${since}&until=${until}`, bearer(token));
		for (const m of arr(totals?.data)) s.total(str(m?.name), f64(m?.total_value?.value) ?? 0);
		const series = await json(`${g}/${igId}/insights?metric=reach&period=day&since=${since}&until=${until}`, bearer(token)).catch(() => undefined);
		if (series !== undefined) {
			for (const v of arr(series?.data?.[0]?.values)) s.day(chars(str(v?.end_time), 10), 'reach', f64(v?.value) ?? 0);
		}
		from = to + DAY;
	}

	const demoOf = (b: string) => `${g}/${igId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=${b}`;
	try {
		const c = await json(demoOf('country'), bearer(token));
		for (const r of arr(c?.data?.[0]?.total_value?.breakdowns?.[0]?.results)) s.countries.push([str(r?.dimension_values?.[0]), f64(r?.value) ?? 0]);
	} catch {
		s.notes.push('Instagram shares follower countries and ages once an account has 100 or more followers.');
	}
	const a = await json(demoOf('age,gender'), bearer(token)).catch(() => undefined);
	if (a !== undefined) {
		const list: [string, string, number][] = arr(a?.data?.[0]?.total_value?.breakdowns?.[0]?.results).map((r) => [str(r?.dimension_values?.[0]), str(r?.dimension_values?.[1]), f64(r?.value) ?? 0]);
		const sum = list.reduce((t, r) => t + r[2], 0);
		s.ages = ages(list.map(([x, y, v]) => [x, y, sum > 0 ? (v * 100) / sum : 0]));
	}

	// Recent posts, with their own views and shares where Instagram reports them.
	const media = await json(`${g}/${igId}/media?fields=id,caption,permalink,thumbnail_url,media_url,media_type,timestamp,like_count,comments_count&limit=12`, bearer(token)).catch(() => null);
	for (const m of arr(media?.data).slice(0, 8)) {
		const id = str(m?.id);
		const ins = await json(`${g}/${id}/insights?metric=views,shares,saved`, bearer(token)).catch(() => null);
		const metric = (n: string) => {
			const x = Array.isArray(ins?.data) ? ins.data.find((d: any) => d?.name === n) : undefined;
			if (!x) return null;
			return f64(x?.values?.[0]?.value) ?? f64(x?.total_value?.value) ?? null;
		};
		const thumb = m?.media_type === 'VIDEO' ? val(m?.thumbnail_url) : val(m?.media_url);
		s.top.push({
			id,
			title: chars(firstLine(str(m?.caption)), 90),
			thumbnail: thumb,
			publishedAt: val(m?.timestamp),
			permalink: val(m?.permalink),
			views: metric('views'),
			likes: val(m?.like_count),
			comments: val(m?.comments_count),
			shares: metric('shares'),
		});
	}
	s.top.sort((x, y) => (f64(y.views) ?? -1) - (f64(x.views) ?? -1));
	s.top.length = Math.min(s.top.length, 6);
	s.notes.push('Instagram reports accounts reached per day; views are totals for the period.');
}

// ---------- TikTok ----------

async function tiktok(token: string, s: Stats) {
	const u = await json(`${TIKTOK_API}/v2/user/info/?fields=open_id,follower_count,likes_count,video_count`, bearer(token));
	const user = u?.data?.user;
	s.followers = f64(user?.follower_count) ?? null;
	const likes = f64(user?.likes_count);
	if (likes !== undefined) s.totals.allTimeLikes = likes;
	const since = Math.floor((Date.now() - s.days * DAY) / 1000);
	let cursor: number | undefined;
	const seen: any[] = [];
	for (let page = 0; page < 5; page++) {
		const body: Record<string, unknown> = { max_count: 20 };
		if (cursor !== undefined) body.cursor = cursor;
		const r = await json(`${TIKTOK_API}/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,view_count,like_count,comment_count,share_count,create_time`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
			body: JSON.stringify(body),
		});
		let older = false;
		for (const v of arr(r?.data?.videos)) {
			if ((i64(v?.create_time) ?? 0) < since) {
				older = true;
				continue;
			}
			seen.push(v);
		}
		if (older || r?.data?.has_more !== true) break;
		cursor = i64(r?.data?.cursor);
	}
	for (const v of seen) {
		for (const [k, col] of [['views', 'view_count'], ['likes', 'like_count'], ['comments', 'comment_count'], ['shares', 'share_count']]) s.total(k, f64(v?.[col]) ?? 0);
	}
	const top = [...seen].sort((a, b) => (f64(b?.view_count) ?? 0) - (f64(a?.view_count) ?? 0));
	s.top = top.slice(0, 6).map((v) => {
		const title = [str(v?.title), str(v?.video_description)].find((t) => t.trim() !== '') ?? '';
		const ct = i64(v?.create_time);
		return {
			id: val(v?.id),
			title: chars(title, 90),
			thumbnail: val(v?.cover_image_url),
			permalink: val(v?.share_url),
			publishedAt: ct !== undefined ? ct * 1000 : null,
			views: val(v?.view_count),
			likes: val(v?.like_count),
			comments: val(v?.comment_count),
			shares: val(v?.share_count),
		};
	});
	s.notes.push(
		`Views, likes, comments and shares are lifetime numbers of the ${seen.length} video${seen.length === 1 ? '' : 's'} posted in this period. TikTok does not give apps daily numbers or audience countries.`,
	);
}

// ---------- demo ----------

const U64 = (1n << 64n) - 1n;

/** Made-up but steady numbers for demo accounts, so the page can be tried without a real account. Never calls a platform. */
function demo(s: Stats) {
	// Same seed and xorshift as the Windows build (u64 wrapping arithmetic), so both show the same numbers.
	let x = 7n;
	for (const b of new TextEncoder().encode(s.head.accountId)) x = (x * 31n + BigInt(b)) & U64;
	const rnd = () => {
		x ^= (x << 13n) & U64;
		x ^= x >> 7n;
		x ^= (x << 17n) & U64;
		return Number(x % 10_000n) / 10_000;
	};
	const p = s.head.platform;
	const scale = p === 'youtube' ? 1800 : p === 'instagram' ? 1200 : 2600;
	s.followers = Math.round(scale * 9 * (1 + rnd()));
	const [start] = range(s.days);
	for (let i = 0; i < s.days; i++) {
		const date = isoDate(start + i * DAY);
		const weekly = 1 + 0.25 * Math.sin((i * 2 * Math.PI) / 7);
		const growth = 1 + (i / s.days) * 0.4;
		const views = Math.round(scale * weekly * growth * (0.75 + rnd() * 0.5));
		const key = p === 'instagram' ? 'reach' : 'views';
		if (p !== 'tiktok') s.day(date, key, views);
		s.total('views', views);
		s.total('likes', Math.round(views * (0.06 + rnd() * 0.02)));
		s.total('comments', Math.round(views * (0.004 + rnd() * 0.003)));
		s.total('shares', Math.round(views * (0.008 + rnd() * 0.004)));
		if (p === 'youtube') s.total('watchMinutes', Math.round(views * (0.9 + rnd() * 0.4)));
	}
	s.total('followersGained', Math.round(scale * 0.4 * (0.5 + rnd())));
	if (p !== 'tiktok') {
		for (const [code, w] of [['US', 30], ['BR', 12], ['GB', 9], ['IN', 8], ['DE', 6], ['MX', 5], ['CA', 5], ['PH', 4], ['FR', 3.5], ['ID', 3]] as const) {
			s.countries.push([code, Math.round(w * scale * (0.8 + rnd() * 0.4))]);
		}
		s.countriesOf = p === 'instagram' ? 'followers' : 'views';
		s.ages = ages(
			([['13-17', 6], ['18-24', 31], ['25-34', 34], ['35-44', 16], ['45-54', 8], ['55-64', 3], ['65-', 2]] as const).flatMap(([a, v]): [string, string, number][] => [
				[a, 'female', v * 0.52],
				[a, 'male', v * 0.45],
				[a, 'other', v * 0.03],
			]),
		);
	}
	for (let i = 0; i < 5; i++) {
		const v = Math.round(scale * 6 * (1 - i * 0.15) * (0.8 + rnd() * 0.4));
		s.top.push({ id: `demo-${i}`, title: `Demo video ${i + 1}`, thumbnail: null, permalink: null, publishedAt: Date.now() - (i + 1) * DAY * 3, views: v, likes: Math.round(v * 0.07), comments: Math.round(v * 0.006), shares: Math.round(v * 0.01) });
	}
	s.notes.push('Demo data: made up so you can try this page. Connect a real account to see your own numbers.');
	if (p === 'tiktok') s.notes.push('Real TikTok accounts show followers, likes and recent video numbers; TikTok does not give apps audience countries.');
}
