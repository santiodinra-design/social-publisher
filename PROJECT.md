# Publisher: project brief

## Purpose and scope
A private, single-user web app to publish one video to the owner's own TikTok, Instagram and YouTube accounts from one place: connect accounts, drop in a video, write captions, choose destinations, publish, and follow each destination's status.

**In scope (v1):** video only; TikTok, Instagram Reels, YouTube (including Shorts-shaped videos); immediate publishing; post history; account connect, reconnect and disconnect; demo mode.
**Out of scope (v1):** images and documents, scheduling, analytics, AI captions, teams, subscriptions, editing tools, public deployment.

## Confirmed requirements
- Three sections: **Create post** (default), **Post history**, **Connected accounts**.
- Official OAuth only. The app never asks for or stores social media passwords.
- Tokens live only on the server, encrypted at rest (AES-256-GCM), never sent to the browser or written to logs.
- Persistent background jobs: publishing continues after the page is closed and resumes after a restart.
- Each destination is tracked on its own. States: `queued`, `uploading`, `processing`, `published`, `failed`, `needs_attention`.
- Success is only reported after the platform confirms it.
- Repeated clicks cannot create a second post record (client idempotency key, unique in the database; a restored draft reuses its key). This prevents duplicates inside the app; it cannot stop a duplicate on a platform whose API offers no way to check, so unclear outcomes are handed to the owner instead of retried blindly.
- Transient failures retry with bounded exponential backoff (5 attempts, at most 15 minutes apart).
- An attempt whose outcome is unknown is reconciled with the platform before any retry. A failed, timed-out, refused or unauthorised status lookup is **never** treated as proof that the upload failed: provider IDs and the "outcome unknown" flag are kept, the check is retried with backoff, and after the attempt limit the destination moves to `needs_attention` with where to look. A fresh upload starts only on platform evidence (see "Reconcile rules").
- Only failed destinations are retried.
- Uploaded videos are deleted after a retention period once every destination is finished (default 72 h).
- Demo mode is clearly labelled, kept apart from real accounts, and never shows a simulated post as real or with a link.
- Design: based on the owner's Ethereal Enchantment app (charcoal, slim sidebar, compact rows, hairline borders), but plainer and without the blue. One ember accent (#ff6b3d) for primary actions; other colour is used only for status. See DESIGN.md.

## Assumptions
- One owner, running it locally or on a private machine. Access is protected by a password (`APP_PASSWORD`) and a signed, httpOnly session cookie, with a CSRF header check on state-changing requests.
- TikTok defaults to **Send to TikTok inbox — finish posting in TikTok** (the `video.upload` inbox flow) because Direct Post is not available to this use case (see below).
- YouTube: a vertical or square video of 3 minutes or less becomes a Short automatically. No `#Shorts` tag is needed.

## Architecture
| Part | Choice | Why |
|---|---|---|
| UI | React 19 + Vite, plain CSS tokens | Small, fast, no UI framework to fight |
| API | Fastify 5 (`server/app.ts`) | Streams large uploads straight to disk |
| Worker | Separate Node process (`server/worker.ts`) | Publishing survives page closes and API restarts |
| Store | SQLite via built-in `node:sqlite` (WAL) | Persistent queue with no extra services or native builds |
| Media facts | `ffprobe` | Real duration, size, codec and dimensions for validation |

**Queue:** `targets` rows are claimed with a lease (`lease_owner`, `lease_until`, 60 s, kept alive by heartbeat). A lease that expires mid-step means the worker died, so the row is picked up again and flagged `uncertain`. Before continuing, the adapter's `reconcile()` asks the platform what actually happened.

**Reconcile rules** (`server/runner.ts`, each adapter's `reconcile()`):
| Platform | Restart only when | Otherwise |
|---|---|---|
| YouTube | No upload session was stored, or the session expired **before** the last part was sent (`finalSent` is recorded before that request). | Keep the session; a finished session returns the video ID. Session gone after the last part → `needs_attention` ("check YouTube Studio"). |
| Instagram | No container was stored (a Reel only goes live via `media_publish` with one), or the container is `ERROR`/`EXPIRED`. | `FINISHED` → publish the same container again (one container can only become one Reel). `PUBLISHED` → match exactly one recent Reel by caption and time; several identical captions → `needs_attention`, none yet → check again later. |
| TikTok | No publish ID was stored, or TikTok still reports `PROCESSING_UPLOAD` and the last part was never sent. | Keep polling the same publish ID; last part sent but not acknowledged → wait and check again. |

`RejectedError` marks a failure the platform itself confirmed (rejected or failed processing), which clears provider references so a later retry may upload afresh. Any other permanent error during a check becomes `needs_attention`.

**Worker health:** the worker writes a heartbeat to `worker_status` every 10 s on its own timer; `/api/status` reports `running`, `stale` (no beat for 45 s) or `never`. The web server answering is not taken as proof the worker runs.

**Drafts:** the composer saves caption, chosen destinations, platform fields, the server media ID and the idempotency key to `localStorage` (`sp.draft.v1`). No tokens or keys. Restoring only fills the form; if the video was cleaned up, the text is kept and the owner is asked to upload again.

**Adapter interface** (`server/platforms/types.ts`): `availability`, `validateSettings`, `authorizeUrl`, `exchangeCode`, `refresh`, `identity`, `revoke`, `run`, `reconcile`. Errors are typed: `TransientError` (retry), `AuthError` (reconnect), `AttentionError` (user action), `PermanentError` (fail, or `needs_attention` if the outcome may be unknown), `RejectedError` (platform-confirmed failure). Provider checkpoints (publish id, container id, resumable session URL) are saved in `provider_ref` as soon as they exist.

## Desktop app (macOS, Apple Silicon)
**Runtime.** Electron 45.3.2 (Chromium 156, Node 24.22.2). The backend TypeScript is compiled with esbuild into `dist-desktop/` and runs on Electron's own Node in two `utilityProcess` children, so no system Node is needed. `node:sqlite` was checked inside Electron's runtime. Main process: `desktop/main.ts`. Keys and import: `desktop/keys.ts`. Bridge: `desktop/preload.ts`. Service entries: `desktop/*-entry.mjs`.

**Data.** Everything the user owns lives in `~/Library/Application Support/Publisher/` (folders mode 700): `data/app.db` and `data/media/`, `settings.json` (non-secret: demo mode, retention, public URL), `keys.json` (mode 600) and `logs/` (`main.log`, `api.log`, `worker.log`, secrets redacted, rotated at 5 MB). Replacing the .app never touches this folder.

**Keys.** `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` are encrypted with Electron `safeStorage`'s async API (the sync API is deprecated in Electron 45), which is backed by the macOS Keychain item "Publisher Safe Storage". If the database exists without `keys.json`, the app refuses to start rather than generate a replacement key. A Keychain failure produces an explicit error; nothing is deleted.

**Import.** On first launch the app offers to import an older project folder (or `--import-from=<folder>`). It takes a consistent SQLite snapshot with `VACUUM INTO`, runs an integrity check, proves the old `.env` key decrypts stored values, copies the videos, then stores the key in the Keychain. The source folder is never modified. A report is written to `import-report.json`.

**Services.** The API binds to `127.0.0.1` on port 8787, or on any free port if 8787 is taken (logged). Secrets reach the services over the private `parentPort` message, not argv. The main process waits for each service's `ready` message (30 s limit), restarts crashed services with backoff, and after repeated crashes offers Reveal Logs, Try Again or Quit. A single-instance lock prevents competing workers, and the job leases still guard the queue.

**Auth.** Each launch creates a random token that the main process places as an httpOnly, SameSite=Strict cookie in its own window's session. The API rejects every `/api/*` call without it (loopback is not trusted), and password login is disabled in desktop mode. The open routes are the static UI, `/api/session`, signed `/m/` media links and OAuth callbacks (validated by one-use server-side state plus PKCE).

**Window and quit.** Closing the window hides it while jobs continue, the Dock icon reopens it, and Cmd+Q quits. If jobs are active, the app asks "Keep Running" or "Quit and Resume Later". On quit the worker hands its jobs back marked "check with the platform first", and they resume on the next launch. Jobs do not run while the app is quit or the Mac is asleep.

**Renderer security.** `contextIsolation`, `sandbox`, no `nodeIntegration`, no webview, DevTools off in packaged builds, permission requests denied, navigation locked to the app origin, and new windows denied (https links open in the default browser). The preload exposes only `pickVideo`, `openExternal` (sign-in hosts only), `revealLogs` and `services`. IPC checks that the sender is the app window on the app origin.

**OAuth from the desktop.** Sign-in opens in the default browser. YouTube uses a Google **Desktop app** OAuth client: Google accepts loopback redirects on any port, so `http://127.0.0.1:<port>/api/oauth/youtube/callback` works. Instagram and TikTok require registered HTTPS redirects, so they use `PUBLIC_BASE_URL` (a tunnel) when it is set. The callback page tells the user to return to the app, and the Accounts page refreshes on focus. Developer credentials in a locally distributed desktop app are **not confidential**. Google says this about Desktop client secrets, and the same holds for any key pasted into a local app. Keys are stored encrypted on this Mac, but each person should use their own developer app.

**ffprobe.** The unmodified FFmpeg n4.4.1 `ffprobe` (LGPL build) from `@ffprobe-installer/darwin-arm64` 5.0.1 ships at `Contents/Resources/bin/ffprobe`, with notices in `Contents/Resources/licenses/ffprobe/` (`NOTICE.txt`, `COPYING.LGPLv2.1`, `FFMPEG-LICENSE.md`). The path is passed explicitly; PATH and Homebrew are not used.

**Build.**
- `npm run package`: UI build, desktop compile, `electron-builder --mac dir --arm64`, then ad-hoc signing (`scripts/sign-adhoc.sh`). Output: `release/mac-arm64/Publisher.app`.
- `npm run package:dmg`: also builds `release/Publisher-1.0.0-arm64.dmg`.
- `npm run desktop:dev`: runs unpackaged in Electron.
- `npm run icon`: regenerates `build/icon.icns`.
- Bundle ID `local.socialpublisher.publisher`, product name **Publisher**, version 1.0.0, macOS 12 or later.

**Signing.** No Developer ID identity exists on this Mac, so the app is **ad-hoc signed** for local testing only. `spctl` rejects it, and that is expected. It opens on this Mac. A copy downloaded or moved to another Mac will be blocked by Gatekeeper until it is signed with a Developer ID and notarised, which needs an Apple Developer account. Gatekeeper was not disabled. Because ad-hoc signatures change on every rebuild, macOS may ask again for Keychain access to "Publisher Safe Storage" after a rebuild. Choose Always Allow.

## Extras shared with the Windows build (Mac support added 15 Nov 2026)
The Windows app (`windows/`, Rust) added extras to the shared interface. The UI shows each one only when the backend lists it in `/api/config` → `features`. The Node server behind the Mac app now provides the same HTTP contract:

| Feature | Node implementation | Endpoints |
|---|---|---|
| `schedule` | `posts.scheduled_at`. Targets wait in the queue until then (60 days at most, at least 1 minute ahead). Only destinations that have not started can move or be cancelled. | `scheduledAt` on `POST /api/posts`, `POST /api/posts/:id/schedule`, `POST /api/posts/:id/cancel` |
| `markPosted` | A TikTok inbox draft (`needs_attention`) can be marked published, with an optional `https://*.tiktok.com` link. | `POST /api/targets/:id/posted` |
| `repost` | Interface only. It uses `media.id` and each target's `accountId` from the post view. | — |
| `covers` | `server/covers.ts`: JPEG or PNG up to 8 MB, checked by its bytes. A YouTube thumbnail (2 MB at most, verified channels only, best effort and never fails the video) and an Instagram `cover_url` (JPEG only). TikTok sets its cover in the app. | `PUT /api/covers`, `GET /api/covers/:id` |
| `analytics` | `server/analytics.ts`, a port of `windows/core/src/analytics.rs` (10-minute cache, demo accounts get made-up numbers). It needs extra read-only permissions: YouTube `yt-analytics.readonly`, Instagram `instagram_business_manage_insights`, TikTok `user.info.stats` and `video.list`. Accounts connected before this are asked to reconnect. | `GET /api/analytics?days=&account=&fresh=1` |
| `notifications` (desktop only) | `server/notify.ts` summarises a finished post once (`posts.notified_at`). The worker sends it to the Electron main process, which shows a macOS notification and has the page play the finish sound. The setting is `NOTIFY` in app settings. | `GET/PUT /api/desktop/prefs` |

Click sounds (`src/sounds.ts`, synthesized with Web Audio) are on in both desktop apps, with a Sounds on/off button, and silent in a plain browser. The hosted sign-in relay (`relay/`) is used only by the Windows build; the Mac app keeps using the owner's own developer keys.

## Platform constraints (checked 13 Nov 2026)
**TikTok, Content Posting API.** [Get started](https://developers.tiktok.com/docs/en/content-posting-api-get-started) · [Sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) · [Upload](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video)
- Direct Post (`video.publish`) from an unaudited app is limited to private accounts, `SELF_ONLY` visibility and 5 users a day. The guidelines list "a utility tool that uploads content to accounts that you or your team manage" as not eligible for the audit. **So public direct posting is unavailable for this app.**
- The supported alternative, used by default, is Upload (`video.upload`). The video is sent to the creator's TikTok inbox, and the creator finishes and posts it in the TikTok app. The app shows this as **Needs attention: finish in TikTok**, never as published. Limits are 5 pending shares per 24 h and 6 requests per minute per token.
- Chunked `FILE_UPLOAD`: chunks of 5–64 MB, with the final chunk up to 128 MB. The upload URL is valid for 1 hour.
- `TIKTOK_DIRECT_POST_ENABLED=true` turns on the Direct Post code path, which checks `creator_info` first. Only use it if TikTok approves the app.

**Instagram, Instagram API with Instagram Login.** [Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
- Requires a Professional (Business or Creator) account and the scopes `instagram_business_basic` and `instagram_business_content_publish`.
- Reels are created from a **public `video_url`**. Resumable direct upload (`rupload`) is documented only for the Facebook Login path, so the app serves each video at a signed URL under `PUBLIC_BASE_URL` that expires after 6 hours.
- The flow is: create container (`media_type=REELS`) → poll `status_code` until `FINISHED` → `media_publish` → fetch `permalink`. The publishing limit is checked through `content_publishing_limit`. Meta's docs give 50 and 100 posts per 24 h in different places.
- Tokens are long-lived (60 days) and refreshed automatically once they are over 24 hours old.
- Without App Review, only accounts with a role on the Meta app (yours) can connect. That is fine for personal use.

**YouTube, Data API v3.** [Resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) · [Revision history](https://developers.google.com/youtube/data/revision_history)
- Uses `youtube.upload` and `youtube.readonly`, with resumable `videos.insert`. Visibility and "made for kids" are always sent explicitly.
- Since 2 Nov 2026, uploads from unverified projects are **no longer forced to private** (this reverses the July 2020 rule). Some older doc pages still say otherwise.
- Since 1 Jun 2026, `videos.insert` has its own quota bucket (100 calls a day by default).
- While the OAuth consent screen is in "Testing", Google expires refresh tokens after 7 days. Publish the consent screen (no verification is needed for your own use) to avoid weekly reconnects.

## External setup the owner must do
Platform keys are entered **in the app** (Connected accounts). Each platform has a short guide with direct links, the exact redirect address with a Copy button, and fields for the keys. Keys are stored encrypted in SQLite (`app_settings`), apply without a restart, override `.env`, and are never sent back to the browser (only a masked ID is shown).

1. **Secrets.** Copy `.env.example` to `.env`, then set `APP_PASSWORD`, `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`. `NO_SIGN_IN=true` skips the password for local testing only; set it to `false` **before** sharing the app, opening it to your network or starting a tunnel (the Instagram step below needs one).
2. **YouTube.** In Google Cloud, create a project, enable the YouTube Data API v3, configure the OAuth consent screen (External, add yourself as a test user, then publish it), and create an OAuth client of type Web application with redirect URI `{APP_URL}/api/oauth/youtube/callback`. Paste the Client ID and secret in the app.
3. **Instagram.** Make the Instagram account Professional. In Meta for Developers, create an app with the use case "Manage messaging & content on Instagram" (Instagram API with Instagram Login), add your Instagram account as an Instagram Tester and accept the invite, and set the OAuth redirect URI to `{APP_URL}/api/oauth/instagram/callback`. Paste the Instagram app ID and secret in the app. Finally, expose the app over HTTPS (for example `cloudflared tunnel --url http://localhost:8787`) and paste that address in the app (or set `PUBLIC_BASE_URL`).
4. **TikTok.** In TikTok for Developers, create an app, add Login Kit and the Content Posting API, request the scopes `user.info.basic`, `user.info.stats`, `video.list` and `video.upload`, and set the redirect URI to `{APP_URL}/api/oauth/tiktok/callback`. TikTok requires redirect URIs to be HTTPS on a registered domain, so local `http://localhost` callbacks may be refused, and you may need the tunnel URL as `APP_URL`. Then paste the client key and secret in the app, and submit the app for review if TikTok requires it for `video.upload`.

## Acceptance criteria
- [x] Create post is the default screen, with a drag-and-drop or file picker upload, preview, filename, duration and upload progress.
- [x] Destination toggles show each account's name. There is a shared caption with per-platform overrides, a YouTube title and description, and platform settings.
- [x] Validation messages appear beside the relevant field, on both client and server.
- [x] Each destination has its own upload, processing and published progress, with links once confirmed.
- [x] OAuth connect, reconnect, disconnect (with revoke) and token refresh, with clear errors when sign-in fails.
- [x] Platform keys can be pasted in the app, with guided steps; no file editing or restart needed.
- [x] Persistent jobs survive page closes and process restarts, and reconcile before retrying.
- [x] Duplicate submits are prevented, transient failures retry with bounded backoff, and only failed destinations are retried.
- [x] Demo mode is separate, labelled, and never shows links or claims real success.
- [x] Lost responses and failed status checks never start a second upload or publish (regression tests in `tests/reconcile.test.ts`).
- [x] Readiness checklist before publishing; Publish stays disabled while anything blocks, and live checks are labelled as such.
- [x] Drafts survive refreshes without storing credentials, and cannot republish.
- [x] One result row per destination with an accurate status, explanation, confirmed link and a safe next step.
- [x] Worker status from its own heartbeat, and a persistent notice while sign-in is off.
- [x] Packaged macOS app (Apple Silicon) that starts its own backend and worker, keeps data in Application Support, protects keys with the Keychain, and recovers interrupted jobs on relaunch.
- [x] Status checks work after the local video is cleaned up; the file is required only to send bytes.
- [ ] Real end-to-end publish to each platform. Blocked on credentials and setup; not run.
