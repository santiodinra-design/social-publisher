import React, { useEffect, useState } from 'react';
import { api, type Inbox } from '../api';
import { desktop } from '../desktop';

/** The inbox folder: videos dropped there (by the owner's Claude sessions) go out as drafts automatically. */
export function InboxPanel() {
	const [inbox, setInbox] = useState<Inbox | null>(null);
	useEffect(() => {
		const load = () => api.inbox().then(setInbox).catch(() => undefined);
		load();
		const t = setInterval(load, 5000);
		return () => clearInterval(t);
	}, []);
	if (!inbox?.enabled) return null;
	return (
		<section className="panel inbox-panel" aria-label="Automatic drafts">
			<div className="block-head">
				<h3>Automatic drafts</h3>
				<span className="grow" />
				{desktop?.revealInbox && <button type="button" className="btn sm" onClick={() => desktop!.revealInbox!()}>Open folder</button>}
			</div>
			<p className="hint" style={{ margin: '0 0 8px' }}>
				Your Claude sessions save finished videos with a caption file into <span className="mono">{inbox.dir.replace(/^\/Users\/[^/]+/, '~')}</span>. Publisher sends each one as drafts: YouTube Private and TikTok inbox. Instagram is never used from here. Keep Publisher open.
			</p>
			{inbox.recent.length ? (
				<ul className="inbox-list">
					{inbox.recent.slice(0, 6).map((r) => (
						<li key={`${r.name}-${r.at}`} className={r.status}>
							<b className="ellipsis">{r.name}</b>
							<span>{r.message}</span>
							<small className="faint">{new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
						</li>
					))}
				</ul>
			) : (
				<p className="faint" style={{ margin: 0, fontSize: 12.5 }}>Nothing has arrived since Publisher opened.</p>
			)}
		</section>
	);
}
