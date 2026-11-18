import React, { useEffect, useState } from 'react';
import { computer, desktop, openSignIn } from '../desktop';
import { has, api, ApiError, fmtTime, PLATFORM_NAME, type Account, type IgLogin, type Config, type Issue, type Platform, type Setup } from '../api';
import { Avatar, FieldError, Icon, PlatformMark, Seg } from '../ui';
import { GroupsManager } from './GroupsManager';
import { InboxPanel } from './InboxPanel';

type Step = { text: React.ReactNode; link?: [string, string] };

/**
 * Instagram can be connected three ways, depending on what the Meta app offers and what the
 * Facebook account is allowed to do. Each list is the complete set of steps, in order.
 */
const IG_STEPS: Record<IgLogin, Step[]> = {
	facebook: [
		{ text: <>Make each Instagram account <b>Professional</b>: Instagram app → Settings → <b>Account type and tools → Switch to professional account</b> (Creator or Business).</> },
		{ text: <>Link each Instagram account to a <b>Facebook Page</b> you manage. No Page yet? Create one (free, any name). Then on the Page: <b>Settings → Linked accounts → Instagram → Connect</b>.</>, link: ['Create a Page', 'https://www.facebook.com/pages/create'] },
		{ text: <>In your Meta app, open <b>Use cases → Customize → API setup with Facebook login</b> and add these permissions: <b>instagram_basic</b>, <b>instagram_content_publish</b>, <b>instagram_manage_insights</b>, <b>pages_show_list</b>, <b>pages_read_engagement</b>, <b>business_management</b>.</>, link: ['Open My Apps', 'https://developers.facebook.com/apps/'] },
		{ text: <>In the same app, open <b>Facebook Login → Settings</b>, paste the address below into <b>Valid OAuth Redirect URIs</b>, and click <b>Save changes</b>.</> },
		{ text: <>Open <b>App settings → Basic</b>, copy the <b>App ID</b> and <b>App secret</b>, and paste them here.</> },
		{ text: <>Click <b>Save and connect Instagram</b>, log in with Facebook, and tick the Pages of every Instagram account you want. They all connect at once.</> },
	],
	unified: [
		{ text: <>Make each Instagram account <b>Professional</b> (Creator or Business) in the Instagram app’s settings.</> },
		{ text: <>In your Meta app, open <b>Use cases → Customize → API setup with Unified login</b> and click <b>+ Business portfolio</b>. Your Facebook account must be allowed to create portfolios; if Meta says advertising is restricted, use <b>Facebook login</b> above instead.</>, link: ['Open My Apps', 'https://developers.facebook.com/apps/'] },
		{ text: <>Under <b>App roles → Roles</b>, add each Instagram account as an <b>Instagram Tester</b> and accept the invite on Instagram.</>, link: ['Accept invites', 'https://www.instagram.com/accounts/manage_access/'] },
		{ text: <>Create a <b>configuration</b>: token expiry <b>Never</b>; permissions <b>instagram_content_publish</b>, <b>instagram_manage_insights</b>, <b>business_management</b>; <b>Redirect URL</b> = the address below. Copy its <b>Configuration ID</b>.</> },
		{ text: <>Open <b>App settings → Basic</b> and paste the <b>App ID</b>, <b>App secret</b> and <b>Configuration ID</b> here.</> },
		{ text: <>Click <b>Save and connect Instagram</b> and tick every Instagram account you want. They all connect at once.</> },
	],
	instagram: [
		{ text: <>Make each Instagram account <b>Professional</b> (Creator or Business) in the Instagram app’s settings.</> },
		{ text: <>Only for Meta apps that still show <b>API setup with Instagram login</b> (older apps). Under <b>App roles → Roles</b>, add each account as an <b>Instagram Tester</b> and accept the invite.</>, link: ['Accept invites', 'https://www.instagram.com/accounts/manage_access/'] },
		{ text: <>In <b>API setup with Instagram login → Business login settings</b>, add the address below as the OAuth redirect URI.</> },
		{ text: <>Paste the <b>Instagram app ID</b> and <b>Instagram app secret</b> from that page here (not the Facebook ones).</> },
		{ text: <>Click <b>Save and connect Instagram</b>. Add the second account with <b>Add another</b>.</> },
	],
};
const IG_MODES: { value: IgLogin; label: string }[] = [
	{ value: 'facebook', label: 'Facebook login' },
	{ value: 'unified', label: 'Unified login' },
	{ value: 'instagram', label: 'Instagram login (older apps)' },
];

/** What a second account on the same platform needs while the developer app is in testing. */
const ADD_ANOTHER: Record<Platform, string> = {
	youtube: 'Adding another channel: Google shows its account chooser. Each Google account must be a Test user on your consent screen (Audience), unless the app is published. Brand-account channels appear in the chooser under their Google account.',
	instagram: 'Adding another Instagram account: with Facebook login, link it to a Facebook Page you manage, then click Add another and tick that Page. With Unified login, tick it when Meta asks. Every account must be Professional (Creator or Business).',
	tiktok: 'Adding another account: TikTok asks which account to use. While the app is in Sandbox, each account must be added as a target user in your TikTok developer app.',
};

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
			{ text: <>Make each Instagram account <b>Professional</b> (Creator or Business) in the Instagram app’s settings.</> },
			{ text: <>In your Meta app, open <b>Use cases → Customize → API setup with Unified login</b> and click <b>+ Business portfolio</b> to create or pick one (free).</>, link: ['Open My Apps', 'https://developers.facebook.com/apps/'] },
			{ text: <>Under <b>App roles → Roles</b>, add each Instagram account as an <b>Instagram Tester</b> and accept the invite on Instagram.</>, link: ['Accept invites', 'https://www.instagram.com/accounts/manage_access/'] },
			{ text: <>Back in <b>API setup with Unified login</b>, create a <b>configuration</b>: set token expiry to <b>Never</b>, add the permissions <b>instagram_content_publish</b>, <b>instagram_manage_insights</b> and <b>business_management</b>, and paste the address below as its <b>Redirect URL</b>.</> },
			{ text: <>Paste the <b>App ID</b> and <b>App secret</b> (App settings → Basic) and the <b>Configuration ID</b> here.</>, link: ['Open App settings', 'https://developers.facebook.com/apps/'] },
		],
		note: 'Instagram downloads your video from a public HTTPS address, so publishing also needs the public address below. When you sign in, tick every Instagram account you want: all of them connect at once.',
	},
	tiktok: {
		where: 'TikTok for Developers',
		steps: () => [
			{ text: <>Log in with TikTok, then <b>Manage apps → Connect an app</b>. Give it a name (for example "Publisher"); you only need to fill the fields TikTok marks as required.</>, link: ['Open TikTok for Developers', 'https://developers.tiktok.com/apps/'] },
			{ text: <>At the top of the app page switch to <b>Sandbox</b> and create one. A Sandbox works straight away for your own accounts, with no review.</> },
			{ text: <>Click <b>Add products</b> and add <b>Login Kit</b>, <b>Content Posting API</b> and <b>Display API</b>. Under <b>Scopes</b>, make sure <span className="mono">user.info.basic</span>, <span className="mono">user.info.stats</span>, <span className="mono">video.list</span> and <span className="mono">video.upload</span> are ticked.</> },
			{ text: <>In <b>Login Kit</b>, under Web, paste the redirect address below and save.</> },
			{ text: <>In <b>Sandbox settings → Target users</b>, add every TikTok account you want to post to (sign in with each one when TikTok asks).</> },
			{ text: <>Open <b>Credentials</b> on the Sandbox page, copy the <b>Client key</b> and <b>Client secret</b>, paste them here and click <b>Save and connect TikTok</b>.</> },
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
	const [configId, setConfigId] = useState('');
	const [igMode, setIgMode] = useState<IgLogin>(setup.platforms.instagram.loginMode && setup.platforms.instagram.configured ? setup.platforms.instagram.loginMode : 'facebook');
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
			const s = await api.saveKeys(p, { id, secret, ...(p === 'instagram' ? { publicBaseUrl: publicUrl, configId: igMode === 'unified' ? configId : '', loginMode: igMode } : {}) });
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
			{p === 'instagram' && (
				<div className="ig-mode">
					<div className="label">How does your Meta app connect?</div>
					<Seg label="Instagram connection type" value={igMode} onChange={setIgMode} options={IG_MODES} />
					<div className="hint">{igMode === 'facebook' ? 'Works without a Business portfolio. Each Instagram account needs a linked Facebook Page.' : igMode === 'unified' ? 'Meta’s newest setup. Needs a Business portfolio, which some Facebook accounts are not allowed to create.' : 'Only if your Meta app still has “API setup with Instagram login”.'} · {IG_STEPS[igMode].length} steps, about 10 minutes.</div>
				</div>
			)}
			<ol className="guide">
				{(p === 'instagram' ? IG_STEPS[igMode] : g.steps(info)).map((s, i) => (
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
				{p === 'instagram' && igMode === 'unified' && (
					<label className="f">
						<span>Configuration ID (Unified login)</span>
						<input className={`field mono ${issues.some((i) => i.field === 'configId') ? 'bad' : ''}`} value={configId} onChange={(e) => setConfigId(e.target.value)} placeholder={info.configPreview ? `Saved: ${info.configPreview}` : 'From your Unified login configuration'} autoComplete="off" spellCheck={false} />
						<FieldError issues={issues} field="configId" />
					</label>
				)}
				{p === 'instagram' && (
					<label className="f">
						<span>Public address (HTTPS) that reaches this app</span>
						<input className={`field mono ${issues.some((i) => i.field === 'publicBaseUrl') ? 'bad' : ''}`} value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://your-tunnel.trycloudflare.com" autoComplete="off" spellCheck={false} />
						<div className="hint">Your tunnel address (for example from ngrok). Keep the tunnel running whenever you connect or post to Instagram.</div>
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
								<small>{info.configured ? short : (p === 'instagram' ? 'Not set up yet · about 10–15 minutes' : p === 'tiktok' ? 'Not set up yet · about 10 minutes' : 'Not set up yet · about 5 minutes')}</small>
							</div>
							{hosted && devKeys && !open && <button className="btn sm quiet" onClick={() => setEditing(p)}>Own keys</button>}
							{info.configured ? (
								!open && <button className={`btn sm ${real.length ? '' : 'primary'}`} onClick={() => connectPlatform(p)}>{real.length ? 'Add another' : 'Connect'}</button>
							) : (
								<button className={`btn sm ${open || p !== firstUnset ? '' : 'primary'}`} onClick={() => setEditing(open ? null : p)}>{open ? 'Close' : 'Set up'}</button>
							)}
						</div>
						{info.configured && !hosted && real.length > 0 && !open && <div className="hint pad add-hint">{ADD_ANOTHER[p]}</div>}
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
			{has(config, 'groups') && <GroupsManager accounts={accounts} />}
			{has(config, 'inbox') && <InboxPanel />}
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
