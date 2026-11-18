import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, PLATFORM_NAME, type Account, type Group, type Platform, type Stats, type StatsReport } from '../api';
import { Avatar, Icon, PlatformMark, Seg } from '../ui';

// One fixed color per platform (validated together for the dark surface: lightness band, chroma,
// colorblind separation and contrast). Color follows the platform, never its rank.
export const PLATFORM_COLOR: Record<Platform, string> = { youtube: '#3987e5', instagram: '#d95926', tiktok: '#199e70' };
const ORDER: Platform[] = ['youtube', 'instagram', 'tiktok'];

const fmt = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? '–' : Intl.NumberFormat(undefined, { notation: Math.abs(n) >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
const pct = (n: number) => `${(n * 100).toFixed(n >= 0.1 ? 0 : 1)}%`;
const countryName = (code: string) => {
	try {
		return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code;
	} catch {
		return code;
	}
};
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** The daily number each platform reports: views on YouTube, accounts reached on Instagram. */
const dailyKey = (s: Stats) => (s.daily.some((d) => d.views != null) ? 'views' : 'reach');
const dailyLabel = (s: Stats) => (dailyKey(s) === 'views' ? 'views' : 'accounts reached');

export function StatsPage({ accounts, go }: { accounts: Account[]; go: (p: string) => void }) {
	const [days, setDays] = useState(28);
	const [pick, setPick] = useState<string>('all');
	// Saved groups (Mac server). A backend without groups answers 404, which simply means none.
	const [groups, setGroups] = useState<Group[]>([]);
	useEffect(() => void api.groups().then(setGroups).catch(() => undefined), []);
	const [data, setData] = useState<StatsReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const live = accounts.filter((a) => a.status !== 'disconnected');

	async function load(fresh = false) {
		setLoading(true);
		setError(null);
		try {
			setData(await api.analytics(days, fresh));
		} catch (e: any) {
			setError(e.message);
		} finally {
			setLoading(false);
		}
	}
	useEffect(() => void load(), [days]);

	if (!live.length)
		return (
			<div className="panel empty">
				<b>No accounts yet</b>
				Connect YouTube, Instagram or TikTok to see followers, views, likes and where your audience is.
				<div style={{ marginTop: 16 }}><button className="btn sm primary" onClick={() => go('/accounts')}>Connect an account</button></div>
			</div>
		);

	const all = (data?.accounts ?? []).slice().sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform));
	const group = pick.startsWith('g:') ? groups.find((g) => g.id === pick.slice(2)) : undefined;
	// A group shows the combined numbers of just its accounts.
	const shown = pick === 'all' ? all : group ? all.filter((s) => group.accountIds.includes(s.accountId)) : all.filter((s) => s.accountId === pick);
	const ok = shown.filter((s) => s.status === 'ok');
	const problems = shown.filter((s) => s.status !== 'ok');

	return (
		<div className="stats">
			<div className="stats-bar">
				<div className="chips" role="group" aria-label="Account">
					<button className={`schip ${pick === 'all' ? 'on' : ''}`} onClick={() => setPick('all')}>All accounts</button>
					{groups.filter((g) => g.accountIds.length).map((g) => (
						<button key={g.id} className={`schip group ${pick === `g:${g.id}` ? 'on' : ''}`} onClick={() => setPick(`g:${g.id}`)} title={`${g.name}: combined numbers of its ${g.accountIds.length} accounts`}>
							<Icon.accounts />
							<span className="ellipsis">{g.name}</span>
						</button>
					))}
					{all.map((s) => (
						<button key={s.accountId} className={`schip ${pick === s.accountId ? 'on' : ''}`} onClick={() => setPick(s.accountId)} title={`${s.name} on ${PLATFORM_NAME[s.platform]}`}>
							<span className="sdot" style={{ background: PLATFORM_COLOR[s.platform] }} />
							<PlatformMark p={s.platform} size={12} bare />
							<span className="ellipsis">{s.name}</span>
						</button>
					))}
				</div>
				<span className="grow" />
				<Seg label="Period" value={String(days)} onChange={(v) => setDays(Number(v))} options={[{ value: '7', label: '7 days' }, { value: '28', label: '28 days' }, { value: '90', label: '90 days' }]} />
				<button className="btn sm" disabled={loading} onClick={() => load(true)} title="Ask the platforms again (results are kept for 10 minutes)"><Icon.retry /> {loading ? 'Loading…' : 'Refresh'}</button>
			</div>

			{error && <div className="notice bad"><Icon.info /><span>{error}</span></div>}
			{!data && !error && <div className="panel empty">Loading stats…</div>}
			{problems.map((s) => (
				<div key={s.accountId} className={`notice ${s.status === 'reconnect' ? 'warn' : 'bad'}`}>
					<PlatformMark p={s.platform} size={14} bare />
					<span className="grow"><b>{s.name}</b>: {s.message}</span>
					{s.status === 'reconnect' && <button className="btn sm" onClick={() => go('/accounts')}>Reconnect</button>}
				</div>
			))}

			{data && ok.length > 0 && (
				<>
					<Tiles list={ok} single={pick !== 'all'} />
					<Trend list={ok} days={data.days} />
					<div className="stats-grid">
						{ok.filter((s) => s.countries.length).map((s) => <Countries key={s.accountId} s={s} showName={ok.length > 1} />)}
						{ok.filter((s) => s.ages.length).map((s) => <Ages key={s.accountId} s={s} showName={ok.length > 1} />)}
					</div>
					<TopPosts list={ok} />
					<Notes list={ok} />
				</>
			)}
		</div>
	);
}

// ---------- tiles ----------

type Tile = { key: string; label: string; icon: () => React.ReactNode; sub?: string };
const TILES: Tile[] = [
	{ key: 'followers', label: 'Followers', icon: Icon.accounts },
	{ key: 'views', label: 'Views', icon: Icon.eye },
	{ key: 'likes', label: 'Likes', icon: Icon.heart },
	{ key: 'comments', label: 'Comments', icon: Icon.comment },
	{ key: 'shares', label: 'Shares', icon: Icon.share },
	{ key: 'watchMinutes', label: 'Watch time', icon: Icon.clock, sub: 'hours' },
	{ key: 'saves', label: 'Saves', icon: Icon.bookmark },
	{ key: 'reach', label: 'Accounts reached', icon: Icon.eye },
	{ key: 'followersGained', label: 'New followers', icon: Icon.create },
	{ key: 'allTimeLikes', label: 'Likes, all time', icon: Icon.heart },
];

function valueOf(s: Stats, key: string): number | null {
	if (key === 'followers') return s.followers;
	const v = s.totals[key];
	return typeof v === 'number' ? (key === 'watchMinutes' ? Math.round(v / 60) : v) : null;
}

function Tiles({ list, single }: { list: Stats[]; single: boolean }) {
	const tiles = TILES.filter((t) => list.some((s) => valueOf(s, t.key) != null));
	return (
		<div className="tiles">
			{tiles.map((t) => {
				const parts = list.map((s) => ({ s, v: valueOf(s, t.key) })).filter((p) => p.v != null) as { s: Stats; v: number }[];
				const total = parts.reduce((n, p) => n + p.v, 0);
				const spark = single && (t.key === 'views' || t.key === 'reach') ? list[0].daily.map((d) => Number(d[t.key] ?? 0)) : null;
				return (
					<div className="panel tile" key={t.key}>
						<span className="tile-ico"><t.icon /></span>
						<div className="tile-body">
							<span className="tile-label">{t.label}</span>
							<b className="tile-num">{fmt(total)}</b>
							<span className="tile-sub" title={parts.map((p) => `${PLATFORM_NAME[p.s.platform]} ${fmt(p.v)}`).join(' · ')}>
								{!single && parts.length > 1
									? parts.map((p) => `${PLATFORM_NAME[p.s.platform]} ${fmt(p.v)}`).join(' · ')
									: parts.length < list.length && !single
										? `${parts.map((p) => PLATFORM_NAME[p.s.platform]).join(', ')} only`
										: t.sub ?? (t.key === 'followers' ? 'now' : 'this period')}
							</span>
							{spark && spark.length > 1 && <Spark values={spark} color={PLATFORM_COLOR[list[0].platform]} />}
						</div>
					</div>
				);
			})}
		</div>
	);
}

function Spark({ values, color }: { values: number[]; color: string }) {
	const w = 120;
	const h = 36;
	const max = Math.max(1, ...values);
	const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
	return (
		<svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
			<polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
		</svg>
	);
}

// ---------- trend ----------

function Trend({ list, days }: { list: Stats[]; days: number }) {
	const series = list.filter((s) => s.daily.length > 1);
	const [hover, setHover] = useState<number | null>(null);
	const [table, setTable] = useState(false);
	const ref = useRef<SVGSVGElement>(null);
	const dates = useMemo(() => Array.from(new Set(series.flatMap((s) => s.daily.map((d) => d.date)))).sort(), [series]);
	if (!series.length) return null;
	const W = 900;
	const H = 240;
	const pad = { l: 44, r: 12, t: 12, b: 26 };
	const vals = (s: Stats) => dates.map((d) => Number(s.daily.find((x) => x.date === d)?.[dailyKey(s)] ?? 0));
	const max = Math.max(1, ...series.flatMap(vals));
	const nice = niceMax(max);
	const x = (i: number) => pad.l + (dates.length < 2 ? 0 : (i / (dates.length - 1)) * (W - pad.l - pad.r));
	const y = (v: number) => pad.t + (1 - v / nice) * (H - pad.t - pad.b);
	const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * nice);
	const every = Math.max(1, Math.ceil(dates.length / 7));

	function move(e: React.PointerEvent) {
		const r = ref.current!.getBoundingClientRect();
		const px = ((e.clientX - r.left) / r.width) * W;
		const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (dates.length - 1));
		setHover(Math.max(0, Math.min(dates.length - 1, i)));
	}

	return (
		<div className="panel chart">
			<div className="chart-head">
				<b>Daily audience</b>
				<span className="faint">Last {days} days</span>
				<span className="grow" />
				<div className="legend">
					{series.map((s) => (
						<span key={s.accountId}><i style={{ background: PLATFORM_COLOR[s.platform] }} />{s.name} · {dailyLabel(s)}</span>
					))}
				</div>
				<button className="btn sm quiet" onClick={() => setTable(!table)}>{table ? 'Show chart' : 'Show as table'}</button>
			</div>
			{table ? (
				<div className="chart-table">
					<table>
						<thead><tr><th>Date</th>{series.map((s) => <th key={s.accountId}>{s.name} ({dailyLabel(s)})</th>)}</tr></thead>
						<tbody>{dates.map((d, i) => <tr key={d}><td>{shortDate(d)}</td>{series.map((s) => <td key={s.accountId} className="mono">{fmt(vals(s)[i])}</td>)}</tr>)}</tbody>
					</table>
				</div>
			) : (
				<div className="chart-wrap">
					<svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="trend" onPointerMove={move} onPointerLeave={() => setHover(null)} role="img" aria-label={`Daily ${series.map((s) => `${s.name} ${dailyLabel(s)}`).join(', ')}`}>
						{ticks.map((t) => (
							<g key={t}>
								<line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
								<text x={pad.l - 8} y={y(t) + 4} className="axis" textAnchor="end">{fmt(t)}</text>
							</g>
						))}
						{dates.map((d, i) => (i % every === 0 || i === dates.length - 1 ? <text key={d} x={x(i)} y={H - 6} className="axis" textAnchor={i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'}>{shortDate(d)}</text> : null))}
						{series.map((s) => {
							const v = vals(s);
							const line = v.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(' ');
							return (
								<g key={s.accountId}>
									<path d={`${line} L${x(v.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={PLATFORM_COLOR[s.platform]} opacity={0.08} />
									<path d={line} fill="none" stroke={PLATFORM_COLOR[s.platform]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
								</g>
							);
						})}
						{hover != null && (
							<g>
								<line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="cross" />
								{series.map((s) => <circle key={s.accountId} cx={x(hover)} cy={y(vals(s)[hover])} r={4.5} fill={PLATFORM_COLOR[s.platform]} stroke="var(--s1)" strokeWidth={2} />)}
							</g>
						)}
					</svg>
					{hover != null && (
						<div className="tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
							<b>{shortDate(dates[hover])}</b>
							{series.map((s) => <span key={s.accountId}><i style={{ background: PLATFORM_COLOR[s.platform] }} />{s.name}<em>{fmt(vals(s)[hover])}</em></span>)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function niceMax(v: number) {
	const p = 10 ** Math.floor(Math.log10(v));
	return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? v;
}

// ---------- audience ----------

function Countries({ s, showName }: { s: Stats; showName: boolean }) {
	const top = s.countries[0]?.share ?? 1;
	return (
		<div className="panel abox">
			<div className="abox-head">
				<b>Top countries</b>
				<span className="faint">{showName ? `${s.name} · ` : ''}{s.countriesOf === 'followers' ? 'share of followers' : 'share of views'}</span>
			</div>
			{s.countries.map((c) => (
				<div className="bar-row" key={c.code} title={`${countryName(c.code)}: ${fmt(c.value)} ${s.countriesOf}`}>
					<span className="bar-name"><span className="ellipsis">{countryName(c.code)}</span></span>
					<span className="bar-track"><i style={{ width: `${(c.share / top) * 100}%`, background: PLATFORM_COLOR[s.platform] }} /></span>
					<span className="bar-val mono">{pct(c.share)}</span>
				</div>
			))}
		</div>
	);
}

function Ages({ s, showName }: { s: Stats; showName: boolean }) {
	const rows = s.ages.map((a) => ({ ...a, total: a.female + a.male + a.other }));
	const sum = rows.reduce((n, r) => n + r.total, 0) || 1;
	const top = Math.max(...rows.map((r) => r.total), 1);
	return (
		<div className="panel abox">
			<div className="abox-head">
				<b>Age and gender</b>
				<span className="faint">{showName ? `${s.name} · ` : ''}{s.platform === 'youtube' ? 'share of viewers' : 'share of followers'}</span>
			</div>
			{rows.map((r) => (
				<div className="bar-row" key={r.age} title={`${r.age}: women ${(r.female / (r.total || 1) * 100).toFixed(0)}%, men ${(r.male / (r.total || 1) * 100).toFixed(0)}%`}>
					<span className="bar-name">{r.age.replace(/-$/, '+')}</span>
					<span className="bar-track"><i style={{ width: `${(r.total / top) * 100}%`, background: PLATFORM_COLOR[s.platform] }} /></span>
					<span className="bar-val mono">{pct(r.total / sum)}</span>
					<span className="bar-split faint">F {(r.female / (r.total || 1) * 100).toFixed(0)}% · M {(r.male / (r.total || 1) * 100).toFixed(0)}%</span>
				</div>
			))}
		</div>
	);
}

// ---------- posts and notes ----------

function TopPosts({ list }: { list: Stats[] }) {
	const posts = list.flatMap((s) => s.top.map((p) => ({ ...p, s }))).sort((a, b) => (b.views ?? -1) - (a.views ?? -1)).slice(0, 8);
	if (!posts.length) return null;
	return (
		<div className="panel tops">
			<div className="abox-head" style={{ padding: '14px 18px 6px' }}><b>Top posts</b><span className="faint">by views</span></div>
			<div className="trow head"><span>Post</span><span>Views</span><span>Likes</span><span>Comments</span><span>Shares</span><span /></div>
			{posts.map((p) => (
				<div className="trow" key={`${p.s.accountId}-${p.id}`}>
					<span className="tpost">
						{p.thumbnail ? <img src={p.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="tthumb"><Icon.play /></span>}
						<span className="pmark"><PlatformMark p={p.s.platform} size={11} bare /></span>
						<span className="ellipsis">{p.title || 'Untitled'}</span>
					</span>
					<span className="mono">{fmt(p.views)}</span>
					<span className="mono">{fmt(p.likes)}</span>
					<span className="mono">{fmt(p.comments)}</span>
					<span className="mono">{fmt(p.shares)}</span>
					<span>{p.permalink && <a className="btn sm quiet" href={p.permalink} target="_blank" rel="noreferrer"><Icon.link /></a>}</span>
				</div>
			))}
		</div>
	);
}

function Notes({ list }: { list: Stats[] }) {
	const notes = list.flatMap((s) => s.notes.map((n) => ({ n, s })));
	if (!notes.length) return null;
	return (
		<div className="stats-notes">
			{notes.map(({ n, s }, i) => (
				<div key={i}><Avatar name={s.name} url={s.avatarUrl} size={16} /> <b>{PLATFORM_NAME[s.platform]}</b> {n}</div>
			))}
		</div>
	);
}
