import React, { useEffect, useState } from 'react';
import { api, PLATFORM_NAME, type Account, type Group, type Platform } from '../api';
import { Avatar, Icon, PlatformMark } from '../ui';

const ORDER: Platform[] = ['youtube', 'tiktok', 'instagram'];

/**
 * Groups of accounts that belong together, for example one creator's YouTube, TikTok and Instagram.
 * Pick the group in Create post to select all of them, or in Stats to see their combined numbers.
 */
export function GroupsManager({ accounts }: { accounts: Account[] }) {
	const live = accounts.filter((a) => a.status !== 'disconnected');
	const [groups, setGroups] = useState<Group[] | null>(null);
	const [edit, setEdit] = useState<{ id: string | null; name: string; ids: string[] } | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => void api.groups().then(setGroups).catch(() => setGroups([])), [accounts.length]);
	if (!groups) return null;

	async function save() {
		if (!edit) return;
		setError(null);
		try {
			if (edit.id) setGroups(await api.updateGroup(edit.id, edit.name, edit.ids));
			else {
				const g = await api.createGroup(edit.name, edit.ids);
				setGroups((s) => [...(s ?? []), g]);
			}
			setEdit(null);
		} catch (e: any) {
			setError(e.message);
		}
	}
	async function remove(g: Group) {
		if (!confirm(`Delete the group "${g.name}"? The accounts stay connected.`)) return;
		setGroups(await api.deleteGroup(g.id));
	}
	const byId = new Map(live.map((a) => [a.id, a]));
	const toggle = (id: string) => setEdit((e) => e && { ...e, ids: e.ids.includes(id) ? e.ids.filter((x) => x !== id) : [...e.ids, id] });

	return (
		<div className="panel groups-panel">
			<div className="plat-head">
				<span className="pmark"><Icon.accounts /></span>
				<div className="grow">
					<b>Groups</b>
					<small>Accounts that belong together, like one creator's YouTube, TikTok and Instagram. Pick a group to post to all of them, or to see their stats together.</small>
				</div>
				{!edit && live.length > 1 && <button className="btn sm" onClick={() => setEdit({ id: null, name: '', ids: [] })}>New group</button>}
			</div>

			{groups.length === 0 && !edit && <div className="hint pad" style={{ paddingTop: 0 }}>{live.length > 1 ? 'No groups yet.' : 'Connect a second account to make a group.'}</div>}

			{groups.map((g) =>
				edit?.id === g.id ? null : (
					<div className="grow-row" key={g.id}>
						<b className="ellipsis">{g.name}</b>
						<div className="gmembers">
							{g.accountIds.map((id) => byId.get(id)).filter(Boolean).map((a) => (
								<span key={a!.id} className="gmember" title={`${a!.displayName} on ${PLATFORM_NAME[a!.platform]}`}>
									<PlatformMark p={a!.platform} size={12} bare />
									{a!.displayName}
								</span>
							))}
							{!g.accountIds.length && <span className="faint">No connected accounts left</span>}
						</div>
						<button className="btn sm quiet" onClick={() => setEdit({ id: g.id, name: g.name, ids: g.accountIds })}>Edit</button>
						<button className="btn sm quiet danger" onClick={() => remove(g)}>Delete</button>
					</div>
				),
			)}

			{edit && (
				<div className="gedit">
					<label className="f">
						<span>Group name</span>
						<input className="field" autoFocus maxLength={40} placeholder="For example: Voltsys" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
					</label>
					<div className="label" style={{ marginTop: 10 }}>Accounts in this group</div>
					<div className="gpick">
						{ORDER.map((p) => {
							const list = live.filter((a) => a.platform === p);
							if (!list.length) return null;
							return (
								<div key={p} className="gpick-col">
									<small><PlatformMark p={p} size={12} bare /> {PLATFORM_NAME[p]}</small>
									{list.map((a) => (
										<label key={a.id} className={`gopt ${edit.ids.includes(a.id) ? 'on' : ''}`}>
											<input type="checkbox" checked={edit.ids.includes(a.id)} onChange={() => toggle(a.id)} />
											<Avatar name={a.displayName} url={a.avatarUrl} size={22} />
											<span className="ellipsis">{a.displayName}</span>
										</label>
									))}
								</div>
							);
						})}
					</div>
					{error && <div className="err">{error}</div>}
					<div className="row" style={{ gap: 6, marginTop: 12 }}>
						<button className="btn sm primary" disabled={!edit.name.trim() || !edit.ids.length} onClick={save}>{edit.id ? 'Save group' : 'Create group'}</button>
						<button className="btn sm quiet" onClick={() => (setEdit(null), setError(null))}>Cancel</button>
					</div>
				</div>
			)}
		</div>
	);
}
