import React from 'react';
import type { Platform, State, Target } from './api';
import { PLATFORM_NAME } from './api';

const P = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
export const Icon = {
	create: () => <svg {...P}><path d="M12 5v14M5 12h14" /></svg>,
	history: () => <svg {...P}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>,
	accounts: () => <svg {...P}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.6 2.6 3 5.2" /></svg>,
	upload: () => <svg {...P} width={22} height={22}><path d="M12 15V4M7 9l5-5 5 5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>,
	play: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>,
	link: () => <svg {...P} width={13} height={13}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>,
	retry: () => <svg {...P} width={13} height={13}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>,
	check: () => <svg {...P} width={13} height={13} strokeWidth={2.4}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
	x: () => <svg {...P} width={13} height={13} strokeWidth={2.2}><path d="M6 6l12 12M18 6L6 18" /></svg>,
	info: () => <svg {...P} width={15} height={15}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" /></svg>,
	out: () => <svg {...P} width={14} height={14}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" /></svg>,
	volume: () => <svg {...P} width={14} height={14}><path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>,
	clock: () => <svg {...P} width={14} height={14}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
	bell: () => <svg {...P} width={14} height={14}><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2 2 0 0 0 4 0" /></svg>,
	bellOff: () => <svg {...P} width={14} height={14}><path d="M8.6 3.8A6 6 0 0 1 18 9c0 2.6.5 4.4 1 5.5M17 16.5H3.5S6 15 6 9c0-.6.1-1.2.3-1.8M10 20a2 2 0 0 0 4 0M3 3l18 18" /></svg>,
	repost: () => <svg {...P} width={13} height={13}><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" /></svg>,
	image: () => <svg {...P} width={18} height={18}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-9 9" /></svg>,
	chart: () => <svg {...P}><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></svg>,
	eye: () => <svg {...P} width={18} height={18}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
	heart: () => <svg {...P} width={18} height={18}><path d="M12 20s-7.5-4.6-9.2-9.2C1.6 7.5 3.8 4.5 7 4.5c2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.2 0 5.4 3 4.2 6.3C19.5 15.4 12 20 12 20z" /></svg>,
	comment: () => <svg {...P} width={18} height={18}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>,
	share: () => <svg {...P} width={18} height={18}><path d="M14 5l7 7-7 7M21 12H9a6 6 0 0 0-6 6v1" /></svg>,
	bookmark: () => <svg {...P} width={18} height={18}><path d="M6 3h12v18l-6-4-6 4z" /></svg>,
	mute: () => <svg {...P} width={14} height={14}><path d="M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6" /></svg>,
};

/** Simple monochrome platform marks (not the official logos). */
export function PlatformMark({ p, size = 22, bare = false }: { p: Platform; size?: number; bare?: boolean }) {
	const s = { width: bare ? size : size * 0.62, height: bare ? size : size * 0.62, viewBox: '0 0 24 24' };
	return (
		<span className={bare ? undefined : 'pmark'} style={bare ? { display: 'grid', placeItems: 'center', width: size, height: size } : { width: size, height: size }} title={PLATFORM_NAME[p]} aria-label={PLATFORM_NAME[p]}>
			{p === 'tiktok' && <svg {...s} fill="currentColor"><path d="M14 3h3c.3 2.3 1.8 3.8 4 4v3c-1.5 0-2.9-.4-4-1.2V15a6 6 0 1 1-6-6v3.2a2.9 2.9 0 1 0 3 2.8z" /></svg>}
			{p === 'instagram' && <svg {...s} fill="none" stroke="currentColor" strokeWidth="2"><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" /></svg>}
			{p === 'youtube' && <svg {...s} fill="currentColor"><path d="M21.6 7.2c-.2-1-1-1.7-2-1.9C17.9 5 12 5 12 5s-5.9 0-7.6.3c-1 .2-1.8.9-2 1.9C2 8.9 2 12 2 12s0 3.1.4 4.8c.2 1 1 1.7 2 1.9 1.7.3 7.6.3 7.6.3s5.9 0 7.6-.3c1-.2 1.8-.9 2-1.9.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8zM10 15V9l5.2 3z" /></svg>}
		</span>
	);
}

export function Avatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
	const [broken, setBroken] = React.useState(false);
	return (
		<span className="avatar" style={{ width: size, height: size }}>
			{url && !broken ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : name.slice(0, 1).toUpperCase()}
		</span>
	);
}

export const STATE_LABEL: Record<State, string> = { queued: 'Queued', uploading: 'Uploading', processing: 'Processing', published: 'Published', failed: 'Failed', needs_attention: 'Needs attention' };
const STATE_TONE: Record<State, string> = { queued: '', uploading: 'amber', processing: 'amber', published: 'green', failed: 'rose', needs_attention: 'amber' };

export function StateChip({ t, demo }: { t: Pick<Target, 'state'>; demo?: boolean }) {
	if (demo && t.state === 'published') return <span className="chip demo">Simulated</span>;
	return (
		<span className={`chip ${STATE_TONE[t.state]}`}>
			{t.state === 'published' ? <Icon.check /> : t.state === 'failed' ? <Icon.x /> : <span className="dot" style={{ background: 'currentColor', opacity: t.state === 'queued' ? 0.5 : 1 }} />}
			{STATE_LABEL[t.state]}
		</span>
	);
}

/** Upload → Processing → Published, with each step's own progress. */
export function Steps({ t }: { t: Target }) {
	const up = t.state === 'uploading' ? t.progress : ['processing', 'published', 'needs_attention'].includes(t.state) || (t.state === 'failed' && t.progress >= 1) ? 1 : t.state === 'failed' ? t.progress : 0;
	const proc = t.state === 'processing' ? -1 : ['published', 'needs_attention'].includes(t.state) ? 1 : 0;
	const pub = t.state === 'published' ? 1 : 0;
	const failTone = t.state === 'failed' ? 'rose' : '';
	return (
		<div className="steps" aria-label="Progress">
			<span><div className={`bar ${up >= 1 ? 'green' : failTone || 'ember'}`}><i style={{ transform: `scaleX(${up})` }} /></div></span>
			<span><div className={`bar ${proc === -1 ? 'indet' : proc === 1 ? 'green' : failTone}`}><i style={{ transform: `scaleX(${proc === 1 ? 1 : 0})` }} /></div></span>
			<span><div className={`bar ${t.state === 'needs_attention' ? 'amber' : 'green'}`}><i style={{ transform: `scaleX(${t.state === 'needs_attention' ? 1 : pub})` }} /></div></span>
		</div>
	);
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
	return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void; label: string }) {
	return (
		<div className="seg" role="radiogroup" aria-label={label}>
			{options.map((o) => (
				<button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} disabled={o.disabled} onClick={() => onChange(o.value)}>
					{o.label}
				</button>
			))}
		</div>
	);
}

export function FieldError({ issues, field }: { issues: { field: string; message: string }[]; field: string | string[] }) {
	const fs = Array.isArray(field) ? field : [field];
	const list = issues.filter((i) => fs.some((f) => i.field === f || i.field.startsWith(`${f}.`)));
	if (!list.length) return null;
	return <>{list.map((i, n) => <div className="err" role="alert" key={n}>{i.message}</div>)}</>;
}
