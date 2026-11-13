//! Demo mode: simulated publishing. Never touches a real platform and never produces a link.
//! Posts made here are stored with `is_demo = 1` and shown as "Simulated".
use super::{Ctx, Outcome, PubError};
use crate::db::Platform;
use crate::jobs::Patch;
use regex::Regex;
use std::sync::LazyLock;

static RE_FAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)#fail\b").unwrap());
static RE_FLAKY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)#flaky\b").unwrap());

pub async fn run(ctx: &mut Ctx) -> Result<Outcome, PubError> {
	// Add "#fail" or "#flaky" to a caption to try the failure and retry paths.
	let fail = RE_FAIL.is_match(&ctx.caption);
	let flaky = RE_FLAKY.is_match(&ctx.caption) && ctx.target.attempts < 2;
	ctx.save(Patch::new().state("uploading").phase("upload"));
	let mut p = ctx.target.progress;
	while p < 1.0 {
		ctx.save(Patch::new().progress((p + 0.1).min(1.0)));
		ctx.sleep(250).await;
		p += 0.1;
	}
	if flaky {
		return Err(PubError::transient_after("Simulated network hiccup", 1500));
	}
	ctx.save(Patch::new().state("processing").phase("processing"));
	ctx.sleep(1200).await;
	if fail && ctx.target.platform != Platform::Youtube {
		return Err(PubError::permanent("Simulated failure (caption contains #fail)"));
	}
	if ctx.target.platform == Platform::Tiktok {
		return Ok(Outcome::NeedsAttention { message: "Simulated: would be sent to your TikTok inbox to finish in the app.".into() });
	}
	Ok(Outcome::Published { permalink: None, remote_id: None, message: Some("Simulated. Nothing was posted.".into()) })
}
