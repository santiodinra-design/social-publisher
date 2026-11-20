# Windows version: what changed (2026-11-20, on top of `mac-parity` 7c18a54)

The Rust Windows port in `windows/` already ran, but it was written before the Mac app gained
several features. Those features are now in the Windows backend too, so both apps behave alike.

## Added to the Windows app
- **Drafts only, on by default.** TikTok always goes to the inbox, Instagram is refused with the same message as the Mac, and YouTube keeps the visibility chosen. The toggle at the top of the window works (`/api/desktop/prefs`).
- **Account groups.** `/api/groups` (list, create, rename, delete) on the same `account_groups` table as the Mac, so the chips above Post to and the manager in Connected accounts work.
- **Inbox folder.** `%USERPROFILE%\Videos\Publisher Inbox` (the Mac uses `~/Movies/Publisher Inbox`), with the same JSON format and README. Sent drops move to `Sent` with a `.result.json`. Problems move to `Needs attention` with an `.error.txt`. It is shown under Connected accounts, and the tray menu has **Show Inbox Folder in Explorer**.
- **TikTok caption on the clipboard.** When a TikTok draft finishes, the notification says "Caption copied" and the caption is on the Windows clipboard.
- **Accounts page parity:** Google always shows its account chooser, TikTok asks which account (`disable_auto_auth`) and Instagram forces sign-in (`force_reauth`), so a second account can be added. A cancelled sign-in is explained in plain words. Instagram's three sign-in routes (Instagram Login, Facebook Login, Unified login with a configuration ID) are saved and used, and one Facebook sign-in can connect several Instagram accounts.
- **Public `/terms` and `/privacy` pages** for the developer consoles. The privacy text says Windows protects the key, not the Keychain.

## Phone use (Android and iPhone)
Pair a phone with a QR code under **Connected accounts → Phone access**, then post from the phone while the computer publishes. Works on both the Windows and the Mac app. Details, setup and safety notes: `PHONE-ACCESS.md`.

## Fixed along the way
- **Security (Mac server):** `/%61pi/accounts` skipped the sign-in check and returned the account list. That was reachable through the tunnel. Fixed in `server/app.ts` (`routedPath`), with tests.
- The inbox panel text said YouTube goes up Private. It now says what actually happens (the visibility in the caption file, Public if none). This also fixes the Mac app's text.
- The README now says the build needs the **MSVC** Rust toolchain. The GNU toolchain fails on `windows-sys`.

## Checks run
- `npm run windows:test`: **55 of 55** pass (phone access adds 2). That is the earlier 50 plus 3 new ones in `windows/core/tests/mac_parity.rs`, covering drafts only, groups, Instagram routes, the cancelled sign-in and the inbox folder (sent, bad JSON, blank account name).
- `npm test`: 103 of 103 pass (phone access adds 3). `npm run typecheck` passes.
- `npm run windows:build` gives `windows/target/release/Publisher.exe` (16 MB, a GUI exe with no console window).
- The release exe was launched with a separate test data folder. It started the API, worker and inbox watcher, the window opened on WebView2, `/terms` and `/privacy` answered 200, and the API answered 401 without the app's cookie. A drop in the inbox with no real accounts connected went to `Needs attention` with "No connected YouTube or TikTok account to send it to."
- Codex reviewed the diff and found four issues: the clipboard owner window, blank inbox account names meaning "all", a drop whose files cannot be moved being sent again, and the Facebook-route Instagram stats ID. All four are fixed and retested.

- **Owner's must-haves, re-checked on the final exe (2026-11-20):**
  - Crash recovery: force-killed right after a post was created; on relaunch the log said "found 2 job(s) interrupted last time", both were checked with the platform first, then resumed and finished.
  - Window close: clicking ✕ while a post was publishing hid the window, showed the "still running in the notification area" notice, and the post finished with the window hidden. Clicking the tray icon brought the window back with the draft intact.
- **Clicked through by hand (computer use):** the native "Choose a video" picker (copied a clip in, preview and quality checks shown), creating an account group and selecting it from its chip, switching Drafts only off and on, and Phone access (Turn on, Pair a phone, QR code shown).

## Not checked
- The tray's right-click menu (Show Logs, About, Quit and its question): the taskbar only allowed left-clicks in this session. The clipboard copy was not run either, because it needs a real (not demo) TikTok draft to finish.
- A real phone scanning the QR code. Pairing and posting were tested with a phone-sized browser over the Wi-Fi address, not on an actual iPhone or Android phone.
- The Mac app was not rebuilt (that needs a Mac). Its server changes are covered by `npm test` and the typecheck.
- Any real platform sign-in or publish, including the Facebook and Unified Instagram routes, which were only checked as far as building their sign-in links.
- No installer or code signing yet. SmartScreen may warn about a downloaded `Publisher.exe`.

## Keys
No secrets are in the code. Create your own YouTube, TikTok and Instagram developer apps and paste their keys in **Connected accounts** (or use `.env` for `npm run dev`, from `.env.example`).
