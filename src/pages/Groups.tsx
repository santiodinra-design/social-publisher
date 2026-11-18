import React, { useEffect, useState } from 'react';
import { api, PLATFORM_NAME, type Account, type Group, type Platform } from '../api';
import { Icon } from '../ui';

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * One-click account groups above "Post to".
 * Automatic groups (All accounts, All YouTube, …) always match what is connected right now;
 * saved groups are the owner's own sets, kept on this computer.
 */
export function AccountGroups({ usable, selected, onApply, canSave, locked }: { usable: Account[]; selected: string[]; onApply: (ids: string[]) => void; canSave: boolean; locked: boolean }) {
	const [saved, setSaved] = useState<Group[]>([]);
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (canSave) api.groups().then(setSaved).catch(() => undefined);
	}, [canSave, usable.length]);

	const auto: { key: string; name: string; ids: string[] }[] = [];
	if (usable.length >= 2) auto.push({ key: 'all', name: 'All accounts', ids: usable.map((a) => a.id) });
	for (const p of ['youtube', 'instagram', 'tiktok'] as Platform[]) {
		const ids = usable.filter((a) => a.platform === p).map((a) => a.id);
		if (ids.length >= 2 && ids.length < usable.length) auto.push({ key: p, name: `All ${PLATFORM_NAME[p]}`, ids });
	}
	const groups = [...auto.map((g) => ({ ...g, saved: false as const })), ...saved.filter((g) => g.accountIds.length).map((g) => ({ key: g.id, name: g.name, ids: g.accountIds, saved: true as const }))];
	const matches = groups.some((g) => same(g.ids, selected));
	const offerSave = canSave && !locked && selected.length >= 2 && !matches;
	if (!groups.length && !offerSave) return null;

	async function save() {
		setError(null);
		try {
			const g = await api.createGroup(name, selected);
			setSaved((s) => [...s, g]);
			setNaming(false);
			setName('');
		} catch (e: any) {
			setError(e.message);
		}
	}

	return (
		<div className="groups" role="group" aria-label="Account groups">
			{groups.map((g) => {
				const on = same(g.ids, selected);
				return (
					<span key={g.key} className={`gchip ${on ? 'on' : ''}`}>
						<button type="button" disabled={locked} aria-pressed={on} title={`Select ${g.ids.length} account${g.ids.length > 1 ? 's' : ''}`} onClick={() => onApply(on ? [] : g.ids)}>
							{g.saved ? <Icon.accounts /> : null}
							{g.name}
							<small>{g.ids.length}</small>
						</button>
						{g.saved && !locked && (
							<button type="button" className="gx" aria-label={`Delete group ${g.name}`} title="Delete this group" onClick={async () => setSaved(await api.deleteGroup(g.key))}>
								<Icon.x />
							</button>
						)}
					</span>
				);
			})}
			{offerSave &&
				(naming ? (
					<span className="gname">
						<input className="field" autoFocus maxLength={40} placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? save() : e.key === 'Escape' ? setNaming(false) : undefined)} />
						<button type="button" className="btn sm primary" onClick={save} disabled={!name.trim()}>Save</button>
						<button type="button" className="btn sm quiet" onClick={() => (setNaming(false), setError(null))}>Cancel</button>
					</span>
				) : (
					<button type="button" className="gchip add" onClick={() => setNaming(true)}>+ Save as group</button>
				))}
			{error && <span className="err" style={{ marginTop: 0 }}>{error}</span>}
		</div>
	);
}
