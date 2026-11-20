import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export type Platform = 'tiktok' | 'instagram' | 'youtube';
export type TargetState = 'queued' | 'uploading' | 'processing' | 'published' | 'failed' | 'needs_attention';
export const TERMINAL: TargetState[] = ['published', 'failed', 'needs_attention'];

let db: DatabaseSync | null = null;

export function getDb(file = path.join(config.dataDir, 'app.db')): DatabaseSync {
	if (db) return db;
	if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
	db = new DatabaseSync(file);
	db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
	migrate(db);
	return db;
}

/** Tests use a fresh in-memory database. */
export function resetDbForTests() {
	db?.close();
	db = null;
	return getDb(':memory:');
}

function migrate(d: DatabaseSync) {
	d.exec(`
	CREATE TABLE IF NOT EXISTS accounts (
		id TEXT PRIMARY KEY,
		platform TEXT NOT NULL,
		external_id TEXT NOT NULL,
		display_name TEXT NOT NULL,
		handle TEXT,
		avatar_url TEXT,
		is_demo INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'connected',
		status_detail TEXT,
		access_token TEXT,
		refresh_token TEXT,
		access_expires_at INTEGER,
		refresh_expires_at INTEGER,
		scopes TEXT,
		meta TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE(platform, external_id, is_demo)
	);
	CREATE TABLE IF NOT EXISTS media (
		id TEXT PRIMARY KEY,
		path TEXT NOT NULL,
		filename TEXT NOT NULL,
		mime TEXT NOT NULL,
		size INTEGER NOT NULL,
		duration REAL,
		width INTEGER,
		height INTEGER,
		video_codec TEXT,
		audio_codec TEXT,
		fps REAL,
		created_at INTEGER NOT NULL,
		deleted_at INTEGER
	);
	CREATE TABLE IF NOT EXISTS posts (
		id TEXT PRIMARY KEY,
		idempotency_key TEXT NOT NULL UNIQUE,
		media_id TEXT NOT NULL REFERENCES media(id),
		caption TEXT NOT NULL DEFAULT '',
		is_demo INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS targets (
		id TEXT PRIMARY KEY,
		post_id TEXT NOT NULL REFERENCES posts(id),
		account_id TEXT NOT NULL REFERENCES accounts(id),
		platform TEXT NOT NULL,
		settings TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'queued',
		phase TEXT,
		progress REAL NOT NULL DEFAULT 0,
		provider_ref TEXT,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_run_at INTEGER NOT NULL,
		lease_owner TEXT,
		lease_until INTEGER,
		uncertain INTEGER NOT NULL DEFAULT 0,
		error TEXT,
		permalink TEXT,
		remote_id TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS targets_due ON targets(state, next_run_at);
	CREATE TABLE IF NOT EXISTS app_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		target_id TEXT NOT NULL,
		at INTEGER NOT NULL,
		message TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS worker_status (
		owner TEXT PRIMARY KEY,
		started_at INTEGER NOT NULL,
		beat_at INTEGER NOT NULL
	);
	`);
	// Added with the scheduling and finish-notification features (same columns as the Windows build).
	// Saved account groups ("Post to" shortcuts).
	// Phones paired with the desktop app. Only a hash of each phone's key is kept.
	d.exec('CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER)');
	d.exec('CREATE TABLE IF NOT EXISTS account_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, account_ids TEXT NOT NULL, created_at INTEGER NOT NULL)');
	for (const [table, column, kind] of [['posts', 'scheduled_at', 'INTEGER'], ['posts', 'notified_at', 'INTEGER']] as const) {
		const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
		if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${kind}`);
	}
}

/** The worker records a heartbeat here; the web server only reads it. */
export function workerBeat(owner: string, startedAt: number) {
	getDb().prepare('INSERT INTO worker_status (owner, started_at, beat_at) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET beat_at = excluded.beat_at').run(owner, startedAt, now());
	getDb().prepare('DELETE FROM worker_status WHERE beat_at < ?').run(now() - 86_400_000);
}
export const WORKER_STALE_MS = 45_000;
export function workerStatus() {
	const r = getDb().prepare('SELECT owner, started_at, beat_at FROM worker_status ORDER BY beat_at DESC LIMIT 1').get() as { started_at: number; beat_at: number } | undefined;
	if (!r) return { state: 'never' as const, lastSeenAt: null, startedAt: null };
	return { state: now() - r.beat_at < WORKER_STALE_MS ? ('running' as const) : ('stale' as const), lastSeenAt: r.beat_at, startedAt: r.started_at };
}

export const now = () => Date.now();
