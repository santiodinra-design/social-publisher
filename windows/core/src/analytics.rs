//! Account statistics: followers, views, likes, comments and shares, audience countries and ages,
//! and the best recent posts, read from each platform's own analytics API. Nothing is posted.
//!
//! What each platform shares with apps differs, and the page says so:
//! - YouTube (YouTube Analytics API, `yt-analytics.readonly`): daily views, likes, comments,
//!   shares, watch time and subscribers; viewers by country, age and gender; top videos.
//! - Instagram (`instagram_business_manage_insights`): views, reach, likes, comments, shares and
//!   saves; followers by country, age and gender (Instagram needs 100+ followers); recent posts.
//! - TikTok (`user.info.stats`, `video.list`): followers and total likes; views, likes, comments
//!   and shares of recent videos. TikTok does not give apps audience countries or daily numbers.
//!
//! Results are cached for 10 minutes per account and period.
use crate::accounts::{access_token, list_accounts};
use crate::db::Platform;
use crate::platforms::http::{json, Req};
use crate::platforms::PubError;
use crate::util::{encode_component, js_str, now_ms};
use crate::App;
use chrono::{Duration as Days, NaiveDate, Utc};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CACHE: Duration = Duration::from_secs(600);

/** Stats for every connected account (or one), for the last `days` days. */
pub async fn report(app: &Arc<App>, days: i64, only: Option<&str>, fresh: bool) -> Value {
	let days = days.clamp(7, 90);
	let accounts: Vec<Value> = list_accounts(app).as_array().cloned().unwrap_or_default().into_iter().filter(|a| a["status"] != "disconnected" && only.map(|id| a["id"] == id).unwrap_or(true)).collect();
	let jobs = accounts.iter().map(|a| account(app, a, days, fresh));
	let out = futures_util::future::join_all(jobs).await;
	json!({ "days": days, "generatedAt": now_ms(), "accounts": out })
}

async fn account(app: &Arc<App>, a: &Value, days: i64, fresh: bool) -> Value {
	let id = js_str(&a["id"]);
	let key = format!("{id}:{days}");
	if !fresh {
		if let Some((at, v)) = app.analytics_cache.lock().get(&key) {
			if at.elapsed() < CACHE {
				return v.clone();
			}
		}
	}
	let platform = Platform::parse(a["platform"].as_str().unwrap_or("")).unwrap_or(Platform::Youtube);
	let mut s = Stats::new(a, platform, days);
	let result = if a["isDemo"] == true {
		demo(&mut s);
		Ok(())
	} else if a["status"] == "reconnect_required" {
		Err(PubError::auth("Sign-in expired"))
	} else {
		match access_token(app, &id).await {
			Ok(token) => match platform {
				Platform::Youtube => youtube(app, &token, &mut s).await,
				Platform::Instagram => {
					let ig_id = crate::accounts::get_account(app, &id).map(|r| r.external_id).unwrap_or_default();
					instagram(app, &token, &ig_id, &mut s).await
				}
				Platform::Tiktok => tiktok(app, &token, &mut s).await,
			},
			Err(e) => Err(e),
		}
	};
	if let Err(e) = result {
		let msg = e.message().to_string();
		let scope = e.is_auth() || ["insufficient", "scope", "permission", "(#10)", "(#200)"].iter().any(|w| msg.to_lowercase().contains(w));
		s.status = if scope { "reconnect" } else { "error" };
		s.message = Some(if scope {
			format!("Reconnect this {} account in Connected accounts to allow stats. Accounts connected before stats existed did not grant them.", platform.label())
		} else {
			format!("Could not load stats right now ({msg}).")
		});
	}
	let v = s.finish();
	// Problems are not cached, so a reconnect shows up straight away.
	if v["status"] == "ok" {
		app.analytics_cache.lock().insert(key, (Instant::now(), v.clone()));
	}
	v
}

/// What one account's stats are made of. Totals that a platform does not report stay absent, so the
/// page can say "not available" instead of showing a misleading zero.
struct Stats {
	head: Value,
	days: i64,
	status: &'static str,
	message: Option<String>,
	followers: Option<f64>,
	totals: Map<String, Value>,
	daily: BTreeMap<String, Map<String, Value>>,
	countries: Vec<(String, f64)>,
	countries_of: &'static str,
	ages: Vec<Value>,
	top: Vec<Value>,
	notes: Vec<String>,
}

impl Stats {
	fn new(a: &Value, p: Platform, days: i64) -> Stats {
		Stats {
			head: json!({ "accountId": a["id"], "platform": p.as_str(), "name": a["displayName"], "handle": a["handle"], "avatarUrl": a["avatarUrl"], "isDemo": a["isDemo"] }),
			days,
			status: "ok",
			message: None,
			followers: None,
			totals: Map::new(),
			daily: BTreeMap::new(),
			countries: Vec::new(),
			countries_of: "views",
			ages: Vec::new(),
			top: Vec::new(),
			notes: Vec::new(),
		}
	}
	fn total(&mut self, k: &str, v: f64) {
		let cur = self.totals.get(k).and_then(Value::as_f64).unwrap_or(0.0);
		self.totals.insert(k.into(), json!(cur + v));
	}
	fn day(&mut self, date: &str, k: &str, v: f64) {
		let d = self.daily.entry(date.to_string()).or_default();
		let cur = d.get(k).and_then(Value::as_f64).unwrap_or(0.0);
		d.insert(k.into(), json!(cur + v));
	}
	fn finish(mut self) -> Value {
		let sum: f64 = self.countries.iter().map(|c| c.1).sum();
		self.countries.sort_by(|a, b| b.1.total_cmp(&a.1));
		let countries: Vec<Value> = self.countries.iter().take(10).map(|(c, v)| json!({ "code": c, "value": v, "share": if sum > 0.0 { v / sum } else { 0.0 } })).collect();
		let mut h = self.head;
		let o = h.as_object_mut().unwrap();
		o.insert("days".into(), json!(self.days));
		o.insert("status".into(), json!(self.status));
		o.insert("message".into(), json!(self.message));
		o.insert("followers".into(), json!(self.followers));
		o.insert("totals".into(), Value::Object(self.totals));
		o.insert("daily".into(), Value::from(self.daily.into_iter().map(|(date, mut m)| (m.insert("date".into(), json!(date)), Value::Object(m)).1).collect::<Vec<_>>()));
		o.insert("countries".into(), json!(countries));
		o.insert("countriesOf".into(), json!(self.countries_of));
		o.insert("ages".into(), json!(self.ages));
		o.insert("top".into(), json!(self.top));
		o.insert("notes".into(), json!(self.notes));
		h
	}
}

fn range(days: i64) -> (NaiveDate, NaiveDate) {
	let end = Utc::now().date_naive();
	(end - Days::days(days - 1), end)
}

// ---------- YouTube ----------

/** Rows of a YouTube Analytics report, keyed by column name. */
fn rows(r: &Value) -> Vec<Map<String, Value>> {
	let names: Vec<String> = r["columnHeaders"].as_array().map(|h| h.iter().map(|c| js_str(&c["name"])).collect()).unwrap_or_default();
	r["rows"].as_array().map(|rows| rows.iter().filter_map(|row| row.as_array().map(|cells| names.iter().cloned().zip(cells.iter().cloned()).collect())).collect()).unwrap_or_default()
}

async fn youtube(app: &App, token: &str, s: &mut Stats) -> Result<(), PubError> {
	let (start, end) = range(s.days);
	let ch = json(app, Req::get(&format!("{}/channels?part=statistics&mine=true", app.endpoints.youtube_api)).bearer(token)).await?;
	s.followers = ch["items"][0]["statistics"]["subscriberCount"].as_str().and_then(|v| v.parse().ok());
	let report = |q: String| format!("{}/reports?ids=channel%3D%3DMINE&startDate={start}&endDate={end}&{q}", app.endpoints.youtube_analytics);

	let daily = json(app, Req::get(&report("metrics=views,likes,comments,shares,estimatedMinutesWatched,subscribersGained,subscribersLost&dimensions=day&sort=day".into())).bearer(token)).await?;
	for r in rows(&daily) {
		let date = js_str(&r["day"]);
		for (k, col) in [("views", "views"), ("likes", "likes"), ("comments", "comments"), ("shares", "shares"), ("watchMinutes", "estimatedMinutesWatched")] {
			let v = r.get(col).and_then(Value::as_f64).unwrap_or(0.0);
			s.day(&date, k, v);
			s.total(k, v);
		}
		let gained = r.get("subscribersGained").and_then(Value::as_f64).unwrap_or(0.0) - r.get("subscribersLost").and_then(Value::as_f64).unwrap_or(0.0);
		s.total("followersGained", gained);
	}
	// The audience breakdowns are best effort: small channels often have none.
	if let Ok(c) = json(app, Req::get(&report("metrics=views&dimensions=country&sort=-views&maxResults=25".into())).bearer(token)).await {
		s.countries = rows(&c).into_iter().map(|r| (js_str(&r["country"]), r.get("views").and_then(Value::as_f64).unwrap_or(0.0))).collect();
	}
	if let Ok(ag) = json(app, Req::get(&report("metrics=viewerPercentage&dimensions=ageGroup,gender&sort=ageGroup".into())).bearer(token)).await {
		s.ages = ages(rows(&ag).into_iter().map(|r| (js_str(&r["ageGroup"]).replace("age", ""), js_str(&r["gender"]), r.get("viewerPercentage").and_then(Value::as_f64).unwrap_or(0.0))));
	}
	if s.countries.is_empty() {
		s.notes.push("YouTube shows audience countries once enough people have watched.".into());
	}
	if let Ok(t) = json(app, Req::get(&report("metrics=views,likes,comments,shares&dimensions=video&sort=-views&maxResults=6".into())).bearer(token)).await {
		let list = rows(&t);
		let ids: Vec<String> = list.iter().map(|r| js_str(&r["video"])).collect();
		let snippets = if ids.is_empty() {
			Value::Null
		} else {
			json(app, Req::get(&format!("{}/videos?part=snippet&id={}", app.endpoints.youtube_api, encode_component(&ids.join(",")))).bearer(token)).await.unwrap_or(Value::Null)
		};
		for r in list {
			let id = js_str(&r["video"]);
			let sn = snippets["items"].as_array().and_then(|i| i.iter().find(|v| v["id"] == id.as_str())).map(|v| v["snippet"].clone()).unwrap_or(Value::Null);
			s.top.push(json!({
				"id": id, "title": sn["title"], "thumbnail": sn["thumbnails"]["medium"]["url"], "publishedAt": sn["publishedAt"],
				"permalink": format!("https://www.youtube.com/watch?v={id}"),
				"views": r.get("views"), "likes": r.get("likes"), "comments": r.get("comments"), "shares": r.get("shares"),
			}));
		}
	}
	Ok(())
}

/// Turns (age group, gender, percentage) rows into one row per age group.
fn ages(rows: impl Iterator<Item = (String, String, f64)>) -> Vec<Value> {
	let mut by: BTreeMap<String, (f64, f64, f64)> = BTreeMap::new();
	for (age, gender, pct) in rows {
		let e = by.entry(age).or_default();
		match gender.to_lowercase().as_str() {
			"female" | "f" => e.0 += pct,
			"male" | "m" => e.1 += pct,
			_ => e.2 += pct,
		}
	}
	by.into_iter().map(|(age, (f, m, o))| json!({ "age": age, "female": f, "male": m, "other": o })).collect()
}

// ---------- Instagram ----------

async fn instagram(app: &App, token: &str, ig_id: &str, s: &mut Stats) -> Result<(), PubError> {
	let g = format!("{}/{}", app.endpoints.instagram_graph, app.cfg.instagram_api_version);
	let me = json(app, Req::get(&format!("{g}/me?fields=followers_count,media_count")).bearer(token)).await?;
	s.followers = me["followers_count"].as_f64();
	s.countries_of = "followers";

	// Instagram answers at most 30 days per request.
	let (start, end) = range(s.days);
	let mut from = start;
	while from <= end {
		let to = (from + Days::days(29)).min(end);
		let since = from.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
		let until = (to + Days::days(1)).and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
		let totals = json(app, Req::get(&format!("{g}/{ig_id}/insights?metric=views,reach,likes,comments,shares,saves&period=day&metric_type=total_value&since={since}&until={until}")).bearer(token)).await?;
		for m in totals["data"].as_array().cloned().unwrap_or_default() {
			let name = js_str(&m["name"]);
			s.total(&name, m["total_value"]["value"].as_f64().unwrap_or(0.0));
		}
		if let Ok(series) = json(app, Req::get(&format!("{g}/{ig_id}/insights?metric=reach&period=day&since={since}&until={until}")).bearer(token)).await {
			for v in series["data"][0]["values"].as_array().cloned().unwrap_or_default() {
				let date = js_str(&v["end_time"]).chars().take(10).collect::<String>();
				s.day(&date, "reach", v["value"].as_f64().unwrap_or(0.0));
			}
		}
		from = to + Days::days(1);
	}

	let demo_of = |b: &str| format!("{g}/{ig_id}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown={b}");
	match json(app, Req::get(&demo_of("country")).bearer(token)).await {
		Ok(c) => {
			for r in c["data"][0]["total_value"]["breakdowns"][0]["results"].as_array().cloned().unwrap_or_default() {
				s.countries.push((js_str(&r["dimension_values"][0]), r["value"].as_f64().unwrap_or(0.0)));
			}
		}
		Err(_) => s.notes.push("Instagram shares follower countries and ages once an account has 100 or more followers.".into()),
	}
	if let Ok(a) = json(app, Req::get(&demo_of("age,gender")).bearer(token)).await {
		let rows: Vec<(String, String, f64)> = a["data"][0]["total_value"]["breakdowns"][0]["results"]
			.as_array()
			.cloned()
			.unwrap_or_default()
			.iter()
			.map(|r| (js_str(&r["dimension_values"][0]), js_str(&r["dimension_values"][1]), r["value"].as_f64().unwrap_or(0.0)))
			.collect();
		let sum: f64 = rows.iter().map(|r| r.2).sum();
		s.ages = ages(rows.into_iter().map(|(a, g, v)| (a, g, if sum > 0.0 { v * 100.0 / sum } else { 0.0 })));
	}

	// Recent posts, with their own views and shares where Instagram reports them.
	let media = json(app, Req::get(&format!("{g}/{ig_id}/media?fields=id,caption,permalink,thumbnail_url,media_url,media_type,timestamp,like_count,comments_count&limit=12")).bearer(token)).await.unwrap_or(Value::Null);
	for m in media["data"].as_array().cloned().unwrap_or_default().into_iter().take(8) {
		let id = js_str(&m["id"]);
		let ins = json(app, Req::get(&format!("{g}/{id}/insights?metric=views,shares,saved")).bearer(token)).await.unwrap_or(Value::Null);
		let metric = |n: &str| ins["data"].as_array().and_then(|d| d.iter().find(|x| x["name"] == n)).and_then(|x| x["values"][0]["value"].as_f64().or_else(|| x["total_value"]["value"].as_f64()));
		let thumb = if m["media_type"] == "VIDEO" { m["thumbnail_url"].clone() } else { m["media_url"].clone() };
		s.top.push(json!({
			"id": id, "title": js_str(&m["caption"]).lines().next().unwrap_or("").chars().take(90).collect::<String>(), "thumbnail": thumb,
			"publishedAt": m["timestamp"], "permalink": m["permalink"], "views": metric("views"), "likes": m["like_count"], "comments": m["comments_count"], "shares": metric("shares"),
		}));
	}
	s.top.sort_by(|a, b| b["views"].as_f64().unwrap_or(-1.0).total_cmp(&a["views"].as_f64().unwrap_or(-1.0)));
	s.top.truncate(6);
	s.notes.push("Instagram reports accounts reached per day; views are totals for the period.".into());
	Ok(())
}

// ---------- TikTok ----------

async fn tiktok(app: &App, token: &str, s: &mut Stats) -> Result<(), PubError> {
	let api = &app.endpoints.tiktok_api;
	let u = json(app, Req::get(&format!("{api}/v2/user/info/?fields=open_id,follower_count,likes_count,video_count")).bearer(token)).await?;
	let user = &u["data"]["user"];
	s.followers = user["follower_count"].as_f64();
	if let Some(l) = user["likes_count"].as_f64() {
		s.totals.insert("allTimeLikes".into(), json!(l));
	}
	let since = (Utc::now() - Days::days(s.days)).timestamp();
	let mut cursor: Option<i64> = None;
	let mut seen = Vec::new();
	for _ in 0..5 {
		let mut body = json!({ "max_count": 20 });
		if let Some(c) = cursor {
			body["cursor"] = json!(c);
		}
		let r =
			json(app, Req::post(&format!("{api}/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,view_count,like_count,comment_count,share_count,create_time")).bearer(token).json_body(&body))
				.await?;
		let videos = r["data"]["videos"].as_array().cloned().unwrap_or_default();
		let mut older = false;
		for v in videos {
			if v["create_time"].as_i64().unwrap_or(0) < since {
				older = true;
				continue;
			}
			seen.push(v);
		}
		if older || r["data"]["has_more"] != true {
			break;
		}
		cursor = r["data"]["cursor"].as_i64();
	}
	for v in &seen {
		for (k, col) in [("views", "view_count"), ("likes", "like_count"), ("comments", "comment_count"), ("shares", "share_count")] {
			s.total(k, v[col].as_f64().unwrap_or(0.0));
		}
	}
	let mut top = seen.clone();
	top.sort_by(|a, b| b["view_count"].as_f64().unwrap_or(0.0).total_cmp(&a["view_count"].as_f64().unwrap_or(0.0)));
	s.top = top
		.into_iter()
		.take(6)
		.map(|v| {
			let title = [js_str(&v["title"]), js_str(&v["video_description"])].into_iter().find(|t| !t.trim().is_empty()).unwrap_or_default();
			json!({
				"id": v["id"], "title": title.chars().take(90).collect::<String>(), "thumbnail": v["cover_image_url"], "permalink": v["share_url"],
				"publishedAt": v["create_time"].as_i64().map(|t| t * 1000), "views": v["view_count"], "likes": v["like_count"], "comments": v["comment_count"], "shares": v["share_count"],
			})
		})
		.collect();
	s.notes.push(format!(
		"Views, likes, comments and shares are lifetime numbers of the {} video{} posted in this period. TikTok does not give apps daily numbers or audience countries.",
		seen.len(),
		if seen.len() == 1 { "" } else { "s" }
	));
	Ok(())
}

// ---------- demo ----------

/// Made-up but steady numbers for demo accounts, so the page can be tried without a real account.
fn demo(s: &mut Stats) {
	let seed = js_str(&s.head["accountId"]).bytes().fold(7u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64));
	let mut x = seed;
	let mut rnd = move || {
		x ^= x << 13;
		x ^= x >> 7;
		x ^= x << 17;
		(x % 10_000) as f64 / 10_000.0
	};
	let p = js_str(&s.head["platform"]);
	let scale = match p.as_str() {
		"youtube" => 1800.0,
		"instagram" => 1200.0,
		_ => 2600.0,
	};
	s.followers = Some((scale * 9.0 * (1.0 + rnd())).round());
	let (start, _) = range(s.days);
	for i in 0..s.days {
		let date = (start + Days::days(i)).to_string();
		let weekly = 1.0 + 0.25 * ((i as f64) * std::f64::consts::TAU / 7.0).sin();
		let growth = 1.0 + i as f64 / s.days as f64 * 0.4;
		let views = (scale * weekly * growth * (0.75 + rnd() * 0.5)).round();
		let key = if p == "instagram" { "reach" } else { "views" };
		if p != "tiktok" {
			s.day(&date, key, views);
		}
		s.total("views", views);
		s.total("likes", (views * (0.06 + rnd() * 0.02)).round());
		s.total("comments", (views * (0.004 + rnd() * 0.003)).round());
		s.total("shares", (views * (0.008 + rnd() * 0.004)).round());
		if p == "youtube" {
			s.total("watchMinutes", (views * (0.9 + rnd() * 0.4)).round());
		}
	}
	s.total("followersGained", (scale * 0.4 * (0.5 + rnd())).round());
	if p != "tiktok" {
		for (code, w) in [("US", 30.0), ("BR", 12.0), ("GB", 9.0), ("IN", 8.0), ("DE", 6.0), ("MX", 5.0), ("CA", 5.0), ("PH", 4.0), ("FR", 3.5), ("ID", 3.0)] {
			s.countries.push((code.into(), (w * scale * (0.8 + rnd() * 0.4)).round()));
		}
		s.countries_of = if p == "instagram" { "followers" } else { "views" };
		s.ages = ages(
			[("13-17", 6.0), ("18-24", 31.0), ("25-34", 34.0), ("35-44", 16.0), ("45-54", 8.0), ("55-64", 3.0), ("65-", 2.0)]
				.into_iter()
				.flat_map(|(a, v)| [(a.to_string(), "female".to_string(), v * 0.52), (a.to_string(), "male".to_string(), v * 0.45), (a.to_string(), "other".to_string(), v * 0.03)]),
		);
	}
	for i in 0..5 {
		let v = (scale * 6.0 * (1.0 - i as f64 * 0.15) * (0.8 + rnd() * 0.4)).round();
		s.top.push(json!({ "id": format!("demo-{i}"), "title": format!("Demo video {}", i + 1), "thumbnail": null, "permalink": null, "publishedAt": now_ms() - (i + 1) * 86_400_000 * 3, "views": v, "likes": (v * 0.07).round(), "comments": (v * 0.006).round(), "shares": (v * 0.01).round() }));
	}
	s.notes.push("Demo data: made up so you can try this page. Connect a real account to see your own numbers.".into());
	if p == "tiktok" {
		s.notes.push("Real TikTok accounts show followers, likes and recent video numbers; TikTok does not give apps audience countries.".into());
	}
}
