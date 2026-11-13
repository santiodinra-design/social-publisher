import React from 'react';
import { PLATFORM_NAME, type Account, type Config, type Issue, type Media, type Verify } from '../api';
import { Icon, PlatformMark } from '../ui';

type Kind = 'ok' | 'stop' | 'info' | 'warn';
type Check = { kind: Kind; text: string; fix?: 'tab' | 'accounts' | 'verify' | 'video' };

export const TIKTOK_INBOX_LABEL = 'Send to TikTok inbox — finish posting in TikTok';

/** Issues for one destination: fields on its tab, its caption, media limits and account problems. */
export const issuesFor = (a: Account, issues: Issue[]) =>
	issues.filter((i) => i.field.startsWith(`${a.platform}.`) || i.field === `caption.${a.platform}` || i.field === `media.${a.platform}` || i.field === `target.${a.id}`);

export function checksFor(a: Account, o: { config: Config; issues: Issue[]; uploadStatus: string; media?: Media; verify?: Verify | 'running' }): Check[] {
	const info = o.config.platforms[a.platform];
	const out: Check[] = [];
	const mine = issuesFor(a, o.issues);
	out.push({ kind: 'ok', text: `Posting as ${a.displayName}${a.handle && a.handle !== a.displayName ? ` (${a.handle})` : ''}` });
	if (a.isDemo) {
		out.push({ kind: 'info', text: 'Demo account: publishing is simulated' });
	} else {
		out.push(info.configured ? { kind: 'ok', text: 'App keys saved' } : { kind: 'stop', text: 'App keys missing', fix: 'accounts' });
		if (!info.available) out.push({ kind: 'stop', text: info.note, fix: 'accounts' });
		if (a.status === 'reconnect_required') out.push({ kind: 'stop', text: 'Sign-in expired: reconnect this account', fix: 'accounts' });
		else if (o.verify === 'running') out.push({ kind: 'info', text: 'Checking connection…' });
		else if (o.verify?.ok) out.push({ kind: 'ok', text: `Connection verified live at ${new Date(o.verify.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` });
		else if (o.verify) out.push({ kind: o.verify.reconnect ? 'stop' : 'warn', text: o.verify.message, fix: o.verify.reconnect ? 'accounts' : 'verify' });
		else out.push({ kind: 'info', text: 'Connection saved, not checked live', fix: 'verify' });
		if (a.platform === 'instagram') out.push(o.config.publicBaseUrl ? { kind: 'ok', text: 'Public video address set' } : o.config.videoHosting ? { kind: 'ok', text: 'Instagram downloads the video from temporary storage' } :{ kind: 'stop', text: 'Public HTTPS address missing (Instagram downloads the video from it)', fix: 'accounts' });
	}
	if (o.uploadStatus === 'uploading') out.push({ kind: 'stop', text: 'Waiting for the video upload to finish' });
	else if (o.uploadStatus !== 'done') out.push({ kind: 'stop', text: 'Add a video', fix: 'video' });
	else {
		const mediaIssues = mine.filter((i) => i.field === `media.${a.platform}`);
		if (mediaIssues.length) mediaIssues.forEach((i) => out.push({ kind: 'stop', text: i.message.replace(`${PLATFORM_NAME[a.platform]}: `, ''), fix: 'tab' }));
		else out.push({ kind: 'ok', text: 'Video passes local checks' });
	}
	const fieldIssues = mine.filter((i) => i.field !== `media.${a.platform}` && !(i.field === `target.${a.id}` && a.status === 'reconnect_required'));
	if (fieldIssues.length) fieldIssues.forEach((i) => out.push({ kind: 'stop', text: i.message, fix: i.field.startsWith('target.') ? 'accounts' : 'tab' }));
	else out.push({ kind: 'ok', text: a.platform === 'youtube' ? 'Title, visibility and audience set' : 'Caption within limits' });
	if (a.platform === 'tiktok') out.push({ kind: 'info', text: info.mode === 'direct' ? 'Direct Post: private (Only me) posts only' : TIKTOK_INBOX_LABEL });
	return out;
}

const MARK: Record<Kind, React.ReactNode> = { ok: <Icon.check />, stop: <Icon.x />, info: <Icon.info />, warn: <Icon.info /> };

export function Readiness(props: {
	chosen: Account[];
	config: Config;
	issues: Issue[];
	uploadStatus: string;
	media?: Media;
	verify: Record<string, Verify | 'running'>;
	onVerify: (a: Account) => void;
	onFix: (a: Account, fix: Check['fix']) => void;
}) {
	const rows = props.chosen.map((a) => ({ a, checks: checksFor(a, { ...props, verify: props.verify[a.id] }) }));
	const blocking = rows.reduce((n, r) => n + r.checks.filter((c) => c.kind === 'stop').length, 0);
	return (
		<div className="ready" aria-label="Publishing readiness">
			<div className="ready-head">
				<span className="dot" style={{ background: blocking ? 'var(--bad)' : 'var(--ok)' }} />
				<b>{blocking ? `${blocking} thing${blocking > 1 ? 's' : ''} to fix` : 'Configuration looks ready'}</b>
				<span className="faint ellipsis">Local checks only, unless marked “verified live”</span>
			</div>
			{rows.map(({ a, checks }) => (
				<div className="ready-row" key={a.id}>
					<span className="pmark" title={PLATFORM_NAME[a.platform]}><PlatformMark p={a.platform} size={13} bare /></span>
					<ul>
						{checks.map((c, i) => (
							<li key={i} className={`rc ${c.kind}`}>
								{MARK[c.kind]}
								<span>{c.text}</span>
								{c.fix === 'verify' && <button type="button" className="linkish" onClick={() => props.onVerify(a)}>Check now</button>}
								{c.kind === 'stop' && c.fix && c.fix !== 'verify' && (
									<button type="button" className="linkish" onClick={() => props.onFix(a, c.fix)}>{c.fix === 'accounts' ? 'Open accounts' : c.fix === 'video' ? 'Choose video' : 'Fix'}</button>
								)}
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}
