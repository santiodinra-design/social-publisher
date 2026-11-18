import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api, has, type Account, type Config, type Post, type Status } from './api';
import { computer, desktop, logsHint, onWindows } from './desktop';
import { Icon } from './ui';
import { enableSounds, sounds } from './sounds';

// The desktop apps (Mac and Windows) click like Ethereal Enchantment, with a Sounds on/off button.
// In a plain browser (npm run dev) the page stays silent.
if (desktop) enableSounds();

/** Windows app: whether finished posts show a notification. Kept by the app, not the browser. */
function NotifyToggle() {
	const [on, setOn] = useState<boolean | null>(null);
	useEffect(() => void api.prefs().then((p) => setOn(p.notifications)).catch(() => undefined), []);
	if (on === null) return null;
	return (
		<button className="ghost-link" aria-pressed={on} title={on ? 'A notification appears when a post finishes (click to turn off)' : 'Notifications are off (click to turn on)'} onClick={async () => setOn((await api.setPrefs({ notifications: !on })).notifications)}>
			{on ? <Icon.bell /> : <Icon.bellOff />} <span>{on ? 'Notifications on' : 'Notifications off'}</span>
		</button>
	);
}

/** Drafts only: YouTube goes up Private and TikTok to the inbox, so nothing goes public by itself. */
function DraftsToggle({ on, changed }: { on: boolean; changed: () => void }) {
	return (
		<button className={`ghost-link ${on ? 'drafts-on' : ''}`} aria-pressed={on} title={on ? 'Drafts only: TikTok goes to your inbox and Instagram is skipped. YouTube uses the visibility you choose (click to allow Instagram)' : 'Instagram allowed (click to switch back to drafts only)'} onClick={async () => (await api.setPrefs({ draftsOnly: !on }), changed())}>
			<Icon.check /> <span>{on ? 'Drafts only' : 'Public allowed'}</span>
		</button>
	);
}

function SoundToggle() {
	const [, redraw] = useState(0);
	useEffect(() => sounds.subscribe(() => redraw((n) => n + 1)), []);
	if (!sounds.available) return null;
	return (
		<button className="ghost-link" data-sfx={sounds.on ? 'toggleOff' : 'none'} aria-pressed={sounds.on} title={sounds.on ? 'Sounds on (click to mute)' : 'Sounds off (click to turn on)'} onClick={() => sounds.set(!sounds.on)}>
			{sounds.on ? <Icon.volume /> : <Icon.mute />} <span>{sounds.on ? 'Sounds on' : 'Sounds off'}</span>
		</button>
	);
}
import { CreatePage } from './pages/Create';
import { HistoryPage } from './pages/History';
import { AccountsPage } from './pages/Accounts';
import { StatsPage } from './pages/Stats';

const PAGES = {
	'/': { title: 'Create post', sub: 'One video, every platform.', icon: Icon.create },
	'/history': { title: 'Post history', sub: 'Where every post stands.', icon: Icon.history },
	'/stats': { title: 'Stats', sub: 'Followers, views and where your audience is.', icon: Icon.chart },
	'/accounts': { title: 'Connected accounts', sub: 'Official sign-in only. Your passwords never touch this app.', icon: Icon.accounts },
} as const;
type Path = keyof typeof PAGES;

function App() {
	const [path, setPath] = useState<Path>(() => (location.pathname in PAGES ? (location.pathname as Path) : '/'));
	const [session, setSession] = useState<{ signedIn: boolean; demoMode: boolean; noSignIn?: boolean; desktop?: boolean } | null>(null);
	const [config, setConfig] = useState<Config | null>(null);
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [posts, setPosts] = useState<Post[] | null>(null);
	const [offline, setOffline] = useState(false);
	const [status, setStatus] = useState<Status | null>(null);

	const go = useCallback((p: string) => {
		const next = (p in PAGES ? p : '/') as Path;
		history.pushState(null, '', next);
		setPath(next);
	}, []);
	useEffect(() => {
		const on = () => setPath((location.pathname in PAGES ? location.pathname : '/') as Path);
		addEventListener('popstate', on);
		return () => removeEventListener('popstate', on);
	}, []);

	const load = useCallback(async () => {
		const [c, a, p] = await Promise.all([api.config(), api.accounts(), api.posts()]);
		setConfig(c);
		setAccounts(a);
		setPosts(p);
	}, []);
	const refreshPosts = useCallback(() => api.posts().then(setPosts).catch(() => undefined), []);
	const refreshAccounts = useCallback(() => api.accounts().then(setAccounts).catch(() => undefined), []);

	useEffect(() => {
		api.session()
			.then((s) => {
				setSession(s);
				if (s.signedIn) load().catch(() => setOffline(true));
			})
			.catch(() => setOffline(true));
	}, []);

	// Worker health comes from the worker's own heartbeat (it writes one every 10 s).
	useEffect(() => {
		if (!session?.signedIn) return;
		let lastActive = -1;
		const poll = () =>
			api
				.status()
				.then((s) => {
					setStatus(s);
					if (s.activeJobs !== lastActive) (lastActive = s.activeJobs), refreshPosts();
				})
				.catch(() => setStatus(null));
		poll();
		const t = setInterval(poll, 10_000);
		return () => clearInterval(t);
	}, [session?.signedIn]);

	if (offline)
		return (
			<div className="login">
				<div className="panel pad" style={{ maxWidth: 380 }}>
					<b>Can’t reach the Publisher server</b>
					<p className="muted" style={{ margin: '6px 0 14px' }}>Start it with <span className="mono">npm run dev</span>, then reload this page.</p>
					<button className="btn sm" onClick={() => location.reload()}>Reload</button>
				</div>
			</div>
		);
	if (!session) return null;
	if (!session.signedIn) return <Login onDone={() => (setSession({ ...session, signedIn: true }), load())} />;

	const page = PAGES[path];
	const live = accounts.filter((a) => a.status !== 'disconnected');
	const attention = (posts ?? []).filter((p) => p.targets.some((t) => t.state === 'failed' || t.state === 'needs_attention')).length;
	// Count from the server's live status; fall back to the loaded posts before the first poll.
	const inFlight = status ? status.activeJobs : (posts ?? []).filter((p) => !p.done).length;
	const reconnect = live.filter((a) => a.status === 'reconnect_required').length;

	return (
		<div className="shell">
			<nav className="rail" aria-label="Main">
				<div className="brand">
					<span className="brand-mark"><Icon.play /></span>
					<div>
						<b>Publisher</b>
						<small>{live.length ? `${live.length} account${live.length === 1 ? '' : 's'}` : 'No accounts yet'}</small>
					</div>
				</div>
				{(Object.keys(PAGES) as Path[]).filter((p) => p !== '/stats' || has(config, 'analytics')).map((p) => {
					const P = PAGES[p];
					const count = p === '/history' ? (inFlight || attention) : p === '/accounts' ? reconnect : 0;
					return (
						<a key={p} href={p} className={`nav ${path === p ? 'on' : ''}`} aria-current={path === p ? 'page' : undefined} onClick={(e) => (e.preventDefault(), go(p))}>
							<P.icon />
							<span className="label-long">{P.title}</span>
							{count > 0 && <span className={`count ${(p === '/accounts' || (!inFlight && attention)) ? 'warn' : ''}`}>{count}</span>}
						</a>
					);
				})}
				<div className="rail-foot">
					{config?.demoMode && <span className="chip demo hide-sm" style={{ justifySelf: 'start', marginLeft: 6 }}>Demo mode</span>}
					{session.noSignIn && <span className="chip warn signin-off" title="Password protection is off (NO_SIGN_IN=true). Only this computer can open the app. Turn sign-in back on before sharing or tunnelling it.">Sign-in off · local only</span>}
					<WorkerStatus status={status} inFlight={inFlight} desktop={Boolean(session.desktop)} />
					<SoundToggle />
					{has(config, 'draftsOnly') && <DraftsToggle on={config?.draftsOnly !== false} changed={() => api.config().then(setConfig).catch(() => undefined)} />}
					{has(config, 'notifications') && <NotifyToggle />}
					{!session.noSignIn && !session.desktop && <button className="ghost-link" aria-label="Sign out" onClick={async () => (await api.signOut(), location.reload())}><Icon.out /> <span>Sign out</span></button>}
				</div>
			</nav>
			<main className="main">
				<div className="page">
					<header className="topbar">
						<h1>{page.title}</h1>
						<span className="sub hide-sm">{page.sub}</span>
					</header>
					{!config ? (
						<div className="panel empty">Loading…</div>
					) : path === '/' ? (
						<CreatePage accounts={accounts} config={config} go={go} onPublished={() => (refreshPosts(), refreshAccounts())} />
					) : path === '/stats' && has(config, 'analytics') ? (
						<StatsPage accounts={accounts} go={go} />
					) : path === '/history' ? (
						<HistoryPage posts={posts} refresh={refreshPosts} go={go} canRepost={has(config, 'repost')} />
					) : (
						<AccountsPage accounts={accounts} config={config} refresh={refreshAccounts} refreshConfig={() => api.config().then(setConfig).catch(() => undefined)} />
					)}
				</div>
			</main>
		</div>
	);
}

function Login({ onDone }: { onDone: () => void }) {
	const [pw, setPw] = useState('');
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<div className="login">
			<form
				className="panel"
				onSubmit={async (e) => {
					e.preventDefault();
					setBusy(true);
					setErr(null);
					try {
						await api.signIn(pw);
						onDone();
					} catch (x: any) {
						setErr(x.message);
					} finally {
						setBusy(false);
					}
				}}
			>
				<div className="brand" style={{ padding: '0 0 18px' }}>
					<span className="brand-mark"><Icon.play /></span>
					<div><b>Publisher</b><small>Sign in to continue</small></div>
				</div>
				<label className="f"><span>Password</span><input className={`field ${err ? 'bad' : ''}`} type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
				{err && <div className="err" role="alert">{err}</div>}
				<button className="btn primary" style={{ width: '100%', marginTop: 14 }} disabled={busy || !pw}>{busy ? 'Signing in…' : 'Sign in'}</button>
			</form>
		</div>
	);
}

// Reuse one root across hot reloads in development.
const host = document.getElementById('root')! as HTMLElement & { _root?: ReturnType<typeof createRoot> };
host._root ??= createRoot(host);
host._root.render(<App />);

function ago(ms: number) {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

/** Shows whether the background worker has checked in recently, not merely whether the web server answers. */
function WorkerStatus({ status, inFlight, desktop }: { status: Status | null; inFlight: number; desktop: boolean }) {
	const w = status?.worker;
	const state = !status ? 'unknown' : w!.state;
	const since = w?.lastSeenAt && status ? ago(status.now - w.lastSeenAt) : null;
	const label = state === 'running' ? (inFlight ? `${inFlight} publishing` : 'Worker running') : state === 'stale' ? 'Worker not responding' : state === 'never' ? 'Worker not started' : 'Status unknown';
	const tip =
		state === 'running'
			? desktop
				? `Backend and worker are running (worker checked in ${since} ago). Jobs continue with the window closed, but stop while Publisher is quit or the ${computer} is asleep; they resume on next launch.`
				: `Background worker checked in ${since} ago. Jobs keep going with this tab closed, as long as this computer and the app stay running.`
			: state === 'stale'
				? `The background worker last checked in ${since} ago. Queued posts wait until it runs again. ${desktop ? `Publisher restarts it automatically; if this persists, quit and reopen the app (${logsHint}).` : 'Restart the app with npm run dev.'}`
				: state === 'never'
					? `The background worker has never checked in. ${desktop ? 'Quit and reopen Publisher.' : 'Start the app with npm run dev.'} Posts wait until it runs.`
					: `The backend is not responding, so worker status is unknown.${desktop ? ' Publisher restarts it automatically.' : ''}`;
	return (
		<div className={`live ${state === 'running' ? (inFlight ? 'busy' : '') : 'down'}`} title={tip} role="status" aria-label={`${label}. ${tip}`}>
			<span className="dot" />
			<span className="lbl">{label}</span>
		</div>
	);
}
