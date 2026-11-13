# Publisher

A private macOS app (Apple Silicon) for publishing one video to **YouTube**, **Instagram Reels** and **TikTok** from one screen. It runs background jobs that survive closing the window and recover after a crash.

Start with **HANDOFF.md** for current status and **PROJECT.md** for architecture, platform rules and setup. DESIGN.md and PRODUCT.md describe the UI direction.

## Run it on your Mac
Requirements: an Apple Silicon Mac, Node 22.13 or later, and Xcode Command Line Tools (for `codesign` and `iconutil`).

```bash
npm install
npm test            # 55 tests, all against mocked platform APIs
npm run package     # builds release/mac-arm64/Publisher.app (ad-hoc signed for this Mac)
open release/mac-arm64/Publisher.app
```

On first launch choose **Start Fresh**. Demo mode is on, with simulated accounts that never post. Your data lives in `~/Library/Application Support/Publisher` and the encryption key is kept in your Keychain.

To work on it without packaging, run `npm run dev`. That needs a `.env` copied from `.env.example`, with `APP_PASSWORD`, `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` filled in (or `NO_SIGN_IN=true` for local-only testing). Then open http://localhost:5173.

## Run it on Windows
There is also a Windows build written in Rust, in `windows/`. It uses the same interface and the same data format, and needs no Node at run time.

```bash
npm install
npm run windows:test    # 34 Rust tests
npm run windows:build   # builds windows/target/release/Publisher.exe
npm run windows:run
```

Requirements, design and what has been checked are in **windows/README.md**. To let customers connect with one click, deploy the sign-in relay and submit the platform applications: both are explained step by step in **relay/README.md**. Its data lives in `%APPDATA%\Publisher` and the encryption key is protected by Windows (DPAPI) for your Windows user.

## Ground rules
- Use **your own** developer keys (Google Desktop app OAuth client, Meta app, TikTok app), entered in the app. Never commit keys, `.env`, `data/` or videos (`.gitignore` covers them).
- No real post goes out without the account owner's explicit go-ahead. Test with demo accounts or a **private** YouTube upload.
- No password collection, browser automation or private APIs to get around platform limits. TikTok sends videos to your inbox to finish by hand, and Instagram needs a public HTTPS tunnel.
