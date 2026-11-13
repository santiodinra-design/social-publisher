import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError, fmtBytes, fmtDur, has, PLATFORM_NAME, uploadVideo, type Account, type Config, type Issue, type Media, type Platform, type Post, type Verify } from '../api';
import { Avatar, FieldError, Icon, PlatformMark, Seg, Toggle } from '../ui';
import { clearDraft, loadDraft, saveDraft, takeRepost } from '../draft';
import { issuesFor, Readiness, TIKTOK_INBOX_LABEL } from './Readiness';
import { PublishStatus } from './Results';
import { desktop } from '../desktop';

type Settings = Record<string, any>;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function defaults(p: Platform, filename: string): Settings {
	const base = { overrideOn: false, captionOverride: '' };
	if (p === 'tiktok') return { ...base, mode: 'inbox', privacy: 'SELF_ONLY', allowComments: true, allowDuet: false, allowStitch: false };
	if (p === 'instagram') return { ...base, shareToFeed: true, thumbSec: '' };
	return { ...base, title: filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 100), description: '', privacy: '', madeForKids: null, categoryId: '22' };
}

/** A <input type="datetime-local"> value for a time, in this computer's time zone. */
export const toLocalInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
/** The cover a published destination used, for Post again. */
const coverOf = (s: Settings) => (s.coverId ? { coverId: String(s.coverId), coverUrl: `/api/covers/${s.coverId}` } : {});
const nextHalfHour = () => Math.ceil((Date.now() + 15 * 60_000) / 1_800_000) * 1_800_000;

const PREVIEW_LABEL: Record<Platform, string> = { tiktok: 'TikTok', instagram: 'Reels', youtube: 'Shorts' };

export function CreatePage({ accounts, config, go, onPublished }: { accounts: Account[]; config: Config; go: (p: string) => void; onPublished: () => void }) {
	const usable = accounts.filter((a) => a.status !== 'disconnected');
	const [file, setFile] = useState<File | null>(null);
	const [preview, setPreview] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const [upload, setUpload] = useState<{ progress: number; status: 'idle' | 'restoring' | 'uploading' | 'done' | 'error'; media?: Media; error?: string }>({ progress: 0, status: 'idle' });
	const abortRef = useRef<() => void>(() => {});
	const [selected, setSelected] = useState<string[]>([]);
	const [caption, setCaption] = useState('');
	const [settings, setSettings] = useState<Record<string, Settings>>({});
	const [tab, setTab] = useState<string | null>(null);
	const [previewAs, setPreviewAs] = useState<Platform>('instagram');
	const [serverIssues, setIssues] = useState<Issue[]>([]);
	const [attempted, setAttempted] = useState(false);
	const [notice, setNotice] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
	const [verify, setVerify] = useState<Record<string, Verify | 'running'>>({});
	const hydrated = useRef(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [key, setKey] = useState(newKey);
	const canSchedule = has(config, 'schedule');
	const canCover = has(config, 'covers');
	const [scheduleOn, setScheduleOn] = useState(false);
	const [when, setWhen] = useState(() => toLocalInput(nextHalfHour()));
	const whenMs = new Date(when).getTime();
	const [post, setPost] = useState<Post | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const chosen = usable.filter((a) => selected.includes(a.id));
	const mixDemo = chosen.some((a) => a.isDemo) && chosen.some((a) => !a.isDemo);
	const anyDemo = chosen.some((a) => a.isDemo);
	const locked = Boolean(post);
	const media = upload.media;
	const filename = file?.name ?? media?.filename ?? '';
	const activeTab = chosen.find((a) => a.id === tab) ?? chosen[0];
	const revoke = (u: string | null) => u?.startsWith('blob:') && URL.revokeObjectURL(u);

	useEffect(() => () => void revoke(preview), [preview]);

	// "Post again" from Post history: copy that post into the form. Nothing is submitted.
	function repost(p: Post) {
		const ok = new Set(usable.map((a) => a.id));
		const picked = p.targets.filter((t) => t.accountId && ok.has(t.accountId));
		const form: Record<string, Settings> = {};
		for (const t of picked) {
			const s = t.settings ?? {};
			const own = String(s.captionOverride ?? '');
			if (t.platform === 'tiktok') form[t.accountId!] = { ...defaults('tiktok', p.media.filename), overrideOn: Boolean(own.trim()), captionOverride: own, mode: s.mode ?? 'inbox', privacy: s.privacy ?? 'SELF_ONLY', allowComments: s.allowComments ?? true, allowDuet: s.allowDuet ?? false, allowStitch: s.allowStitch ?? false };
			else if (t.platform === 'instagram') form[t.accountId!] = { ...defaults('instagram', p.media.filename), overrideOn: Boolean(own.trim()), captionOverride: own, shareToFeed: s.shareToFeed !== false, ...coverOf(s), thumbSec: s.thumbOffsetMs == null ? '' : String(Number(s.thumbOffsetMs) / 1000) };
			else form[t.accountId!] = { ...defaults('youtube', p.media.filename), title: String(s.title ?? ''), titleTouched: true, description: s.description && s.description !== p.caption ? String(s.description) : '', privacy: s.privacy ?? '', madeForKids: typeof s.madeForKids === 'boolean' ? s.madeForKids : null, categoryId: String(s.categoryId ?? '22'), ...coverOf(s) };
		}
		setCaption(p.caption);
		setSelected(picked.map((t) => t.accountId!));
		setSettings(form);
		setTab(picked[0]?.accountId ?? null);
		if (picked[0]) setPreviewAs(picked[0].platform);
		setKey(newKey());
		const when = new Date(p.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
		const missing = p.targets.length - picked.length;
		const left = missing ? ` ${missing} destination${missing > 1 ? 's are' : ' is'} no longer connected, so ${missing > 1 ? 'they were' : 'it was'} left out.` : '';
		if (!p.media.id || p.media.deleted) {
			setUpload({ progress: 0, status: 'idle' });
			return setNotice({ tone: 'warn', text: `Copied your post from ${when}. Its video was cleaned up after the retention period, so add the video again.${left}` });
		}
		setUpload({ progress: 0, status: 'restoring' });
		api
			.media(p.media.id)
			.then((m) => {
				setUpload({ progress: 1, status: 'done', media: m });
				setPreview(m.previewUrl ?? null);
				setNotice({ tone: 'info', text: `Copied your post from ${when}, with the same video. Change anything you like, then publish.${left}` });
			})
			.catch(() => {
				setUpload({ progress: 0, status: 'idle' });
				setNotice({ tone: 'warn', text: `Copied your post from ${when}. Its video is no longer on this computer, so add it again.${left}` });
			});
	}

	// Restore a saved draft once. It only fills the form: nothing is submitted.
	useEffect(() => {
		const again = takeRepost();
		if (again) {
			hydrated.current = true;
			api.post(again).then(repost).catch(() => setNotice({ tone: 'warn', text: 'That post could not be loaded.' }));
			return;
		}
		const d = loadDraft();
		hydrated.current = true;
		if (!d) return;
		const ok = new Set(usable.map((a) => a.id));
		setCaption(d.caption);
		setSelected(d.selected.filter((id) => ok.has(id)));
		setSettings(d.settings as Record<string, Settings>);
		setTab(d.tab);
		setPreviewAs(d.previewAs);
		setKey(d.key);
		const when = new Date(d.savedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
		if (!d.mediaId) return setNotice({ tone: 'info', text: `Draft restored from ${when}.` });
		setUpload({ progress: 0, status: 'restoring' });
		api
			.media(d.mediaId)
			.then((m) => {
				setUpload({ progress: 1, status: 'done', media: m });
				setPreview(m.previewUrl ?? null);
				setNotice({ tone: 'info', text: `Draft restored from ${when}.` });
			})
			.catch(() => {
				setUpload({ progress: 0, status: 'idle' });
				setNotice({ tone: 'warn', text: 'The video in your draft is no longer on this computer. Your caption and settings are kept; upload the video again.' });
			});
	}, []);

	// Save the draft shortly after each change (text, choices and the server media ID only).
	useEffect(() => {
		if (!hydrated.current || post || upload.status === 'restoring') return;
		const t = setTimeout(() => saveDraft({ caption, selected, settings, tab, previewAs, mediaId: upload.media?.id ?? null, key }), 400);
		return () => clearTimeout(t);
	}, [caption, selected, settings, tab, previewAs, upload.media?.id, key, post, upload.status]);

	useEffect(() => {
		if (!post || post.done) return;
		const t = setInterval(async () => {
			try {
				const p = await api.post(post.id);
				setPost(p);
				if (p.done) onPublished();
			} catch {}
		}, 1200);
		return () => clearInterval(t);
	}, [post?.id, post?.done]);

	function pick(f: File | undefined | null) {
		if (!f) return;
		if (!f.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v)$/i.test(f.name)) {
			setUpload({ progress: 0, status: 'error', error: 'Only video files can be published (MP4, MOV or WebM).' });
			return;
		}
		abortRef.current();
		revoke(preview);
		setNotice(null);
		setFile(f);
		setPreview(URL.createObjectURL(f));
		setIssues([]);
		setFormError(null);
		setPost(null);
		setKey(newKey());
		setSettings((s) => Object.fromEntries(Object.entries(s).map(([id, v]) => [id, v.title !== undefined && !v.titleTouched ? { ...v, title: defaults('youtube', f.name).title } : v])));
		setUpload({ progress: 0, status: 'uploading' });
		const u = uploadVideo(f, (p) => setUpload((s) => ({ ...s, progress: p })));
		abortRef.current = u.abort;
		u.promise.then((m) => setUpload({ progress: 1, status: 'done', media: m })).catch((e: ApiError) => setUpload({ progress: 0, status: 'error', error: e.message }));
	}

	/** In the desktop app, use the native macOS picker; the main process streams the file to the local server. */
	async function chooseFile() {
		if (!desktop) return inputRef.current?.click();
		if (upload.status === 'uploading' || locked) return;
		abortRef.current();
		const before = upload;
		setUpload({ progress: 0, status: 'uploading' });
		const r = await desktop.pickVideo((p) => setUpload((s) => (s.status === 'uploading' ? { ...s, progress: p } : s)));
		if (r.canceled) return setUpload(before);
		if ('error' in r) return setUpload({ progress: 0, status: 'error', error: r.error });
		revoke(preview);
		setNotice(null);
		setFile(null);
		setPreview(r.media.previewUrl ?? null);
		setIssues([]);
		setFormError(null);
		setPost(null);
		setKey(newKey());
		setSettings((s) => Object.fromEntries(Object.entries(s).map(([id, v]) => [id, v.title !== undefined && !v.titleTouched ? { ...v, title: defaults('youtube', r.filename).title } : v])));
		setUpload({ progress: 1, status: 'done', media: r.media });
	}

	function toggle(a: Account) {
		const on = selected.includes(a.id);
		setSelected((s) => (on ? s.filter((x) => x !== a.id) : [...s, a.id]));
		setSettings((s) => (s[a.id] ? s : { ...s, [a.id]: defaults(a.platform, filename) }));
		if (!on) {
			setTab(a.id);
			setPreviewAs(a.platform);
		}
		setIssues((is) => is.filter((i) => !i.field.startsWith('targets')));
	}
	const set = (id: string, patch: Settings) => setSettings((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

	function clientIssues(): Issue[] {
		const out: Issue[] = [];
		if (upload.status !== 'done') out.push({ field: 'media', message: upload.status === 'uploading' ? 'Wait for the upload to finish.' : upload.status === 'restoring' ? 'Finding the video from your draft…' : 'Add a video first.' });
		if (!chosen.length) out.push({ field: 'targets', message: 'Choose at least one destination.' });
		if (mixDemo) out.push({ field: 'targets', message: 'Demo and real accounts cannot be in the same post.' });
		if (scheduleOn && !(whenMs > Date.now() + 60_000 && whenMs < Date.now() + 60 * 86_400_000)) out.push({ field: 'scheduledAt', message: 'Pick a time at least a minute from now and within 60 days.' });
		for (const a of chosen) {
			const s = settings[a.id] ?? {};
			const cap = s.overrideOn && s.captionOverride.trim() ? s.captionOverride : caption;
			if (a.platform !== 'youtube' && cap.length > 2200) out.push({ field: `caption.${a.platform}`, message: `${PLATFORM_NAME[a.platform]} captions are limited to 2,200 characters.` });
			if (a.status === 'reconnect_required') out.push({ field: `account.${a.id}`, message: `Reconnect ${a.displayName} in Connected accounts first.` });
			if (!a.isDemo) {
				const info = config.platforms[a.platform];
				if (!info.configured) out.push({ field: `account.${a.id}`, message: `Add ${PLATFORM_NAME[a.platform]} app keys in Connected accounts.` });
				else if (!info.available) out.push({ field: `account.${a.id}`, message: info.note });
				if (a.platform === 'instagram' && !config.publicBaseUrl && !config.videoHosting) out.push({ field: `account.${a.id}`, message: 'Set a public HTTPS address in Connected accounts so Instagram can download the video.' });
			}
			if (a.platform === 'youtube') {
				if (!String(s.title ?? '').trim()) out.push({ field: 'youtube.title', message: 'Add a title.' });
				if (!s.privacy) out.push({ field: 'youtube.privacy', message: 'Choose who can see it.' });
				if (typeof s.madeForKids !== 'boolean') out.push({ field: 'youtube.madeForKids', message: 'YouTube requires an answer.' });
			}
			for (const m of upload.media?.issues[a.platform] ?? []) out.push({ field: `media.${a.platform}`, message: `${PLATFORM_NAME[a.platform]}: ${m}` });
		}
		return out;
	}

	// Live checks: platform fields show their problems straight away; "add a video" and
	// "choose a destination" only after a publish attempt, so an empty form is not shouted at.
	const live = locked ? [] : clientIssues();
	const quiet = (i: Issue) => !attempted && (i.field === 'media' || (i.field === 'targets' && !mixDemo));
	const issues = [...live.filter((i) => !quiet(i)), ...serverIssues.filter((s) => !live.some((l) => l.field === s.field && l.message === s.message))];
	const platformHasIssue = (a: Account) => issuesFor(a, issues).length > 0;
	const blocking = live.length;

	async function checkConnection(a: Account) {
		setVerify((v) => ({ ...v, [a.id]: 'running' }));
		try {
			const r = await api.verify(a.id);
			setVerify((v) => ({ ...v, [a.id]: r }));
			if (r.reconnect) onPublished();
		} catch (e: any) {
			setVerify((v) => ({ ...v, [a.id]: { ok: false, checkedAt: Date.now(), message: e.message } }));
		}
	}

	async function publish() {
		if (busy) return;
		const local = clientIssues();
		setAttempted(true);
		setFormError(null);
		const firstBad = chosen.find((a) => issuesFor(a, local).length);
		if (firstBad) setTab(firstBad.id);
		if (local.length) return;
		setBusy(true);
		try {
			const r = await api.publish({
				idempotencyKey: key,
				mediaId: upload.media!.id,
				caption,
				...(scheduleOn ? { scheduledAt: whenMs } : {}),
				targets: chosen.map((a) => {
					const s = settings[a.id];
					const common = { captionOverride: s.overrideOn ? s.captionOverride : '' };
					if (a.platform === 'tiktok') return { accountId: a.id, settings: { ...common, mode: s.mode, privacy: s.privacy, allowComments: s.allowComments, allowDuet: s.allowDuet, allowStitch: s.allowStitch } };
					const cover = canCover && s.coverId ? { coverId: s.coverId } : {};
					if (a.platform === 'instagram') return { accountId: a.id, settings: { ...common, ...cover, shareToFeed: s.shareToFeed, thumbOffsetMs: s.thumbSec === '' ? null : Math.round(Number(s.thumbSec) * 1000) } };
					return { accountId: a.id, settings: { ...cover, title: s.title, description: s.description || caption, privacy: s.privacy, madeForKids: s.madeForKids, categoryId: s.categoryId } };
				}),
			});
			setPost(r.post);
			setFormError(null);
			clearDraft();
			setNotice(r.duplicate ? { tone: 'info', text: 'This draft was already published, so here is that post. Nothing was posted a second time.' } : null);
			onPublished();
		} catch (e: any) {
			setFormError(e.message);
			setIssues(e instanceof ApiError ? e.issues : []);
		} finally {
			setBusy(false);
		}
	}

	function reset() {
		abortRef.current();
		revoke(preview);
		setFile(null);
		setPreview(null);
		setUpload({ progress: 0, status: 'idle' });
		setCaption('');
		setIssues([]);
		setAttempted(false);
		setPost(null);
		setFormError(null);
		setNotice(null);
		setKey(newKey());
		setScheduleOn(false);
	}

	function discard() {
		clearDraft();
		reset();
		setSelected([]);
		setSettings({});
		setVerify({});
	}
	const hasDraft = !post && Boolean(caption.trim() || media || selected.length);

	// What the phone shows: the caption (or override) the way the chosen platform would.
	const previewPlatforms = chosen.length ? Array.from(new Set(chosen.map((a) => a.platform))) : (['instagram', 'tiktok', 'youtube'] as Platform[]);
	const shownAs = previewPlatforms.includes(previewAs) ? previewAs : previewPlatforms[0];
	const previewAccount = chosen.find((a) => a.platform === shownAs) ?? usable.find((a) => a.platform === shownAs);
	const ps = previewAccount ? settings[previewAccount.id] : undefined;
	const previewCaption = shownAs === 'youtube' ? caption : ps?.overrideOn && ps.captionOverride.trim() ? ps.captionOverride : caption;

	return (
		<div className="create">
			{/* ---------------- stage: the post as followers will see it ---------------- */}
			<section className="stage" aria-label="Preview">
				<Seg label="Preview as" value={shownAs} onChange={(v) => setPreviewAs(v as Platform)} options={previewPlatforms.map((p) => ({ value: p, label: PREVIEW_LABEL[p] }))} />
				<div
					className={`phone ${dragOver ? 'over' : ''}`}
					onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
					onDragLeave={() => setDragOver(false)}
					onDrop={(e) => (e.preventDefault(), setDragOver(false), !locked && pick(e.dataTransfer.files[0]))}
				>
					<div className="screen">
						{upload.status !== 'idle' && (
							<div className={`upbar ${upload.status === 'done' ? 'done' : ''}`} role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(upload.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
								<i style={{ transform: `scaleX(${upload.progress})` }} />
							</div>
						)}
						{preview ? (
							<>
								<video src={preview} autoPlay muted loop playsInline preload="metadata" />
								<div className="overlay" aria-hidden>
									<span className="tag">{PREVIEW_LABEL[shownAs]}</span>
									<div className="side"><i /><i /><i /></div>
									{shownAs === 'youtube' && ps?.title && <div className="title ellipsis">{ps.title}</div>}
									<div className="who"><Avatar name={previewAccount?.displayName ?? 'You'} url={previewAccount?.avatarUrl} size={22} />{previewAccount?.handle ?? previewAccount?.displayName ?? '@you'}</div>
									<div className={`cap ${previewCaption ? '' : 'empty'}`}>{previewCaption || 'Your caption appears here'}</div>
								</div>
							</>
						) : (
							<div className="drop" role="button" tabIndex={0} onClick={() => chooseFile()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && chooseFile()}>
								<div>
									<div className="ico"><Icon.upload /></div>
									<h2>Drop your video</h2>
									<p>MP4, MOV or WebM.<br />Vertical 9:16 fits everywhere.</p>
									<span className="btn sm">Choose file</span>
								</div>
							</div>
						)}
					</div>
				</div>
				<input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v" hidden onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} />
				{(file || media) && (
					<div className="stage-meta">
						<span className="chip ellipsis" style={{ maxWidth: 200 }} title={filename}>{filename}</span>
						<span className="chip mono">{fmtDur(media?.duration ?? null)}</span>
						<span className="chip mono">{fmtBytes(file?.size ?? media?.size ?? 0)}</span>
						{media?.width && <span className="chip mono">{media.width}×{media.height}</span>}
						{media?.shortsShape && <span className="chip ember">Shorts-ready</span>}
						{upload.status === 'uploading' && <span className="chip amber">Uploading {Math.round(upload.progress * 100)}%</span>}
					</div>
				)}
				{upload.status === 'restoring' && <span className="chip">Finding your draft's video…</span>}
				{(file || media) && !locked && (
					<div className="row" style={{ gap: 6 }}>
						<button className="btn sm" onClick={() => chooseFile()}>Replace</button>
						{upload.status === 'uploading' && <button className="btn sm quiet" onClick={() => abortRef.current()}>Cancel upload</button>}
					</div>
				)}
				{upload.status === 'error' && <div className="notice bad" role="alert" style={{ maxWidth: 320 }}>{upload.error}</div>}
				<FieldError issues={issues} field="media" />
			</section>

			{/* ---------------- composer ---------------- */}
			<section className="stack" style={{ gap: 14 }}>
				{notice && (
					<div className={`notice ${notice.tone === 'warn' ? 'warn' : ''} compact`} role="status">
						<Icon.info /><span className="grow">{notice.text}</span>
						<button className="btn sm quiet" onClick={() => setNotice(null)} aria-label="Dismiss">OK</button>
					</div>
				)}
				{post && <PublishStatus post={post} onUpdate={setPost} onNew={reset} go={go} />}

				<div className="panel composer">
					<div className="block">
						<div className="block-head">
							<h3>Post to</h3>
							{anyDemo && <span className="chip demo">Demo · simulated</span>}
							<span className="grow" />
							{usable.length > 0 && <button className="btn sm quiet" onClick={() => go('/accounts')}>Manage</button>}
						</div>
						{usable.length === 0 ? (
							<div className="row" style={{ justifyContent: 'space-between' }}>
								<span className="muted">No accounts connected yet.</span>
								<button className="btn sm primary" onClick={() => go('/accounts')}>Connect an account</button>
							</div>
						) : (
							<div className="dests" role="group" aria-label="Destinations">
								{usable.map((a) => {
									const info = config.platforms[a.platform];
									const on = selected.includes(a.id);
									const blocked = !a.isDemo && (!info.available || a.status === 'reconnect_required');
									const sub = a.status === 'reconnect_required' ? 'Reconnect needed' : a.isDemo ? 'Demo' : !info.available ? 'Unavailable' : a.platform === 'tiktok' ? 'To TikTok inbox' : a.platform === 'instagram' ? 'Reel' : 'Video or Short';
									return (
										<button key={a.id} type="button" className={`dest ${on ? 'on' : ''} ${blocked ? 'warn' : ''}`} aria-pressed={on} disabled={locked || (blocked && !on)} onClick={() => toggle(a)} title={blocked ? info.note : undefined}>
											<Avatar name={a.displayName} url={a.avatarUrl} size={30} />
											<span className="badge"><PlatformMark p={a.platform} size={11} bare /></span>
											<span className="who"><b>{a.displayName}</b><small>{sub}</small></span>
											<span className="check"><Icon.check /></span>
										</button>
									);
								})}
							</div>
						)}
						<FieldError issues={issues} field="targets" />
						{chosen.map((a) => <FieldError key={a.id} issues={issues} field={[`target.${a.id}`, `account.${a.id}`]} />)}
					</div>

					<div className="block">
						<textarea className="caption" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Write a caption…" disabled={locked} aria-label="Caption" />
						<div className="caption-foot">
							<span className="faint" style={{ fontSize: 11.5 }}>Shared by every destination</span>
							<span className="grow" />
							<span className="counter">{(caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length} hashtags</span>
							<span className={`counter ${caption.length > 2200 ? 'over' : ''}`}>{caption.length.toLocaleString()}/2,200</span>
						</div>
						<FieldError issues={issues} field="caption" />
					</div>

					{chosen.length > 0 && activeTab && (
						<div className="block">
							<div className="ptabs" role="tablist" aria-label="Platform settings">
								{chosen.map((a) => (
									<button key={a.id} role="tab" aria-selected={activeTab.id === a.id} className={`ptab ${activeTab.id === a.id ? 'on' : ''}`} onClick={() => (setTab(a.id), setPreviewAs(a.platform))}>
										<PlatformMark p={a.platform} size={14} bare />
										{PLATFORM_NAME[a.platform]}
										{platformHasIssue(a) && <span className="flag" aria-label="Needs attention" />}
									</button>
								))}
							</div>
							<PlatformFields a={activeTab} s={settings[activeTab.id] ?? defaults(activeTab.platform, filename)} set={(p) => set(activeTab.id, p)} issues={issues} info={config.platforms[activeTab.platform]} caption={caption} media={media} locked={locked} canCover={canCover} />
						</div>
					)}

					{!post && chosen.length > 0 && (
						<div className="block">
							<Readiness
								chosen={chosen}
								config={config}
								issues={live}
								uploadStatus={upload.status}
								media={media}
								verify={verify}
								onVerify={checkConnection}
								onFix={(a, fix) => (fix === 'accounts' ? go('/accounts') : fix === 'video' ? chooseFile() : (setTab(a.id), setPreviewAs(a.platform)))}
							/>
						</div>
					)}

					{!post && (
						<div className="foot">
							<div className="summary grow">
								{formError ? (
									<span className="err" role="alert" style={{ marginTop: 0 }}>{formError}</span>
								) : !chosen.length ? (
									<span className="faint">Pick at least one destination</span>
								) : blocking ? (
									<span className={attempted ? 'err' : 'faint'} style={{ marginTop: 0 }}>{blocking === 1 ? live[0].message : `${blocking} things to fix first`}</span>
								) : (
									<>
										{chosen.map((a) => <span key={a.id} className="pmark" title={a.displayName}><PlatformMark p={a.platform} size={13} bare /></span>)}
										<span className="faint" style={{ marginLeft: 4 }}>{chosen.length} destination{chosen.length > 1 ? 's' : ''} ready</span>
									</>
								)}
								{hasDraft && <span className="draft-tag">Draft saved<button type="button" className="linkish" onClick={discard}>Discard draft</button></span>}
							</div>
							{canSchedule && (
								<div className="schedule">
									<button type="button" className={`btn sm ${scheduleOn ? 'on' : 'quiet'}`} aria-pressed={scheduleOn} onClick={() => setScheduleOn(!scheduleOn)} title="Publish later, at a time you pick">
										<Icon.clock /> {scheduleOn ? 'Scheduled' : 'Schedule'}
									</button>
									{scheduleOn && <input className={`field mono ${issues.some((i) => i.field === 'scheduledAt') ? 'bad' : ''}`} type="datetime-local" value={when} min={toLocalInput(Date.now() + 2 * 60_000)} onChange={(e) => setWhen(e.target.value)} aria-label="Publish at" />}
								</div>
							)}
							<button className="btn primary big" data-sfx="launch" onClick={publish} disabled={busy || blocking > 0} aria-busy={busy} title={blocking ? 'Fix the items in the checklist first' : undefined}>
								{scheduleOn ? <Icon.clock /> : <Icon.play />} {busy ? 'Starting…' : scheduleOn ? (anyDemo ? 'Schedule (simulated)' : 'Schedule') : anyDemo ? 'Publish (simulated)' : 'Publish'}
							</button>
						</div>
					)}
				</div>
			</section>
		</div>
	);
}

function PlatformFields({ a, s, set, issues, info, caption, media, locked, canCover = false }: { a: Account; s: Settings; set: (p: Settings) => void; issues: Issue[]; info: Config['platforms'][Platform]; caption: string; media?: Media; locked: boolean; canCover?: boolean }) {
	return (
		<div className="fields" role="tabpanel">
			<FieldError issues={issues} field={`media.${a.platform}`} />
			{a.platform !== 'youtube' && (
				<div>
					<div className="line-toggle">
						<span>Custom caption<small>Use a different caption on {PLATFORM_NAME[a.platform]} only</small></span>
						<Toggle on={s.overrideOn} onChange={(v) => set({ overrideOn: v, captionOverride: v && !s.captionOverride ? caption : s.captionOverride })} disabled={locked} label={`Custom ${PLATFORM_NAME[a.platform]} caption`} />
					</div>
					{s.overrideOn && (
						<>
							<textarea className="field" style={{ marginTop: 10, minHeight: 72 }} value={s.captionOverride} onChange={(e) => set({ captionOverride: e.target.value })} disabled={locked} aria-label={`${PLATFORM_NAME[a.platform]} caption`} />
							<div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}><span className={`counter ${s.captionOverride.length > 2200 ? 'over' : ''}`}>{s.captionOverride.length}/2,200</span></div>
						</>
					)}
					<FieldError issues={issues} field={`caption.${a.platform}`} />
				</div>
			)}

			{a.platform === 'tiktok' && (
				<div>
					<div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
						<span className="chip ember">{s.mode === 'direct' ? 'Direct Post (private only)' : TIKTOK_INBOX_LABEL}</span>
					</div>
					<details className="why" style={{ marginTop: 8 }}>
						<summary>Why not post directly?</summary>
						<p>TikTok only lets audited apps post publicly, and it does not audit personal tools that post to your own accounts. Sending it to your TikTok inbox is the supported way: TikTok notifies you, and you add sounds or effects and post it from the app. Nothing is public until you do.</p>
					</details>
					{canCover && <div className="hint">TikTok lets you pick the cover when you finish the draft in the TikTok app.</div>}
					{info.mode === 'direct' && !a.isDemo && (
						<div style={{ marginTop: 12 }}>
							<Seg label="TikTok mode" value={s.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'inbox', label: 'Inbox' }, { value: 'direct', label: 'Direct (private only)', disabled: locked }]} />
						</div>
					)}
				</div>
			)}

			{a.platform === 'instagram' && (
				<>
					<div className="line-toggle">
						<span>Show in profile grid<small>Off keeps it in the Reels tab only</small></span>
						<Toggle on={s.shareToFeed} onChange={(v) => set({ shareToFeed: v })} disabled={locked} label="Share Reel to feed" />
					</div>
					<label className="f" style={{ maxWidth: 220 }}>
						<span>Cover frame</span>
						<div className="row" style={{ gap: 6 }}>
							<input className="field" inputMode="decimal" placeholder="Auto" value={s.thumbSec} onChange={(e) => set({ thumbSec: e.target.value.replace(/[^\d.]/g, '') })} disabled={locked} />
							<span className="faint">sec</span>
						</div>
						<FieldError issues={issues} field="instagram.thumb" />
					</label>
					{canCover && <CoverPicker label="Cover image" hint="JPEG. Replaces the cover frame above." s={s} set={set} locked={locked} accept="image/jpeg" issues={issues} field="instagram.cover" />}
					{!info.available && !a.isDemo && <div className="notice warn"><Icon.info /><span>{info.note}</span></div>}
				</>
			)}

			{a.platform === 'youtube' && (
				<>
					<label className="f">
						<span>Title</span>
						<input className={`field ${issues.some((i) => i.field === 'youtube.title') ? 'bad' : ''}`} value={s.title} maxLength={110} onChange={(e) => set({ title: e.target.value, titleTouched: true })} disabled={locked} />
						<div className="row"><FieldError issues={issues} field="youtube.title" /><span className="grow" /><span className={`counter ${s.title.length > 100 ? 'over' : ''}`} style={{ marginTop: 5 }}>{s.title.length}/100</span></div>
					</label>
					<label className="f">
						<span>Description</span>
						<textarea className="field" style={{ minHeight: 64 }} placeholder="Uses your caption if left empty" value={s.description} onChange={(e) => set({ description: e.target.value })} disabled={locked} />
						<FieldError issues={issues} field="youtube.description" />
					</label>
					<div className="grid2">
						<div>
							<div className="label" style={{ marginBottom: 6 }}>Visibility</div>
							<Seg label="YouTube visibility" value={s.privacy} onChange={(v) => set({ privacy: v })} options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'private', label: 'Private' }].map((o) => ({ ...o, disabled: locked }))} />
							<FieldError issues={issues} field="youtube.privacy" />
						</div>
						<div>
							<div className="label" style={{ marginBottom: 6 }}>Made for kids</div>
							<Seg label="Made for kids" value={s.madeForKids === null ? '' : s.madeForKids ? 'yes' : 'no'} onChange={(v) => set({ madeForKids: v === 'yes' })} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }].map((o) => ({ ...o, disabled: locked }))} />
							<FieldError issues={issues} field="youtube.madeForKids" />
						</div>
					</div>
					{canCover && <CoverPicker label="Thumbnail" hint="JPEG or PNG, up to 2 MB, 1280×720 works best. Needs a verified YouTube channel; otherwise YouTube keeps its own." s={s} set={set} locked={locked} accept="image/jpeg,image/png" issues={issues} field="youtube.cover" />}
					<div className="hint" style={{ marginTop: 0 }}>{media ? (media.shortsShape ? 'Vertical and 3 minutes or less, so this posts as a Short.' : 'This posts as a regular video. Shorts must be vertical or square and up to 3 minutes.') : 'Vertical videos up to 3 minutes post as Shorts.'}</div>
				</>
			)}
		</div>
	);
}

/** Chooses a cover image for one destination. The image is saved by the app straight away. */
function CoverPicker({ label, hint, s, set, locked, accept, issues, field }: { label: string; hint: string; s: Settings; set: (p: Settings) => void; locked: boolean; accept: string; issues: Issue[]; field: string }) {
	const ref = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	async function choose(f?: File | null) {
		if (!f) return;
		setBusy(true);
		setErr(null);
		try {
			const c = await api.uploadCover(f);
			set({ coverId: c.id, coverUrl: c.url });
		} catch (e: any) {
			setErr(e.message);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="f">
			<span>{label}</span>
			<div className="cover-pick">
				{s.coverUrl ? <img src={s.coverUrl} alt="" /> : <span className="cover-empty"><Icon.image /></span>}
				<div className="stack" style={{ gap: 6 }}>
					<div className="row" style={{ gap: 6 }}>
						<button type="button" className="btn sm" disabled={locked || busy} onClick={() => ref.current?.click()}>{busy ? 'Saving…' : s.coverId ? 'Replace' : 'Choose image'}</button>
						{s.coverId && <button type="button" className="btn sm quiet" disabled={locked || busy} onClick={() => set({ coverId: '', coverUrl: '' })}>Remove</button>}
					</div>
					<span className="hint" style={{ margin: 0 }}>{hint}</span>
				</div>
			</div>
			<input ref={ref} type="file" accept={accept} hidden onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ''))} />
			{err && <div className="err" role="alert">{err}</div>}
			<FieldError issues={issues} field={field} />
		</div>
	);
}
