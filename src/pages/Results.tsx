import React, { useState } from 'react';
import { api, fmtTime, PLATFORM_NAME, type Post, type Target } from '../api';
import { computer } from '../desktop';
import { Icon, PlatformMark, Steps } from '../ui';
import { toLocalInput } from './Create';

type Tone = 'ok' | 'wait' | 'bad' | 'busy' | 'idle' | 'sim';
export type Action = 'open' | 'check' | 'retry' | 'reconnect' | 'reupload' | 'posted' | null;
export type Described = { label: string; tone: Tone; explain: string; action: Action };

const WHERE: Record<Target['platform'], string> = { youtube: 'YouTube Studio → Content', instagram: 'your Instagram profile', tiktok: 'your TikTok inbox' };

/** Turns a destination's raw state into one accurate status, a plain explanation and one safe next step. */
export function describe(t: Target, demo: boolean, mediaDeleted = false): Described {
	const name = PLATFORM_NAME[t.platform];
	const waitS = t.nextRunAt && t.nextRunAt > Date.now() ? Math.max(1, Math.round((t.nextRunAt - Date.now()) / 1000)) : 0;
	switch (t.state) {
		case 'queued':
			if (t.scheduled && t.nextRunAt) return { label: 'Scheduled', tone: 'idle', explain: `Goes out ${fmtTime(t.nextRunAt)}. Publisher must be running then; it can stay in the notification area.`, action: null };
			if (t.outcomeUnknown) return { label: 'Checking', tone: 'wait', explain: `Last attempt ended without a clear answer. Asking ${name} what happened before doing anything else${waitS ? ` (in ${waitS} s)` : ''}.`, action: null };
			if (t.attempts > 0) return { label: 'Retrying', tone: 'wait', explain: `${t.error ?? 'Temporary problem'}. Trying again automatically${waitS ? ` in ${waitS} s` : ''}.`, action: null };
			return { label: 'Queued', tone: 'idle', explain: 'Waiting for the background worker to pick this up.', action: null };
		case 'uploading':
			return { label: `Uploading ${Math.round(t.progress * 100)}%`, tone: 'busy', explain: `Sending the video to ${name}.`, action: null };
		case 'processing':
			return { label: 'Processing', tone: 'busy', explain: `${name} accepted the upload and is processing it. Not live yet.`, action: null };
		case 'published':
			if (demo) return { label: 'Simulated', tone: 'sim', explain: 'Demo account. Nothing was posted.', action: null };
			return {
				label: 'Published',
				tone: 'ok',
				explain: t.permalink ? `${name} confirmed it is published.` : `${name} confirmed it is published but gave no public link (private posts have none).`,
				action: t.permalink ? 'open' : null,
			};
		case 'needs_attention': {
			const err = t.error ?? '';
			if (t.platform === 'tiktok' && /TikTok inbox/i.test(err) && !t.outcomeUnknown)
				return { label: demo ? 'Simulated · inbox' : 'Finish in TikTok', tone: demo ? 'sim' : 'wait', explain: demo ? 'Simulated. A real post would wait in your TikTok inbox.' : `Sent to your TikTok inbox. TikTok drafts can't carry a caption, so Publisher copied it: open the draft in TikTok, paste it, and post.${t.canMarkPosted ? ' Then click I posted it.' : ''}`, action: t.canMarkPosted ? 'posted' : null };
			if (t.accountStatus === 'reconnect_required' || /^Reconnect /.test(err))
				return { label: 'Reconnect needed', tone: 'wait', explain: t.outcomeUnknown ? `Sign-in expired before ${name} confirmed the result. Reconnect, then use Check again. Nothing will be uploaded twice.` : err, action: 'reconnect' };
			if (t.outcomeUnknown) return { label: 'Outcome unknown', tone: 'wait', explain: err || `Check ${WHERE[t.platform]} before posting again.`, action: 'check' };
			return { label: 'Needs you', tone: 'wait', explain: err, action: null };
		}
		case 'failed':
			return { label: 'Failed', tone: 'bad', explain: t.error ?? 'Failed.', action: mediaDeleted ? 'reupload' : 'retry' };
	}
}

const TONE_VAR: Record<Tone, string> = { ok: 'var(--ok)', wait: 'var(--wait)', bad: 'var(--bad)', busy: 'var(--ember)', idle: 'var(--ink-3)', sim: 'var(--sim)' };
export const toneColor = (t: Tone) => TONE_VAR[t];

/** The caption to paste into a TikTok draft: its own caption if set, otherwise the post's. */
const tiktokCaption = (t: Target, caption = '') => String(t.settings?.captionOverride ?? '').trim() || caption.trim();

function CopyCaption({ text }: { text: string }) {
	const [done, setDone] = useState(false);
	return (
		<button className="btn sm" title="TikTok drafts can't carry a caption. Copy it, then paste it in the TikTok draft." onClick={async () => {
			await navigator.clipboard.writeText(text).catch(() => undefined);
			setDone(true);
			setTimeout(() => setDone(false), 1800);
		}}>
			{done ? <><Icon.check /> Copied</> : 'Copy caption'}
		</button>
	);
}

export function TargetRow({ t, demo, mediaDeleted, busy, onAction, caption }: { t: Target; demo: boolean; mediaDeleted?: boolean; busy?: boolean; onAction?: (a: Action, t: Target) => void; caption?: string }) {
	const d = describe(t, demo, mediaDeleted);
	const paste = t.platform === 'tiktok' && t.state === 'needs_attention' && !demo ? tiktokCaption(t, caption) : '';
	const active = ['uploading', 'processing'].includes(t.state);
	return (
		<div className="result" data-tone={d.tone}>
			<span className="pmark" style={{ width: 28, height: 28, borderRadius: 8 }}><PlatformMark p={t.platform} size={15} bare /></span>
			<div style={{ minWidth: 0 }}>
				<div className="row" style={{ gap: 8 }}>
					<b className="ellipsis">{t.account.name}</b>
					<span className="rstate"><span className="dot" style={{ background: TONE_VAR[d.tone] }} />{d.label}</span>
				</div>
				{active && <Steps t={t} />}
				<div className="rexplain">{d.explain}</div>
			</div>
			<div className="ract">
				{d.action === 'open' && t.permalink && <a className="btn sm" href={t.permalink} target="_blank" rel="noreferrer"><Icon.link /> Open post</a>}
				{d.action === 'check' && onAction && <button className="btn sm" disabled={busy} onClick={() => onAction('check', t)} title="Only asks the platform for the result. Never uploads a second copy."><Icon.retry /> Check again</button>}
				{d.action === 'retry' && onAction && <button className="btn sm" disabled={busy} onClick={() => onAction('retry', t)}><Icon.retry /> Retry</button>}
				{d.action === 'reconnect' && onAction && <button className="btn sm" onClick={() => onAction('reconnect', t)}>Reconnect</button>}
				{paste && <CopyCaption text={paste} />}
				{d.action === 'posted' && onAction && <button className="btn sm" data-sfx="pop" disabled={busy} onClick={() => onAction('posted', t)} title="You finished this draft in the TikTok app"><Icon.check /> I posted it</button>}
				{d.action === 'reupload' && <span className="faint" style={{ fontSize: 12 }}>Video cleaned up · upload again</span>}
			</div>
		</div>
	);
}

/** Result panel shown after Publish: one row per destination, plus clearly separate next steps. */
export function PublishStatus({ post, onUpdate, onNew, go }: { post: Post; onUpdate: (p: Post) => void; onNew?: () => void; go: (p: string) => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const failed = post.targets.filter((t) => t.state === 'failed' && !t.outcomeUnknown);
	const ds = post.targets.map((t) => describe(t, post.isDemo, post.media.deleted));
	const live = ds.filter((d) => d.tone === 'ok').length;
	const needs = ds.filter((d) => d.tone === 'wait' && !['Checking', 'Retrying'].includes(d.label)).length;
	const headline = post.scheduled && post.scheduledAt ? `Scheduled for ${fmtTime(post.scheduledAt)}` : !post.done ? 'Publishing' : post.isDemo ? 'Simulation finished' : failed.length ? 'Finished with problems' : needs ? 'Done, with a step left' : 'All published';

	async function act(a: Action, t?: Target) {
		if (a === 'reconnect') return go('/accounts');
		const link = a === 'posted' ? askLink() : '';
		if (link === null) return;
		setBusy(true);
		setError(null);
		try {
			if (a === 'posted' && t) return onUpdate((await api.markPosted(t.id, link)).post);
			const ids = t ? [t.id] : failed.map((f) => f.id);
			onUpdate((await api.retry(post.id, ids)).post);
		} catch (e: any) {
			setError(e.message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="panel results">
			<div className="status-head">
				<span className="dot" style={{ background: !post.done ? 'var(--ember)' : failed.length ? 'var(--bad)' : needs ? 'var(--wait)' : 'var(--ok)', width: 8, height: 8 }} />
				<b>{headline}</b>
				{post.isDemo && <span className="chip demo">Simulated</span>}
				<span className="faint grow ellipsis">{post.scheduled ? 'Nothing is sent before then' : !post.done ? 'Keeps going with the window closed' : post.isDemo ? 'Nothing was actually posted' : `${live} of ${post.targets.length} confirmed live`}</span>
			</div>
			{post.targets.map((t) => <TargetRow key={t.id} t={t} demo={post.isDemo} mediaDeleted={post.media.deleted} busy={busy} onAction={act} caption={post.caption} />)}
			{post.scheduled && <ScheduleActions post={post} onUpdate={onUpdate} />}
			{error && <div className="err" role="alert" style={{ padding: '0 18px 10px' }}>{error}</div>}
			{(post.done || !onNew) && (
				<div className="results-foot">
					{failed.length > 0 && post.done && !post.media.deleted && (
						<button className="btn sm" disabled={busy} onClick={() => act('retry')}><Icon.retry /> Retry failed destination{failed.length > 1 ? 's' : ''}</button>
					)}
					<span className="grow" />
					{onNew && post.done && <button className="btn sm primary" onClick={onNew}>Create another post</button>}
				</div>
			)}
			{!post.done && !post.scheduled && <div className="hint" style={{ padding: '0 18px 12px', marginTop: 0 }}>You can close this window. Jobs keep going while Publisher runs, pause while it is quit or the {computer} sleeps, and resume on the next launch.</div>}
		</div>
	);
}

/** Publish now, move or cancel a post that is still waiting for its time. */
export function ScheduleActions({ post, onUpdate }: { post: Post; onUpdate: (p: Post) => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [when, setWhen] = useState(() => toLocalInput(post.scheduledAt ?? Date.now() + 3_600_000));
	async function run(f: () => Promise<{ post: Post }>) {
		setBusy(true);
		setError(null);
		try {
			onUpdate((await f()).post);
			setEditing(false);
		} catch (e: any) {
			setError(e.message);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="results-foot" style={{ flexWrap: 'wrap' }}>
			{editing ? (
				<>
					<input className="field mono" type="datetime-local" value={when} min={toLocalInput(Date.now() + 2 * 60_000)} onChange={(e) => setWhen(e.target.value)} aria-label="New time" style={{ maxWidth: 220 }} />
					<button className="btn sm primary" disabled={busy} onClick={() => run(() => api.schedule(post.id, new Date(when).getTime()))}>Save time</button>
					<button className="btn sm quiet" disabled={busy} onClick={() => setEditing(false)}>Keep the old time</button>
				</>
			) : (
				<>
					<button className="btn sm" disabled={busy} data-sfx="launch" onClick={() => run(() => api.schedule(post.id, null))}><Icon.play /> Publish now</button>
					<button className="btn sm" disabled={busy} onClick={() => setEditing(true)}><Icon.clock /> Change time</button>
					<span className="grow" />
					<button className="btn sm quiet danger" disabled={busy} onClick={() => confirm('Cancel this scheduled post? Nothing has been sent yet. You can still retry it later.') && run(() => api.cancelSchedule(post.id))}>Cancel schedule</button>
				</>
			)}
			{error && <div className="err" role="alert" style={{ width: '100%' }}>{error}</div>}
		</div>
	);
}

/** Asks for the TikTok link after the owner posted a draft by hand. Null when they cancel. */
export function askLink(): string | null {
	return prompt('Posted it in TikTok? Paste the link to the post so it opens from here (optional).', '');
}
