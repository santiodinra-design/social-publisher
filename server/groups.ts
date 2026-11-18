// Saved account groups: a named set of accounts the composer can select in one click.
// Accounts that were disconnected since are skipped when a group is shown.
import { getDb, now } from './db.js';
import { randomId } from './crypto.js';

export type Group = { id: string; name: string; accountIds: string[] };

const live = () => new Set((getDb().prepare("SELECT id FROM accounts WHERE status != 'disconnected'").all() as { id: string }[]).map((r) => r.id));

export function listGroups(): Group[] {
	const ok = live();
	return (getDb().prepare('SELECT id, name, account_ids FROM account_groups ORDER BY created_at').all() as { id: string; name: string; account_ids: string }[]).map((r) => ({
		id: r.id,
		name: r.name,
		accountIds: (JSON.parse(r.account_ids) as string[]).filter((id) => ok.has(id)),
	}));
}

/** Checks a name and account list. Returns a message for the owner, or the cleaned values. */
export function clean(name: unknown, accountIds: unknown): { ok: true; name: string; ids: string[] } | { ok: false; message: string } {
	const n = typeof name === 'string' ? name.trim() : '';
	if (!n) return { ok: false, message: 'Give the group a name.' };
	if (n.length > 40) return { ok: false, message: 'Group names can be up to 40 characters.' };
	const ok = live();
	const ids = Array.isArray(accountIds) ? [...new Set(accountIds.filter((x): x is string => typeof x === 'string' && ok.has(x)))] : [];
	if (ids.length < 1) return { ok: false, message: 'Choose at least one connected account for the group.' };
	return { ok: true, name: n, ids };
}

export function createGroup(name: string, ids: string[]): Group {
	const id = randomId(8);
	getDb().prepare('INSERT INTO account_groups (id, name, account_ids, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(ids), now());
	return { id, name, accountIds: ids };
}

export function updateGroup(id: string, name: string, ids: string[]) {
	return getDb().prepare('UPDATE account_groups SET name = ?, account_ids = ? WHERE id = ?').run(name, JSON.stringify(ids), id).changes > 0;
}

export const deleteGroup = (id: string) => getDb().prepare('DELETE FROM account_groups WHERE id = ?').run(id).changes > 0;
