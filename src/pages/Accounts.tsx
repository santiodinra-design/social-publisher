import React, { useEffect, useState } from 'react';
import { computer, desktop, openSignIn } from '../desktop';
import { api, ApiError, fmtTime, PLATFORM_NAME, type Account, type Config, type Issue, type Platform, type Setup } from '../api';
import { Avatar, FieldError, Icon, PlatformMark } from '../ui';

type Step = { text: React.ReactNode; link?: [string, string] };

const GUIDE: Record<Platform, { where: string; steps: (s: Setup['platforms'][Platform]) => Step[]; note?: string }> = {
	youtube: {
		where: 'Google Cloud',
		steps: () => [
			{ text: 'Create a project (any name).', link: ['Open Google Cloud', 'https://console.cloud.google.com/projectcreate'] },
			{ text: 'Turn on the YouTube Data API v3 for that project.', link: ['Open the API page', 'https://console.cloud.google.com/apis/library/youtube.googleapis.com'] },
			{ text: <>Set up the consent screen: choose <b>External</b>, then under <b>Audience</b> add your own Google account as a test user.</>, link: ['Open consent setup', 'https://console.cloud.google.com/auth/overview'] },
			desktop
				? { text: <>Create a client of type <b>Desktop app</b>. No redirect address is needed: Google accepts this app's local sign-in address automatically.</>, link: ['Create the client', 'https://console.cloud.google.com/auth/clients/create'] }
				: { text: <>Create a client of type <b>Web application</b> and add the address below as an <b>Authorized redirect URI</b>.</>, link: ['Create the client', 'https://console.cloud.google.com/auth/clients/create'] },
			{ text: 'Paste the Client ID and Client secret here.' },
		],
		note: `While the consent screen is in Testing, Google asks you to reconnect every 7 days. Click "Publish app" under Audience to stop that. Verification is not needed for your own use.${desktop ? ` Google treats a Desktop app client secret as not confidential; it is stored encrypted on this ${computer}, but keep the client for your own use only.` : ''}`,
	},
	instagram: {
		where: 'Meta for Developers',
		steps: () => [
			{ text: <>Switch your Instagram to a <b>Professional</b> account (Business or Creator) in the Instagram app’s settings.</> },
			{ text: <>Create an app and pick the use case <b>Manage messaging & content on Instagram</b>.</>, link: ['Open Meta for Developers', 'https://developers.facebook.com/apps/creation/'] },
			{ text: <>Under <b>App roles → Roles</b>, add your Instagram account as an <b>Instagram Tester</b>, then accept the invite.</>, link: ['Accept the invite', 'https://www.instagram.com/accounts/manage_access/'] },
			{ text: <>In <b>API setup with Instagram login → Business login settings</b>, add the address below as the OAuth redirect URI.</> },
			{ text: <>Paste the <b>Instagram</b> app ID and secret here. These are not the Facebook app ones.</> },
		],
		note: 'Instagram downloads your video from a public HTTPS address, so publishing also needs the public address below.',
	},
	tiktok: {
		where: 'TikTok for Developers',
		steps: () => [
			{ text: 'Create an app.', link: ['Open TikTok for Developers', 'https://developers.tiktok.com/apps/'] },
			{ text: <>Add the <b>Login Kit</b> and <b>Content Posting API</b> products, with the scopes <span className="mono">user.info.basic</span> and <span className="mono">video.upload</span>.</> },
			{ text: <>In Login Kit, add the address below as a redirect URI.</> },
			{ text: 'Paste the Client key and Client secret here.' },
		],
		note: 'TikTok only accepts HTTPS redirect addresses, so a localhost address may be refused. Videos go to your TikTok inbox to finish in the app, because TikTok does not allow public direct posting from personal tools.',
	},
};

function Copy({ text }: { text: string }) {
	const [done, setDone] = useState(false);
	return (
		<div className="copyfield">
			<span className="mono ellipsis grow" title={text}>{text}</span>
			<button
				type="button"
				className="btn sm"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(text);
					} catch {
						const t = document.createElement('textarea');
						t.value = text;
						document.body.appendChild(t);
						t.select();
						document.execCommand('copy');
						t.remove();
					}
					setDone(true);
					setTimeout(() => setDone(false), 1600);
				}}
			>
				{done ? <><Icon.check /> Copied</> : 'Copy'}
			</button>
		</div>
	);
}

function SetupPanel({ p, setup, onSaved, onClose }: { p: Platform; setup: Setup; onSaved: (s: Setup, connect: boolean) => void; onClose?: () => void }) {
	const info = setup.platforms[p];
	const g = GUIDE[p];
	const [id, setId] = useState('');
	const [secret, setSecret] = useState('');
	const [reveal, setReveal] = useState(false);
	const [publicUrl, setPublicUrl] = useState(setup.publicBaseUrl.value ?? '');
	const [issues, setIssues] = useState<Issue[]>([]);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function save(connect: boolean) {
		setBusy(true);
		setErr(null);
		setIssues([]);
		try {
			const s = await api.saveKeys(p, { id, secret, ...(p === 'instagram' ? { publicBaseUrl: publicUrl } : {}) });
			onSaved(s, connect);
		} catch (e: any) {
			setErr(e.message);
			setIssues(e instanceof ApiError ? e.issues : []);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="setup">
			<ol className="guide">
				{g.steps(info).map((s, i) => (
					<li key={i}>
						<span className="num">{i + 1}</span>
						<div className="grow">
							<div>{s.text}</div>
							{s.link && <a className="link" href={s.link[1]} target="_blank" rel="noreferrer">{s.link[0]} ↗</a>}
						</div>
					</li>
				))}
			</ol>
			<div className="setup-form">
				{!(desktop && p === 'youtube') && (
					<label className="f">
						<span>Redirect address. Paste this into {g.where}.</span>
						<Copy text={info.redirectUri} />
					</label>
				)}
				<label className="f">
					<span>{info.idLabel}</span>
					<input className={`field mono ${issues.some((i) => i.field === 'id') ? 'bad' : ''}`} value={id} onChange={(e) => setId(e.target.value)} placeholder={info.idPreview ? `Saved: ${info.idPreview}` : p === 'youtube' ? '1234567890-abc….apps.googleusercontent.com' : ''} autoComplete="off" spellCheck={false} />
					<FieldError issues={issues} field="id" />
				</label>
				<label className="f">
					<span>{info.secretLabel}</span>
					<div className="row" style={{ gap: 6 }}>
						<input className={`field mono ${issues.some((i) => i.field === 'secret') ? 'bad' : ''}`} type={reveal ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={info.hasSecret ? 'Saved. Paste a new one to replace it.' : ''} autoComplete="off" spellCheck={false} />
						<button type="button" className="btn sm" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide' : 'Show'}</button>
					</div>
					<FieldError issues={issues} field="secret" />
				</label>
				{p === 'instagram' && (
					<label className="f">
						<span>Public address (HTTPS) that reaches this app</span>
						<input className={`field mono ${issues.some((i) => i.field === 'publicBaseUrl') ? 'bad' : ''}`} value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://your-tunnel.trycloudflare.com" autoComplete="off" spellCheck={false} />
						<div className="hint">For example run <span className="mono">cloudflared tunnel --url http://localhost:8787</span> and paste the https address it prints. You can add this later.</div>
						<FieldError issues={issues} field="publicBaseUrl" />
					</label>
				)}
				{g.note && <div className="hint">{g.note}</div>}
				{err && !issues.length && <div className="err" role="alert">{err}</div>}
				<div className="row" style={{ gap: 8, marginTop: 2 }}>
					<button className="btn primary" disabled={busy || !id.trim() || !secret.trim()} onClick={() => save(true)}>{busy ? 'Saving…' : `Save and connect ${PLATFORM_NAME[p]}`}</button>
					<button className="btn" disabled={busy || !id.trim() || !secret.trim()} onClick={() => save(false)}>Save only</button>
					{onClose && <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>}
				</div>
				<div className="hint">Keys are stored encrypted on this computer and never shown again in full.</div>
			</div>
		</div>
	);
}

export function AccountsPage({ accounts, config, refresh, refreshConfig }: { accounts: Account[]; config: Config; refresh: () => void; refreshConfig: () => void }) {
	const params = new URLSearchParams(location.search);
	const [banner, setBanner] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(params.get('error') ? { tone: 'bad', text: params.get('error')! } : params.get('connected') ? { tone: 'ok', text: `Connected ${params.get('connected')}.` } : null);
	const [busy, setBusy] = useState<string | null>(null);
	const [setup, setSetup] = useState<Setup | null>(null);
	const [editing, setEditing] = useState<Platform | null>(null);
	// One-click platforms hide developer keys unless the owner asks for them.
	const [devKeys, setDevKeys] = useState(false);
	const anyHosted = (['youtube', 'instagram', 'tiktok'] as Platform[]).some((p) => config.platforms[p].hosted);

	useEffect(() => {
		api.setup().then(setSetup).catch(() => undefined);
	}, []);

	async function disconnect(a: Account) {
		if (!confirm(`Disconnect ${a.displayName}? This app will forget its sign-in. Post history is kept.`)) return;
		setBusy(a.id);
		try {
			await api.disconnect(a.id);
			setBanner({ tone: 'ok', text: `Disconnected ${a.displayName}.` });
			refresh();
		} catch (e: any) {
			setBanner({ tone: 'bad', text: e.message });
		} finally {
			setBusy(null);
		}
	}

	async function removeKeys(p: Platform) {
		if (!confirm(`Remove the saved ${PLATFORM_NAME[p]} keys? Connected accounts stay connected, but new sign-ins will need keys again.`)) return;
		setSetup(await api.removeKeys(p));
		refreshConfig();
	}

	async function connectPlatform(p: Platform) {
		try {
			const { url } = await api.beginOAuth(p);
			await openSignIn(url);
			if (desktop) setBanner({ tone: 'ok', text: `Finish signing in to ${PLATFORM_NAME[p]} in your browser, then come back here. The account appears automatically.` });
		} catch (e: any) {
			setBanner({ tone: 'bad', text: e.message });
		}
	}

	// Sign-in finishes in the system browser; refresh when the window regains focus.
	useEffect(() => {
		const on = () => refresh();
		addEventListener('focus', on);
		return () => removeEventListener('focus', on);
	}, []);

	function saved(p: Platform, s: Setup, connect: boolean) {
		setSetup(s);
		setEditing(null);
		refreshConfig();
		if (connect) connectPlatform(p);
		else setBanner({ tone: 'ok', text: `${PLATFORM_NAME[p]} keys saved. Click Connect when you are ready.` });
	}

	return (
		<>
			{banner && (
				<div className={`notice ${banner.tone === 'bad' ? 'bad' : ''}`} role="status" style={{ marginBottom: 14 }}>
					{banner.tone === 'ok' ? <Icon.check /> : <Icon.info />}
					<span className="grow">{banner.text}</span>
					<button className="btn sm" onClick={() => (setBanner(null), history.replaceState(null, '', '/accounts'))}>Dismiss</button>
				</div>
			)}
			{config.demoMode && (
				<div className="notice demo" style={{ marginBottom: 14 }}>
					<Icon.info />
					<span className="grow">Demo mode: demo accounts simulate publishing and never post.</span>
					{!accounts.some((x) => x.isDemo) && <button className="btn sm" onClick={async () => (await api.addDemoAccounts(), refresh())}>Add demo accounts</button>}
				</div>
			)}
			{(['youtube', 'instagram', 'tiktok'] as Platform[]).map((p, _i, all) => {
				const firstUnset = all.find((x) => !config.platforms[x].configured);
				const info = config.platforms[p];
				const s = setup?.platforms[p];
				const list = accounts.filter((a) => a.platform === p && a.status !== 'disconnected');
				const real = list.filter((a) => !a.isDemo);
				const open = editing === p;
				const short = p === 'youtube' ? 'Videos and Shorts' : p === 'instagram' ? (info.available || !info.configured ? 'Reels on a Professional account' : 'Needs a public address to publish') : 'Sends to your TikTok drafts';
				const hosted = Boolean(info.hosted);
				return (
					<div className="panel plat" key={p}>
						<div className="plat-head">
							<span className="pmark"><PlatformMark p={p} size={18} bare /></span>
							<div className="t grow">
								<b>{PLATFORM_NAME[p]}</b>
								<small>{info.configured ? short : 'Not set up yet · about 5 minutes'}</small>
							</div>
							{hosted && devKeys && !open && <button className="btn sm quiet" onClick={() => setEditing(p)}>Own keys</button>}
							{info.configured ? (
								!open && <button className={`btn sm ${real.length ? '' : 'primary'}`} onClick={() => connectPlatform(p)}>{real.length ? 'Add another' : 'Connect'}</button>
							) : (
								<button className={`btn sm ${open || p !== firstUnset ? '' : 'primary'}`} onClick={() => setEditing(open ? null : p)}>{open ? 'Close' : 'Set up'}</button>
							)}
						</div>
						{p === 'instagram' && hosted && !real.length && !open && <div className="hint pad" style={{ paddingTop: 0 }}>Needs an Instagram Professional account (Business or Creator). You can switch for free in the Instagram app’s settings.</div>}
						{info.configured && !hosted && !open && s && (
							<div className="keyline">
								<span className="dot" style={{ background: 'var(--ok)' }} />
								<span className="grow ellipsis">App keys {s.source === 'env' ? 'from .env' : 'saved'} · <span className="mono">{s.idPreview}</span></span>
								<button className="btn sm quiet" onClick={() => setEditing(p)}>Change</button>
								{s.source === 'app' && <button className="btn sm quiet danger" onClick={() => removeKeys(p)}>Remove</button>}
							</div>
						)}
						{p === 'instagram' && info.configured && !info.available && !open && setup && <PublicUrl setup={setup} onSaved={(x) => (setSetup(x), refreshConfig())} />}
						{open && setup && <SetupPanel p={p} setup={setup} onSaved={(x, c) => saved(p, x, c)} onClose={() => setEditing(null)} />}
						{list.map((a) => (
							<div className="acct" key={a.id}>
								<Avatar name={a.displayName} url={a.avatarUrl} size={32} />
								<div className="grow" style={{ minWidth: 0 }}>
									<div className="row" style={{ gap: 6 }}>
										<span style={{ fontWeight: 600 }} className="ellipsis">{a.displayName}</span>
										{a.handle && <span className="faint hide-sm">{a.handle}</span>}
										{a.isDemo && <span className="chip demo">Demo</span>}
									</div>
									<div className="row faint" style={{ fontSize: 12, gap: 6 }}>
										<span className="dot" style={{ background: a.status === 'connected' ? 'var(--ok)' : 'var(--bad)', width: 6, height: 6 }} />
										{a.status === 'connected' ? `Connected ${fmtTime(a.connectedAt)}` : a.statusDetail ?? 'Needs reconnecting'}
									</div>
								</div>
								{!a.isDemo && info.configured && a.status !== 'connected' && <button className="btn sm primary" onClick={() => connectPlatform(p)}><Icon.retry /> Reconnect</button>}
								<button className="btn sm quiet danger" disabled={busy === a.id} onClick={() => disconnect(a)}>Disconnect</button>
							</div>
						))}
					</div>
				);
			})}
			<p className="faint" style={{ fontSize: 12 }}>
				{anyHosted
					? <>Accounts connect through each platform’s official sign-in page. This app never sees your passwords, and sign-in tokens stay encrypted on this {computer}.</>
					: 'Accounts connect through each platform’s official sign-in page. This app never sees your passwords. Keys and sign-in tokens are encrypted on the server and never sent to the browser.'}
				{anyHosted && <> <button className="btn sm quiet" style={{ fontSize: 12 }} onClick={() => setDevKeys(!devKeys)}>{devKeys ? 'Hide developer keys' : 'Use my own developer keys'}</button></>}
			</p>
		</>
	);
}

function PublicUrl({ setup, onSaved }: { setup: Setup; onSaved: (s: Setup) => void }) {
	const [v, setV] = useState(setup.publicBaseUrl.value ?? '');
	const [err, setErr] = useState<string | null>(null);
	return (
		<div className="pad" style={{ borderTop: '1px solid var(--border)' }}>
			<label className="f">
				<span>Public address (HTTPS) so Instagram can download your videos</span>
				<div className="row" style={{ gap: 6 }}>
					<input className={`field mono ${err ? 'bad' : ''}`} value={v} onChange={(e) => setV(e.target.value)} placeholder="https://your-tunnel.trycloudflare.com" />
					<button className="btn sm" onClick={async () => { try { setErr(null); onSaved(await api.savePublicUrl(v)); } catch (e: any) { setErr(e.message); } }}>Save</button>
				</div>
				{err ? <div className="err">{err}</div> : <div className="hint">Run <span className="mono">cloudflared tunnel --url http://localhost:8787</span> and paste the https address it prints.</div>}
			</label>
		</div>
	);
}
