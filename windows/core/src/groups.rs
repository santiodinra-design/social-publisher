//! Saved account groups: a named set of accounts the composer can select in one click (port of
//! `server/groups.ts`). Accounts disconnected since are skipped when a group is shown.
use crate::crypto::random_id;
use crate::util::now_ms;
use crate::App;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashSet;

fn live(app: &App) -> HashSet<String> {
	let db = app.db();
	let mut st = match db.prepare_cached("SELECT id FROM accounts WHERE status != 'disconnected'") {
		Ok(st) => st,
		Err(_) => return HashSet::new(),
	};
	st.query_map([], |r| r.get::<_, String>(0)).map(|r| r.flatten().collect()).unwrap_or_default()
}

/** Every group, oldest first, as `{ id, name, accountIds }`. */
pub fn list(app: &App) -> Value {
	let ok = live(app);
	let rows: Vec<(String, String, String)> = {
		let db = app.db();
		let mut st = match db.prepare_cached("SELECT id, name, account_ids FROM account_groups ORDER BY created_at") {
			Ok(st) => st,
			Err(_) => return json!([]),
		};
		st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|r| r.flatten().collect()).unwrap_or_default()
	};
	Value::Array(
		rows.into_iter()
			.map(|(id, name, ids)| {
				let ids: Vec<String> = serde_json::from_str::<Vec<String>>(&ids).unwrap_or_default().into_iter().filter(|i| ok.contains(i)).collect();
				json!({ "id": id, "name": name, "accountIds": ids })
			})
			.collect(),
	)
}

/** Checks a name and account list. Returns the cleaned values, or a message for the owner. */
pub fn clean(app: &App, name: &Value, account_ids: &Value) -> Result<(String, Vec<String>), &'static str> {
	let n = name.as_str().unwrap_or("").trim().to_string();
	if n.is_empty() {
		return Err("Give the group a name.");
	}
	if n.encode_utf16().count() > 40 {
		return Err("Group names can be up to 40 characters.");
	}
	let ok = live(app);
	let mut ids: Vec<String> = Vec::new();
	for id in account_ids.as_array().into_iter().flatten().filter_map(Value::as_str) {
		if ok.contains(id) && !ids.iter().any(|x| x == id) {
			ids.push(id.to_string());
		}
	}
	if ids.is_empty() {
		return Err("Choose at least one connected account for the group.");
	}
	Ok((n, ids))
}

pub fn create(app: &App, name: &str, ids: &[String]) -> Value {
	let id = random_id(8);
	let _ = app.db().execute("INSERT INTO account_groups (id, name, account_ids, created_at) VALUES (?, ?, ?, ?)", params![id, name, json!(ids).to_string(), now_ms()]);
	json!({ "id": id, "name": name, "accountIds": ids })
}

pub fn update(app: &App, id: &str, name: &str, ids: &[String]) -> bool {
	app.db().execute("UPDATE account_groups SET name = ?, account_ids = ? WHERE id = ?", params![name, json!(ids).to_string(), id]).unwrap_or(0) > 0
}

pub fn delete(app: &App, id: &str) -> bool {
	app.db().execute("DELETE FROM account_groups WHERE id = ?", [id]).unwrap_or(0) > 0
}
