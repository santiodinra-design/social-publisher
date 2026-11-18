//! Connected accounts and their tokens (port of `server/accounts.ts`).
use crate::crypto::{open, random_id, redact, seal};
use crate::db::{AccountRow, Platform, ACTIVE_STATES};
use crate::platforms::{self, Identity, PubError, TokenSet};
use crate::util::now_ms;
use crate::App;
use rusqlite::{named_params, params, OptionalExtension};
use serde_json::{json, Value};

pub fn upsert_account(app: &App, platform: Platform, id: &Identity, t: &TokenSet, is_demo: bool) -> Option<AccountRow> {
	let db = app.db();
	let existing: Option<String> =
		db.query_row("SELECT id FROM accounts WHERE platform = ? AND external_id = ? AND is_demo = ?", params![platform.as_str(), id.external_id, is_demo as i64], |r| r.get(0)).optional().ok().flatten();
	let row_id = existing.unwrap_or_else(|| random_id(10));
	let key = &app.cfg.token_key;
	db.execute(
		"INSERT INTO accounts (id, platform, external_id, display_name, handle, avatar_url, is_demo, status, status_detail, access_token, refresh_token, access_expires_at, refresh_expires_at, scopes, meta, created_at, updated_at)
		VALUES (:id, :platform, :external_id, :display_name, :handle, :avatar_url, :is_demo, 'connected', NULL, :access_token, :refresh_token, :access_expires_at, :refresh_expires_at, :scopes, :meta, :t, :t)
		ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, handle = excluded.handle, avatar_url = excluded.avatar_url, status = 'connected', status_detail = NULL,
		access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, accounts.refresh_token), access_expires_at = excluded.access_expires_at,
		refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes, meta = excluded.meta, updated_at = excluded.updated_at",
		named_params! {
			":id": row_id,
			":platform": platform.as_str(),
			":external_id": id.external_id,
			":display_name": id.display_name,
			":handle": id.handle,
			":avatar_url": id.avatar_url,
			":is_demo": is_demo as i64,
			":access_token": seal(key, Some(&t.access_token)),
			":refresh_token": seal(key, t.refresh_token.as_deref()),
			":access_expires_at": t.access_expires_at,
			":refresh_expires_at": t.refresh_expires_at,
			":scopes": t.scopes,
			":meta": id.meta.as_ref().map(|m| m.to_string()),
			":t": now_ms(),
		},
	)
	.ok()?;
	get_account(app, &row_id)
}

pub fn get_account(app: &App, id: &str) -> Option<AccountRow> {
	app.db().prepare_cached("SELECT * FROM accounts WHERE id = ?").ok()?.query_row([id], AccountRow::from_row).optional().ok().flatten()
}

pub fn mark_account(app: &App, id: &str, status: &str, detail: Option<&str>) {
	let _ = app.db().execute("UPDATE accounts SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?", params![status, detail.map(redact), now_ms(), id]);
}

/** Safe view for the page: never includes tokens. */
pub fn public_account(a: &AccountRow) -> Value {
	json!({
		"id": a.id,
		"platform": a.platform.as_str(),
		"displayName": a.display_name,
		"handle": a.handle,
		"avatarUrl": a.avatar_url,
		"isDemo": a.is_demo,
		"status": a.status,
		"statusDetail": a.status_detail,
		"accessExpiresAt": a.access_expires_at,
		"connectedAt": a.created_at,
	})
}

pub fn list_accounts(app: &App) -> Value {
	let db = app.db();
	let mut out = Vec::new();
	if let Ok(mut st) = db.prepare_cached("SELECT * FROM accounts ORDER BY platform, created_at") {
		if let Ok(rows) = st.query_map([], AccountRow::from_row) {
			out.extend(rows.flatten().map(|a| public_account(&a)));
		}
	}
	Value::from(out)
}

/** Returns a working access token, refreshing it shortly before it expires. */
pub async fn access_token(app: &App, account_id: &str) -> Result<String, PubError> {
	// The fast path needs no lock. A refresh is serialised so two jobs never refresh the same token at once.
	if let Some(t) = usable_token(app, account_id)? {
		return Ok(t);
	}
	let _guard = app.refresh_lock.lock().await;
	if let Some(t) = usable_token(app, account_id)? {
		return Ok(t);
	}
	let a = get_account(app, account_id).ok_or_else(|| PubError::auth("Account was disconnected"))?;
	let key = &app.cfg.token_key;
	let token = open(key, a.access_token.as_deref()).ok().flatten();
	let refresh = open(key, a.refresh_token.as_deref()).ok().flatten();
	let expiring = a.access_expires_at.map(|e| e - now_ms() < 5 * 60_000).unwrap_or(false);
	match platforms::refresh(app, &a, refresh.as_deref(), token.as_deref()).await {
		Ok(t) => {
			let _ = app.db().execute(
				"UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), access_expires_at = ?, refresh_expires_at = COALESCE(?, refresh_expires_at), status = 'connected', status_detail = NULL, updated_at = ? WHERE id = ?",
				params![seal(key, Some(&t.access_token)), seal(key, t.refresh_token.as_deref()), t.access_expires_at, t.refresh_expires_at, now_ms(), a.id],
			);
			Ok(t.access_token)
		}
		Err(e) => {
			// An early Instagram refresh failed but the token still works.
			if let (Some(t), false) = (token, expiring) {
				return Ok(t);
			}
			mark_account(app, &a.id, "reconnect_required", Some(&format!("Sign-in expired: {}", e.message())));
			Err(PubError::auth("Sign-in expired. Reconnect this account."))
		}
	}
}

/** The stored token if it can be used as it is; `None` if it must be refreshed first. */
fn usable_token(app: &App, account_id: &str) -> Result<Option<String>, PubError> {
	let a = get_account(app, account_id).ok_or_else(|| PubError::auth("Account was disconnected"))?;
	if a.is_demo {
		return Ok(Some("demo".into()));
	}
	if a.status == "reconnect_required" {
		return Err(PubError::auth("Reconnect this account"));
	}
	let token = open(&app.cfg.token_key, a.access_token.as_deref()).ok().flatten();
	let left = a.access_expires_at.map(|e| e - now_ms());
	let expiring = left.map(|l| l < 5 * 60_000).unwrap_or(false);
	let ig_refresh_due = a.platform == Platform::Instagram && left.map(|l| l < 10 * 86_400_000).unwrap_or(false);
	Ok(token.filter(|_| !expiring && !ig_refresh_due))
}

pub async fn disconnect(app: &App, id: &str) -> Result<(), String> {
	let Some(a) = get_account(app, id) else { return Ok(()) };
	if !a.is_demo {
		let key = &app.cfg.token_key;
		let access = open(key, a.access_token.as_deref()).ok().flatten();
		let refresh = open(key, a.refresh_token.as_deref()).ok().flatten();
		platforms::revoke(app, a.platform, access.as_deref(), refresh.as_deref(), crate::relay::via_relay(&a)).await;
	}
	let db = app.db();
	let busy: i64 = db.query_row(&format!("SELECT COUNT(*) FROM targets WHERE account_id = ? AND state IN {ACTIVE_STATES}"), [id], |r| r.get(0)).unwrap_or(0);
	if busy > 0 {
		return Err("This account has posts in progress. Wait for them to finish first.".into());
	}
	// Keep the row so post history still shows the account name; wipe the credentials.
	let _ = db.execute("UPDATE accounts SET status = 'disconnected', access_token = NULL, refresh_token = NULL, access_expires_at = NULL, updated_at = ? WHERE id = ?", params![now_ms(), id]);
	Ok(())
}
