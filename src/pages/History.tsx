import React, { useEffect, useState } from 'react';
import { api, fmtDur, fmtTime, PLATFORM_NAME, type Post, type Target } from '../api';
import { Icon, PlatformMark } from '../ui';
import { queueRepost } from '../draft';
import { askLink, describe, ScheduleActions, TargetRow, toneColor, type Action } from './Results';

export function HistoryPage({ posts, refresh, go, canRepost = false }: { posts: Post[] | null; refresh: () => void; go: (p: string) => void; canRepost?: boolean }) {
	const [open, setOpen] = useState<string | null>(null);
	const [retrying, setRetrying] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!posts?.some((p) => !p.done && !p.scheduled)) return;
		const t = setInterval(refresh, 1500);
		return () => clearInterval(t);
	}, [posts]);

	if (!posts) return <div className="panel empty">Loading…</div>;
	if (!posts.length)
		return (
			<div className="panel empty">
				<b>Nothing published yet</b>
				Your posts and their status on each platform will show up here.
				<div style={{ marginTop: 16 }}><button className="btn sm primary" onClick={() => go('/')}>Create a post</button></div>
			</div>
		);

	async function retry(p: Post, only?: Target) {
		setRetrying(p.id);
		setError(null);
		try {
			await api.retry(p.id, only ? [only.id] : p.targets.filter((t) => t.state === 'failed' && !t.outcomeUnknown).map((t) => t.id));
			refresh();
		} catch (e: any) {
			setError(e.message);
		} finally {
			setRetrying(null);
		}
	}

	async function markPosted(t: Target) {
		const link = askLink();
		if (link === null) return;
		setError(null);
		try {
			await api.markPosted(t.id, link);
			refresh();
		} catch (e: any) {
			setError(e.message);
		}
	}

	return (
		<>
			{error && <div className="notice bad" style={{ marginBottom: 12 }}>{error}</div>}
			<div className="panel hlist" role="list">
				{posts.map((p) => {
					const failed = p.targets.filter((t) => t.state === 'failed' && !t.outcomeUnknown && !p.media.deleted);
					const act = (a: Action, t: Target) => (a === 'reconnect' ? go('/accounts') : a === 'posted' ? markPosted(t) : retry(p, t));
					const expanded = open === p.id;
					return (
						<div key={p.id} role="listitem">
							<div className="hrow" onClick={() => setOpen(expanded ? null : p.id)} aria-expanded={expanded} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(expanded ? null : p.id)}>
								<span className="thumb"><Icon.play /></span>
								<div style={{ minWidth: 0 }}>
									<div className="row" style={{ gap: 8 }}>
										<b className="ellipsis" style={{ fontWeight: 600 }}>{p.caption.split('\n')[0] || p.media.filename}</b>
										{p.isDemo && <span className="chip demo">Demo</span>}
									</div>
									<div className="faint ellipsis" style={{ fontSize: 12, marginTop: 2 }}>
										{p.media.filename} · <span className="mono">{fmtDur(p.media.duration)}</span>
									</div>
								</div>
								<div className="hdests">
									{p.targets.map((t) => {
										const d = describe(t, p.isDemo, p.media.deleted);
										const inner = (
											<>
												<span className="pmark"><PlatformMark p={t.platform} size={12} bare /></span>
												<span className="dot" style={{ background: toneColor(d.tone), width: 6, height: 6 }} />
													{d.label}
											</>
										);
										return t.permalink && !p.isDemo ? (
											<a key={t.id} className="hdest" href={t.permalink} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={`Open on ${PLATFORM_NAME[t.platform]}`}>{inner}</a>
										) : (
											<span key={t.id} className="hdest" title={`${t.account.name}: ${d.explain}`}>{inner}</span>
										);
									})}
								</div>
								<div className="hmeta">
									{failed.length > 0 && p.done && (
										<button className="btn sm" disabled={retrying === p.id} onClick={(e) => (e.stopPropagation(), retry(p))}><Icon.retry /> Retry failed</button>
									)}
									<span className="when">{p.scheduled && p.scheduledAt ? <><Icon.clock /> {fmtTime(p.scheduledAt)}</> : fmtTime(p.createdAt)}</span>
								</div>
							</div>
							{expanded && (
								<div className="hdetail">
									{p.targets.map((t) => (
										<div key={t.id}>
											<TargetRow t={t} demo={p.isDemo} mediaDeleted={p.media.deleted} busy={retrying === p.id} onAction={act} caption={p.caption} />
											{t.events.length > 0 && (
												<div className="events" style={{ padding: '0 18px 12px 58px', marginTop: -4 }}>
													{t.events.map((e, i) => <div key={i}><span className="mono">{new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>&ensp;{e.message}</div>)}
												</div>
											)}
										</div>
									))}
									{p.scheduled && <ScheduleActions post={p} onUpdate={() => refresh()} />}
									{p.media.deleted ? <div className="hint" style={{ padding: '0 18px 12px' }}>The video file was cleaned up after the retention period. To post it again, create a new post and upload it.</div>
											: <div className="row" style={{ padding: '0 18px 12px', justifyContent: 'flex-end' }}><button className="btn sm quiet" onClick={() => go('/')}>Create another post</button></div>}
										{canRepost && p.done && (
											<div className="row" style={{ padding: '0 18px 12px', justifyContent: 'flex-end', marginTop: p.media.deleted ? 0 : -6 }}>
												<button className="btn sm" onClick={() => (queueRepost(p.id), go('/'))} title="Open this post in Create post with the same caption, settings and video"><Icon.repost /> Post again</button>
											</div>
										)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</>
	);
}
