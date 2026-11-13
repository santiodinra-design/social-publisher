# Publisher for Windows (Rust)

A Windows build of Publisher, written in Rust. It shows the same React interface as the Mac app and keeps the same database, token format and HTTP contract, so the two behave alike. The Mac app (`desktop/`, `server/`, Electron) is not touched by anything in this folder.

## Build and run
Requirements: Windows 10 or 11 (x64), Node 22.13 or later, Rust (stable, MSVC toolchain) and the Microsoft C++ Build Tools. The Microsoft Edge WebView2 Runtime is part of Windows 11.

```
npm install
npm run windows:test     # 50 Rust tests, all against a local stand-in for the platform APIs
npm run windows:build    # builds the UI, then windows\target\release\Publisher.exe
npm run windows:run
```

On first launch choose **Start Fresh** (or start it with `--start-fresh` to skip the question). Demo mode is on, with simulated accounts that never post. `--import-from=<folder>` imports an older project folder, as on the Mac.

`Publisher.exe` is a single file with the interface built in. It can be copied anywhere and needs no Node, no ffprobe and no installer.

## One-click Connect for customers
Built as above, the app asks each user for their own developer keys. To give customers a plain **Connect** button instead, deploy the sign-in relay in `relay/` (a small Cloudflare Worker, see `relay/README.md`) and build its address into the app:

```
$env:PUBLISHER_RELAY_URL = "https://your-relay.example.com"
$env:PUBLISHER_RELAY_PLATFORMS = "youtube,instagram,tiktok"   # optional: only the platforms approved so far
npm run windows:build
```

- **Connect** opens the relay in the browser. The relay adds the client secret, sends the person to the platform's own sign-in page, and brings them back to the app on `127.0.0.1`. The app swaps the code for tokens through the relay and stores them encrypted on the PC, as before. The relay keeps no tokens.
- Accounts connected this way are marked `"via": "relay"` in their `meta`, so token refreshes and the TikTok revoke also go through the relay. Instagram tokens refresh directly, because that needs no secret.
- **Instagram:** Instagram Login can only publish a Reel from a public link. With no tunnel set, the app uploads the video to the relay's temporary storage in 50 MB parts, gives Instagram a signed link valid for 6 hours, and deletes the copy as soon as Instagram reports it has the video. The relay deletes anything left over after 24 hours.
- Developer keys saved in the app still win for their platform. **Use my own developer keys** at the bottom of Connected accounts shows them, so sandbox testing keeps working.
- `relayUrl` in `%APPDATA%\Publisher\settings.json` overrides the built-in address for one PC (`""` turns it off).

## Extras in the Windows app
The Windows backend lists these in `/api/config` under `features`. The shared interface only shows a feature that is listed, so the Mac app looks and works as before.
- **Stats** (`analytics`): followers, views, likes, comments, shares, watch time and saves, daily audience, audience countries, age and gender, and top posts, per account or all together. It needs the stats permissions, so accounts connected earlier are asked to reconnect. TikTok does not give apps audience countries or daily numbers.
- **Scheduled publishing** (`schedule`): pick a date and time in Create post. Publisher must be running then; it can stay in the notification area.
- **Notifications** (`notifications`): a Windows notification and a sound when a post finishes, with an on/off button in the sidebar.
- **I posted it** (`markPosted`): marks a TikTok inbox draft as posted, with an optional link.
- **Post again** (`repost`): copies a finished post from Post history into Create post.
- **Cover images** (`covers`): a YouTube thumbnail (needs a verified channel) and an Instagram cover. TikTok sets its cover in the app.
- **Click sounds**: the Ethereal Enchantment sounds, with a Sounds on/off button.

## How it is put together
| Part | Mac app | Windows app |
|---|---|---|
| Shell | Electron 45 (bundles Chromium and Node) | Tauri 2 on the WebView2 that Windows already has |
| API and worker | Fastify and a worker, in two Node child processes | axum and tokio tasks, inside the one app process |
| Store | `node:sqlite` | rusqlite with SQLite built in (same schema, WAL) |
| Platform calls | Node `fetch` | reqwest over the Windows TLS stack |
| Video facts | bundled `ffprobe` (one process per file) | a built-in MP4/MOV and WebM reader (`core/src/probe.rs`) |
| Key protection | macOS Keychain via Electron `safeStorage` | Windows DPAPI, tied to the signed-in Windows user |
| Data folder | `~/Library/Application Support/Publisher` | `%APPDATA%\Publisher` (same layout) |
| Stays running | window hides, Dock reopens, Cmd+Q asks | window hides to the notification area, tray icon reopens, tray **Quit Publisher** asks |

- `core/` is the backend as a library: `server.rs` (API and built UI), `jobs.rs` (queue), `runner.rs` (worker), `platforms/` (YouTube, Instagram, TikTok, demo), `keys.rs` (DPAPI and import), `probe.rs` (video reader). It has no dependency on the window toolkit, so its tests run headless.
- `app/` is the desktop shell: window, tray icon, dialogs, single-instance lock, startup and quit.

The interface reaches native features through the same `window.publisher` bridge the Mac preload provides (`pickVideo`, `openExternal`, `revealLogs`, `services`). Here it is a small script that calls the local server, which keeps the window free of any native IPC surface.

## Security, same rules as the Mac app
- The server listens on `127.0.0.1` only. Every `/api/*` call needs a per-launch cookie that only the app's window holds (HttpOnly, SameSite=Strict), plus the app's own header for anything that changes state. Password sign-in is disabled.
- The window collects its cookie through a one-use link at startup. The key is random, works once and is never logged.
- `keys.json` holds the two keys encrypted with DPAPI. If the database exists without it, the app refuses to start rather than create a replacement key.
- Tokens and platform keys are encrypted with AES-256-GCM in the same `v1.iv.tag.data` format as the Node server, so a database opens in either version with its key.
- The window only shows the app. Any other link opens in the default browser, and sign-in links are limited to the platforms' own hosts.
- Logs (`%APPDATA%\Publisher\logs\main.log`) have keys, tokens and codes removed, and rotate at 5 MB.

## What is faster or lighter than the Electron design
Measured on the development PC (Windows 11, release build):
- **Size:** one 15 MB executable. No bundled Chromium, Node or ffprobe.
- **Memory:** about 33 MB for the app process itself (the WebView2 processes are Windows' own, shared runtime).
- **Start:** the API and worker are ready about 20 ms after launch, before the window has finished opening.
- **Video facts:** read in about 0.05 ms per file, by parsing only the container's index. Nothing is spawned.
- **Choosing a video:** the native picker copies the file on disk in 4 MB blocks instead of sending it through a local HTTP request.
- **Publishing:** a new post wakes the worker at once instead of waiting for its next poll, and a free slot is refilled as soon as one destination finishes instead of waiting for the whole batch of three.
- **After a crash:** interrupted jobs resume as soon as the app starts (only one copy can run, so old leases are known to be dead) instead of after the 60-second lease runs out. They are still flagged to check with the platform first.

## Checked
- `npm run windows:test`: 50 of 50 pass, including scheduling, notifications, marking a TikTok draft posted, cover images and stats. They cover the reconcile safety rules ported from `tests/reconcile.test.ts`, the queue, the API lock-down, upload and demo publishing, key storage, opening a value encrypted by the Node server, and the relay flows (connect with PKCE, refresh, revoke, expired sign-in, Instagram through hosted storage).
- `npm run relay:test`: 15 of 15 pass for the relay itself (redirect safety, code exchange, error pass-through, signed media links with byte ranges, the 24-hour sweep, the public pages).
- With a relay address set, the release build's Connected accounts screen shows only **Connect** buttons, and Connect points at the relay with the app's port.
- Release build driven through its real window (WebView2 debugging port): bridge present, cookie not readable by the page, demo accounts added, a real MP4 uploaded through the page and previewed, a demo post published to all three destinations, history kept across launches.
- Force-kill mid-publish, then relaunch: all three interrupted jobs resumed and finished.
- A second launch does not start a second copy. With the key file missing and the database present, the app refuses to start and creates no key.

## Not checked yet
- The native file picker, the tray menu, the close-to-tray notice and the quit question were not exercised by automation. They need a person to click through them once.
- No real platform publish has been run, on either system. Sign-in and uploads to YouTube, Instagram and TikTok are tested only against a local stand-in.
- The relay has not been deployed. Its tests run in Node with an in-memory stand-in for R2, not on Cloudflare.
- No installer or code signing. Windows SmartScreen may warn about an unsigned `Publisher.exe` that was downloaded from elsewhere.
- Videos recorded sideways with a rotation flag are read by their stored size, as `ffprobe` 4.4 does on the Mac.
