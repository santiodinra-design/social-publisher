# Handoff

**Updated:** 2026-11-16 (branch `mac-parity`)
**Source:** this repository (owner's copy at `~/Projects/social-publisher`).
**Packaged app:** `~/Projects/social-publisher/release/mac-arm64/Publisher.app` (DMG: `release/Publisher-1.0.0-arm64.dmg`)
**App data:** `~/Library/Application Support/Publisher/` (database, videos, settings, Keychain-protected `keys.json`, logs)
**Git:** private GitHub repository `social-publisher`.

## Objective
A private Mac app that publishes one video to the owner's YouTube, Instagram Reels and TikTok, with reliable background jobs.

## Build and launch
- Build: `cd ~/Projects/social-publisher && npm run package` (optional DMG: `npm run package:dmg`)
- Launch: double-click `Publisher.app`, or drag it into Applications first. No Terminal, dev server or Node install needed.
- Development: `npm run dev` (browser, uses `.env`) or `npm run desktop:dev` (Electron, unpackaged).

## Latest (2026-11-16, branch `mac-parity`)
- **Real accounts connected.** Two YouTube accounts (Google Desktop-app client, test users) and two TikTok accounts (Sandbox app, both added as target users). Instagram is still being set up.
- **Several accounts per platform.** Sign-in always asks which account to use (Google `select_account`, TikTok `disable_auto_auth`, Instagram `force_reauth`). Connected accounts has an **Add another** button.
- **Account groups.** Saved sets of accounts (for example one YouTube, one TikTok and one Instagram) appear as one-click chips above Post to. They can be managed in Connected accounts and filtered in Stats. Stored in the `account_groups` table and served at `/api/groups`.
- **Quality checks.** Publisher never re-encodes. The composer warns about low resolution, bitrate or frame rate and adds platform tips (`src/quality.ts`).
- **Music copyright checks.** A Music picker (No music, Royalty-free, Popular song) adds per-platform warnings: a YouTube block risk over 60 s, Instagram muting, and a TikTok tip to add the song from Sounds in the inbox draft. No platform API can add its licensed music.
- **Instagram has three sign-in routes**, chosen in its setup panel: Facebook Login (works without a Business portfolio and needs a Facebook Page linked to each Instagram account), Unified login (`config_id`, needs a Business portfolio) and the older Instagram Login. The setup panel shows the full steps for each.
- **Public `/terms` and `/privacy` pages** are served by the app (TikTok and Meta require these links). Through the tunnel they are `<public address>/terms` and `/privacy`.
- **TikTok steps rewritten** for the real flow: Sandbox, Login Kit, Content Posting API, Display API (`video.list`), target users, then the Sandbox credentials.
- **Keychain:** after every rebuild macOS asks once for Keychain access. Choose **Always Allow**. The app retries for about 15 s if the Keychain is still waking up.
- **Drafts only (on by default).** TikTok always goes to the **inbox** and Instagram is refused (it has no drafts for apps). YouTube keeps the visibility chosen in the composer (Public by default) or the inbox JSON's `privacy` field. Enforced on the server in `asDraft()` in `server/app.ts`. Toggle: `DRAFTS_ONLY` setting.
- **TikTok captions.** TikTok's inbox (draft) API has no caption field, and Direct Post with a caption only works for audited apps or private accounts. So when a TikTok draft is sent, the finish notice carries the caption and the Mac app puts it on the clipboard (Universal Clipboard brings it to the iPhone). Post status rows also have a **Copy caption** button.
- **Inbox folder (Mac app).** `~/Movies/Publisher Inbox`. Drop `name.mp4`, then write `name.json` (`title`, `caption`, `group` or `accounts`, `madeForKids`). The API process (`server/inbox.ts`) sends it through the normal upload and publish routes, only to YouTube (Public unless `privacy` says otherwise) and the TikTok inbox, then moves the files to `Sent/` with a `.result.json`, or to `Needs attention/` with a `.error.txt`. The format is in the folder's `README.txt`. It is shown under Connected accounts → Automatic drafts and in Help → Reveal Inbox Folder. The owner's Claude sessions use it to hand over finished videos.
- **Tests:** 100 of 100 pass. Typecheck passes.
- **Still not done:** no real publish has been run on any platform yet, and Instagram is not connected.

## Earlier: Windows extras now work on the Mac (branch `mac-parity`)
Built on the Windows work (PR #1) plus the npm install fix (PR #2). The Node server and Electron shell now provide the features the Windows build added. See PROJECT.md, "Extras shared with the Windows build".
- **Features:** scheduled publishing, "I posted it" for TikTok inbox drafts, Post again, cover images (YouTube thumbnail, Instagram cover), Stats (a port of `analytics.rs`), macOS finish notifications with the finish sound, and the click sounds with on/off toggles.
- **Checks:** 76 of 76 tests pass (21 new). Typecheck passes. The packaged app was rebuilt and opened. All six features are listed, Stats shows demo numbers, and the composer shows Schedule and Thumbnail. A demo publish with a cover finished, and the finish notice reached the app.
- **Not checked:** whether the macOS notification banner appears on screen (no screen access), and a real Stats or cover call on any platform.
- **Reconnect needed:** Stats needs new read-only permissions (`yt-analytics.readonly`, `instagram_business_manage_insights`, TikTok `user.info.stats` and `video.list`), so existing accounts must reconnect before Stats works. TikTok developer apps must add these scopes.

## Done this pass
- **Desktop app.** Electron 45.3.2 with compiled backend and worker on Electron's Node 24.22.2. Supervised services with readiness waits and crash restarts, a single-instance lock, a loopback-only API with a per-launch cookie, Keychain-protected keys, and a free-port fallback.
- **Mac behaviour.** Closing the window hides it while jobs continue, the Dock reopens it, and Cmd+Q asks Keep Running or Quit and Resume Later when jobs are active. On quit, jobs are handed back to be checked first on the next launch.
- **Sign-in from the desktop.** Sign-in opens in the default browser with one-use server-side state plus PKCE. YouTube uses a Google **Desktop app** client (loopback redirect). Instagram and TikTok need the HTTPS tunnel address.
- **Desktop additions.** Native video picker, About panel with version, Help → Reveal Logs in Finder, and backend and worker status.
- **Recovery fix.** Status checks no longer need the local video. Only sending bytes does (`ctx.needFile()`), with a regression test.
- **Data import.** The existing project's data was imported into the app: 6 posts, 14 destinations, 3 accounts, 4 videos. The key check passed. `.env` and `data/` in the source folder were left untouched.

## Checks actually performed
- `npm test`: **55 of 55 pass**, including desktop auth, the OAuth handoff and the cleaned-up-video recovery. `npm run typecheck` (server, web, desktop): passes.
- **Packaged app**, launched from `release/Test Folder With Spaces/Publisher.app` with no dev servers running:
  - **Startup and isolation:** started its own API and worker. The renderer has no `require` or `process`.
  - **Upload and publish:** a video uploaded through the page's upload path, the bundled ffprobe read 1080×1920 and 0:06 (it also runs with an empty environment, so no PATH or Homebrew), the preview played, and a demo publish completed, including a simulated retry.
  - **Persistence:** history persisted across launches.
  - **Quit with pending jobs:** a quit with jobs pending was held back by the confirmation dialog.
  - **Force-kill recovery:** after a force-kill mid-job and a relaunch, both pending jobs resumed and finished.
  - **Window reopen:** the Dock or `open` reopened the window, still with a single process.
  - **Port conflict:** with 8787 taken, the app used a free port.
  - **API lockdown:** the API returns 401 without the app cookie, password login returns 403, and the server is not reachable from the LAN address.
  - **Missing key:** with the key file missing and the database present, the app refused to start and did not create a key.
  - **Missing credentials:** the setup guide shows Desktop-app steps, and trying to connect returns "not set up yet".
  - **Privacy:** the data and log folders are mode 700 and `keys.json` is 600. No tokens appear in the logs.
- **Not verified by automation** (screen control was declined): the red close button or Cmd+W hiding the window, clicking the quit dialog's buttons, and the native picker dialog itself.

## Windows port (branch `windows-port-rust`)
- **What it is.** A Rust build for Windows in `windows/`: a Tauri 2 window on WebView2, with the API, queue, worker and platform adapters ported to Rust and running inside the one process. Same UI, database schema, token format and HTTP contract. The Mac app's code is unchanged apart from four small wording changes in `src/` ("this Mac" reads "this PC" only inside the Windows app).
- **Build.** `npm run windows:build`, then `windows/target/release/Publisher.exe`. Tests: `npm run windows:test` (34 pass).
- **Checked on Windows 11.** Demo publish end to end in the real window, history across launches, force-kill recovery, single instance, missing-key refusal and API lock-down. Details and measurements are in `windows/README.md`.
- **Not checked.** The native file picker, tray menu and quit question (they need a person to click them), any real platform publish, and an installer or signing.
- **One-click Connect (Windows only, branch `hosted-sign-in`).** `relay/` is a Cloudflare Worker that holds the client secrets, owns the HTTPS redirect, hosts Instagram videos for minutes, and serves the Terms and Privacy pages. When the Windows app is built with `PUBLISHER_RELAY_URL`, customers just click Connect. The Mac server is unchanged: the shared Accounts page only switches to one-click mode when the backend reports `hosted`, which the Mac server never does. Setup steps are in `relay/README.md`. The relay is not deployed yet.
- **Note for the Mac side.** `npm install` fails on Windows on `main` because `@ffprobe-installer/darwin-arm64` is a required dev dependency. A separate small PR makes it optional.

## Remaining limitations
- **Signing:** the app is ad-hoc signed and `spctl` rejects it. It opens on this Mac. Other Macs need Developer ID signing and notarisation, which requires an Apple Developer account. A rebuild may trigger a Keychain prompt; choose Always Allow.
- **OAuth:** developer credentials are not confidential in a local app. Instagram and TikTok need a public HTTPS tunnel, and their redirect must match the port in use (8787 unless it was busy). TikTok public Direct Post is unavailable, so videos go to the TikTok inbox to finish by hand.
- **Publishing:** jobs stop while the app is quit or the Mac sleeps. **No real platform publish has been run.** Everything was tested in demo mode or against mocked APIs.

## Recommended next task
In the app, open Connected accounts, create a Google **Desktop app** OAuth client, paste its keys, connect, then run one owner-authorised **private** YouTube upload end to end.
