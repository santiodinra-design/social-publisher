import type { Platform, TargetState } from '../db.js';
import type { Issue, MediaInfo } from '../media.js';
import { redact } from '../crypto.js';

export type AccountRow = {
	id: string;
	platform: Platform;
	external_id: string;
	display_name: string;
	handle: string | null;
	avatar_url: string | null;
	is_demo: number;
	status: string;
	status_detail: string | null;
	access_token: string | null;
	refresh_token: string | null;
	access_expires_at: number | null;
	refresh_expires_at: number | null;
	scopes: string | null;
	meta: string | null;
	created_at: number;
	updated_at: number;
};

export type MediaRow = {
	id: string;
	path: string;
	filename: string;
	mime: string;
	size: number;
	duration: number | null;
	width: number | null;
	height: number | null;
	video_codec: string | null;
	audio_codec: string | null;
	fps: number | null;
	created_at: number;
};

export type TargetRow = {
	id: string;
	post_id: string;
	account_id: string;
	platform: Platform;
	settings: string;
	state: TargetState;
	phase: string | null;
	progress: number;
	provider_ref: string | null;
	attempts: number;
	uncertain: number;
	error: string | null;
	permalink: string | null;
	remote_id: string | null;
	created_at: number;
};

export type TokenSet = {
	accessToken: string;
	refreshToken?: string | null;
	accessExpiresAt?: number | null;
	refreshExpiresAt?: number | null;
	scopes?: string | null;
};

/** `tokens`: this account's own token, when one sign-in yields a different token per account (Facebook Pages). */
export type Identity = { externalId: string; displayName: string; handle?: string | null; avatarUrl?: string | null; meta?: Record<string, unknown>; tokens?: TokenSet };

export type Outcome =
	| { state: 'published'; permalink: string | null; remoteId?: string | null; message?: string }
	| { state: 'needs_attention'; message: string; permalink?: string | null };

export type Patch = { state?: TargetState; phase?: string | null; progress?: number; providerRef?: Record<string, unknown> | null; remoteId?: string | null; uncertain?: boolean };

export interface PublishContext {
	target: TargetRow;
	settings: Record<string, any>;
	caption: string;
	media: MediaRow;
	account: AccountRow;
	ref: Record<string, any>;
	/** A valid access token, refreshed first if it is about to expire. */
	token(): Promise<string>;
	save(p: Patch): void;
	log(message: string): void;
	sleep(ms: number): Promise<void>;
	postCreatedAt: number;
	/** Call before anything that needs the local video bytes. Throws MissingMediaError if it was cleaned up. */
	needFile(): void;
}

export interface Availability {
	available: boolean;
	mode: string;
	note: string;
}

export interface Adapter {
	platform: Platform;
	availability(): Availability;
	validateSettings(settings: Record<string, any>, caption: string, media: MediaInfo): Issue[];
	authorizeUrl(state: string, pkceChallenge: string): string;
	exchangeCode(code: string, pkceVerifier: string): Promise<TokenSet>;
	refresh(account: AccountRow, refreshToken: string | null, accessToken: string | null): Promise<TokenSet>;
	identity(accessToken: string, tokens: TokenSet): Promise<Identity>;
	/** Platforms whose one sign-in can grant several accounts (Instagram Unified login). */
	identities?(accessToken: string, tokens: TokenSet): Promise<Identity[]>;
	revoke?(accessToken: string | null, refreshToken: string | null): Promise<void>;
	/** Runs from the target's current phase. Throw TransientError, AuthError or PermanentError on failure. */
	run(ctx: PublishContext): Promise<Outcome>;
	/**
	 * Called before retrying a target whose last attempt ended without a clear answer.
	 * Must only return 'restart' when the platform's own evidence shows nothing can have been posted.
	 * Lookup failures must be thrown (never turned into 'restart').
	 */
	reconcile(ctx: PublishContext): Promise<Outcome | 'resume' | 'restart'>;
}

export class TransientError extends Error {
	constructor(message: string, readonly retryAfterMs?: number) {
		super(redact(message));
	}
}
export class PermanentError extends Error {
	constructor(message: string) {
		super(redact(message));
	}
}
/** The platform itself confirmed the upload failed or was rejected, so a fresh upload cannot duplicate it. */
export class RejectedError extends PermanentError {}
/** The local video is gone, so bytes cannot be sent. Status checks that need no file are unaffected. */
export class MissingMediaError extends PermanentError {}
/** The account needs to be reconnected. */
export class AuthError extends Error {
	constructor(message: string) {
		super(redact(message));
	}
}
/** The user must do something (for example finish the post in the app). Not retried automatically. */
export class AttentionError extends Error {
	constructor(message: string) {
		super(redact(message));
	}
}
