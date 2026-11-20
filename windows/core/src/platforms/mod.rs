//! Platform adapters (port of `server/platforms/`). Each adapter can run a target from its current
//! phase and can reconcile an attempt whose outcome is unknown before anything is sent again.
pub mod demo;
pub mod http;
pub mod instagram;
pub mod tiktok;
pub mod youtube;

use crate::accounts;
use crate::crypto::redact;
use crate::db::{AccountRow, MediaRow, Platform, TargetRow};
use crate::jobs::{self, Patch};
use crate::media::Issue;
use crate::App;
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

/// Why an attempt stopped. The runner decides what happens next from the kind.
#[derive(Debug, Clone)]
pub enum PubError {
	/// Worth retrying (network trouble, rate limits, the platform is still working).
	Transient { msg: String, retry_after_ms: Option<u64> },
	/// Will not succeed by retrying.
	Permanent(String),
	/// The platform itself confirmed the upload failed or was rejected, so a fresh upload cannot duplicate it.
	Rejected(String),
	/// The local video is gone, so bytes cannot be sent. Status checks that need no file are unaffected.
	MissingMedia(String),
	/// The account needs to be reconnected.
	Auth(String),
	/// The owner must do something. Not retried automatically.
	Attention(String),
	/// Anything unforeseen. Treated as "outcome unknown".
	Unexpected(String),
}

impl PubError {
	pub fn transient(m: impl AsRef<str>) -> Self {
		PubError::Transient { msg: redact(m.as_ref()), retry_after_ms: None }
	}
	pub fn transient_after(m: impl AsRef<str>, ms: u64) -> Self {
		PubError::Transient { msg: redact(m.as_ref()), retry_after_ms: Some(ms) }
	}
	pub fn permanent(m: impl AsRef<str>) -> Self {
		PubError::Permanent(redact(m.as_ref()))
	}
	pub fn rejected(m: impl AsRef<str>) -> Self {
		PubError::Rejected(redact(m.as_ref()))
	}
	pub fn auth(m: impl AsRef<str>) -> Self {
		PubError::Auth(redact(m.as_ref()))
	}
	pub fn attention(m: impl AsRef<str>) -> Self {
		PubError::Attention(redact(m.as_ref()))
	}
	pub fn unexpected(m: impl AsRef<str>) -> Self {
		PubError::Unexpected(redact(m.as_ref()))
	}
	pub fn message(&self) -> &str {
		match self {
			PubError::Transient { msg, .. } => msg,
			PubError::Permanent(m) | PubError::Rejected(m) | PubError::MissingMedia(m) | PubError::Auth(m) | PubError::Attention(m) | PubError::Unexpected(m) => m,
		}
	}
	pub fn is_auth(&self) -> bool {
		matches!(self, PubError::Auth(_))
	}
}

#[derive(Debug, Clone, Default)]
pub struct TokenSet {
	pub access_token: String,
	pub refresh_token: Option<String>,
	pub access_expires_at: Option<i64>,
	pub refresh_expires_at: Option<i64>,
	pub scopes: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Identity {
	pub external_id: String,
	pub display_name: String,
	pub handle: Option<String>,
	pub avatar_url: Option<String>,
	pub meta: Option<Value>,
	/// This account's own token, when one sign-in yields a different token per account (Facebook Pages).
	pub tokens: Option<TokenSet>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
	Published { permalink: Option<String>, remote_id: Option<String>, message: Option<String> },
	NeedsAttention { message: String },
}

/// What a reconcile found. `Restart` is only allowed when the platform's own evidence shows nothing
/// can have been posted; lookup failures must be returned as errors, never turned into `Restart`.
#[derive(Debug, Clone, PartialEq)]
pub enum Reconciled {
	Done(Outcome),
	Resume,
	Restart,
}

pub struct Availability {
	pub available: bool,
	pub mode: &'static str,
	pub note: String,
}

/// Everything an adapter needs while it works on one target.
pub struct Ctx {
	pub app: Arc<App>,
	pub owner: String,
	pub target: TargetRow,
	pub settings: Value,
	pub caption: String,
	pub media: MediaRow,
	pub account: AccountRow,
	pub post_created_at: i64,
}

impl Ctx {
	/** The provider checkpoints saved so far (an empty object when there are none). */
	pub fn rf(&self) -> Value {
		self.target.provider_ref.as_deref().and_then(|s| serde_json::from_str(s).ok()).filter(|v: &Value| v.is_object()).unwrap_or_else(|| Value::Object(Default::default()))
	}

	/** A valid access token, refreshed first if it is about to expire. */
	pub async fn token(&self) -> Result<String, PubError> {
		accounts::access_token(&self.app, &self.account.id).await
	}

	pub fn save(&mut self, p: Patch) {
		jobs::patch_target(&self.app, &self.target.id, &p);
		if let Some(t) = jobs::get_target(&self.app, &self.target.id) {
			self.target = t;
		}
	}

	pub fn log(&self, message: &str) {
		jobs::add_event(&self.app, &self.target.id, message);
	}

	pub async fn sleep(&self, ms: u64) {
		jobs::heartbeat(&self.app, &self.target.id, &self.owner);
		if self.app.fast_sleep.load(Ordering::Relaxed) {
			tokio::task::yield_now().await;
		} else {
			tokio::time::sleep(Duration::from_millis(ms)).await;
		}
	}

	/** Call before anything that needs the local video bytes. Status checks never need them. */
	pub fn need_file(&self) -> Result<(), PubError> {
		if std::path::Path::new(&self.media.path).exists() {
			Ok(())
		} else {
			Err(PubError::MissingMedia("The uploaded video file is no longer on this computer (it was cleaned up after the retention period). Upload it again in a new post.".into()))
		}
	}
}

pub fn availability(app: &App, p: Platform, is_demo: bool) -> Availability {
	if is_demo {
		return Availability { available: true, mode: "demo", note: "Demo account. Publishing is simulated and nothing is posted.".into() };
	}
	match p {
		Platform::Tiktok => tiktok::availability(app),
		Platform::Instagram => instagram::availability(app),
		Platform::Youtube => youtube::availability(),
	}
}

pub fn validate_settings(app: &App, p: Platform, settings: &Value, caption: &str) -> Vec<Issue> {
	match p {
		Platform::Tiktok => tiktok::validate_settings(app, settings, caption),
		Platform::Instagram => instagram::validate_settings(settings, caption),
		Platform::Youtube => youtube::validate_settings(settings),
	}
}

pub fn authorize_url(app: &App, p: Platform, state: &str, challenge: &str) -> String {
	match p {
		Platform::Tiktok => tiktok::authorize_url(app, state),
		Platform::Instagram => instagram::authorize_url(app, state),
		Platform::Youtube => youtube::authorize_url(app, state, challenge),
	}
}

pub async fn exchange_code(app: &App, p: Platform, code: &str, verifier: &str, via_relay: bool) -> Result<TokenSet, PubError> {
	if via_relay {
		return crate::relay::exchange_code(app, p, code, verifier).await;
	}
	match p {
		Platform::Tiktok => tiktok::exchange_code(app, code).await,
		Platform::Instagram => instagram::exchange_code(app, code).await,
		Platform::Youtube => youtube::exchange_code(app, code, verifier).await,
	}
}

pub async fn refresh(app: &App, a: &AccountRow, refresh_token: Option<&str>, access_token: Option<&str>) -> Result<TokenSet, PubError> {
	// Instagram tokens refresh without the app secret, so those still go straight to Instagram.
	if a.platform != Platform::Instagram && crate::relay::via_relay(a) {
		return crate::relay::refresh(app, a.platform, refresh_token).await;
	}
	match a.platform {
		Platform::Tiktok => tiktok::refresh(app, refresh_token).await,
		Platform::Instagram => instagram::refresh(app, a, access_token).await,
		Platform::Youtube => youtube::refresh(app, refresh_token).await,
	}
}

pub async fn identity(app: &App, p: Platform, access_token: &str, tokens: &TokenSet) -> Result<Identity, PubError> {
	match p {
		Platform::Tiktok => tiktok::identity(app, access_token, tokens).await,
		Platform::Instagram => instagram::identities(app, access_token).await?.into_iter().next().ok_or_else(|| PubError::attention("Instagram did not share an account.")),
		Platform::Youtube => youtube::identity(app, access_token).await,
	}
}

/** Every account one sign-in grants. Only Instagram's Facebook routes can grant several. */
pub async fn identities(app: &App, p: Platform, access_token: &str, tokens: &TokenSet) -> Result<Vec<Identity>, PubError> {
	match p {
		Platform::Instagram => instagram::identities(app, access_token).await,
		_ => Ok(vec![identity(app, p, access_token, tokens).await?]),
	}
}

/** Best effort: a failed revoke never blocks disconnecting. */
pub async fn revoke(app: &App, p: Platform, access_token: Option<&str>, refresh_token: Option<&str>, via_relay: bool) {
	match p {
		Platform::Tiktok if via_relay => crate::relay::revoke_tiktok(app, access_token).await,
		Platform::Tiktok => tiktok::revoke(app, access_token).await,
		Platform::Instagram => {}
		Platform::Youtube => youtube::revoke(app, access_token, refresh_token).await,
	}
}

pub async fn run(ctx: &mut Ctx) -> Result<Outcome, PubError> {
	if ctx.account.is_demo {
		return demo::run(ctx).await;
	}
	match ctx.target.platform {
		Platform::Tiktok => tiktok::run(ctx).await,
		Platform::Instagram => instagram::run(ctx).await,
		Platform::Youtube => youtube::run(ctx).await,
	}
}

pub async fn reconcile(ctx: &mut Ctx) -> Result<Reconciled, PubError> {
	if ctx.account.is_demo {
		return Ok(Reconciled::Resume);
	}
	match ctx.target.platform {
		Platform::Tiktok => tiktok::reconcile(ctx).await,
		Platform::Instagram => instagram::reconcile(ctx).await,
		Platform::Youtube => youtube::reconcile(ctx).await,
	}
}
