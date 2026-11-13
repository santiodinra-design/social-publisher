# Publisher sign-in relay

A small Cloudflare Worker that lets customers connect YouTube, Instagram and TikTok with one click. Without it, every customer would have to create developer apps and run a tunnel.

## What it does
- **Holds the secrets.** The client secrets of your Google, Meta and TikTok apps live here as Worker secrets. They never ship inside the app.
- **Owns the redirect address.** Each platform sends the browser back to `https://<relay>/callback/<platform>`. The relay forwards the code to the Publisher app on the customer's PC (`http://127.0.0.1:<port>`, and nowhere else). The app then swaps the code for tokens through `/token/<platform>`.
- **Renews sign-ins.** `/refresh/youtube` and `/refresh/tiktok` add the secret to token refreshes. `/revoke/tiktok` does the same for disconnects.
- **Hosts Instagram videos briefly.** Instagram Login can only publish a Reel from a public URL. The app uploads the video to R2, Instagram downloads it from a signed link (valid 6 hours), and the app deletes it. An hourly cron removes anything older than 24 hours. Only someone holding a working Instagram token can upload.
- **Serves the public pages** the platform reviews ask for: `/` (home), `/terms` and `/privacy`.

It keeps no database and stores no tokens. Platform errors are passed through unchanged, so the app can tell an expired sign-in from an outage.

## Set it up
You need a Cloudflare account. The free plan covers the Worker. R2 has a free tier, but Cloudflare asks for a payment method before enabling it.

1. Sign in, and create the video bucket. Run this from the repository root:
   ```
   npx wrangler login
   npx wrangler r2 bucket create publisher-media
   ```
2. Fill in the `[vars]` in `relay/wrangler.toml`:
   - `OPERATOR_NAME` and `CONTACT_EMAIL`, which are shown on the Terms and Privacy pages.
   - `GOOGLE_CLIENT_ID`, `TIKTOK_CLIENT_KEY` and `INSTAGRAM_APP_ID`.
3. Add the secrets. Each command prompts for the value, so nothing is saved in a file.
   ```
   npx wrangler secret put GOOGLE_CLIENT_SECRET --config relay/wrangler.toml
   npx wrangler secret put TIKTOK_CLIENT_SECRET --config relay/wrangler.toml
   npx wrangler secret put INSTAGRAM_APP_SECRET --config relay/wrangler.toml
   npx wrangler secret put SIGNING_KEY --config relay/wrangler.toml
   ```
   `SIGNING_KEY` is any long random value, for example from `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
4. Deploy: `npm run relay:deploy`. It prints the address, for example `https://publisher-relay.<you>.workers.dev`.
   - Google verification needs the home and privacy pages on a domain you own and have verified. Add a custom domain to the Worker in the Cloudflare dashboard (Workers → publisher-relay → Settings → Domains), then use that address everywhere below.
5. Check it: open `https://<relay>/health`. Each platform with its keys set shows `true`.
6. Register the redirect address in each platform:
   - **Google Cloud:** create an OAuth client of type **Web application**. Add `https://<relay>/callback/youtube` as an authorized redirect URI. Enable the YouTube Data API v3.
   - **Meta (Instagram API with Instagram login):** in Business login settings, add `https://<relay>/callback/instagram` as the OAuth redirect URI.
   - **TikTok (Login Kit):** add `https://<relay>/callback/tiktok` as a redirect URI.
7. Build the app with the relay in it:
   ```
   $env:PUBLISHER_RELAY_URL = "https://<relay>"
   npm run windows:build
   ```
   `PUBLISHER_RELAY_PLATFORMS` (for example `youtube`) limits one-click Connect to the platforms that are approved so far. The rest still accept developer keys.

## Reviews before strangers can connect
Until each review passes, only accounts you add as testers can connect.
- **Google:** OAuth consent screen verification for the `youtube.upload` scope (sensitive). It needs the home and privacy pages on your verified domain and a demo video. Ask for a YouTube API quota increase too: by default `videos.insert` allows 100 uploads a day, shared by all your customers.
- **Meta:** App Review for `instagram_business_basic` and `instagram_business_content_publish`, plus business verification. Customers need a Professional (Business or Creator) Instagram account.
- **TikTok:** app review for Login Kit (`user.info.basic`) and Content Posting API (`video.upload`). Videos go to the customer's TikTok inbox as drafts. Posting directly needs a further audit.

Use `https://<relay>/terms` and `https://<relay>/privacy` in each form. Have the wording checked for your situation before you rely on it.

## Submitting the platform applications
Only the app's owner applies, once per platform. Customers never apply to anything: they click Connect and sign in.

Do these first, on every platform:
1. Deploy the relay (above) and open `https://<relay>/health`.
2. Check that `/`, `/terms` and `/privacy` load from a normal browser.
3. Add your own social accounts as test users, so you can record the demo videos before approval.

### TikTok (developers.tiktok.com → your app → App review)
- **Products:** Login Kit, Content Posting API and Display API.
- **Scopes:** `user.info.basic`, `user.info.stats`, `video.list` and `video.upload`.
- **Platforms:** tick **Desktop**. Under Login Kit, add the redirect URI `https://<relay>/callback/tiktok`.
- **Terms of Service URL:** `https://<relay>/terms`. **Privacy Policy URL:** `https://<relay>/privacy`.
- **Description** (120 characters max):
  > Desktop app that uploads a creator's own videos to their TikTok inbox as drafts, which they finish and post in TikTok.
- **Explain how each product and scope is used** (paste and adjust):
  > Publisher is a desktop app (Windows) that creators use to send one video to their own social media accounts.
  >
  > Login Kit / user.info.basic: the creator signs in through TikTok's official login page in their browser. The app reads open_id, display name and avatar only to show which account is connected. It never sees the password.
  >
  > Content Posting API / video.upload: when the creator clicks Publish, the app uploads the video file in chunks (FILE_UPLOAD) through /v2/post/publish/inbox/video/init/, then checks /v2/post/publish/status/fetch/ until TikTok reports SEND_TO_USER_INBOX. The video arrives as a draft in the creator's TikTok inbox, and they finish the caption and post it in the TikTok app. The app never posts directly and does not request video.publish.
  >
  > Login Kit / user.info.stats and Display API / video.list: the app's Stats page shows the creator their own follower count and total likes, and the views, likes, comments and shares of their recent videos. Nothing is shared with anyone else.
  >
  > Tokens are stored encrypted on the creator's computer.
- **Demo video:** record the screen with OBS or Win+Alt+R and save it as an MP4 under 50 MB. Use the **Sandbox** of the app with your own TikTok account added as a target user. Show, in one take:
  1. Opening Publisher and going to Connected accounts.
  2. Clicking **Connect** next to TikTok.
  3. The TikTok login and permission screen in the browser, and returning to the app.
  4. Choosing a video, ticking TikTok, and clicking **Publish**.
  5. The result "Sent to your TikTok inbox".
  6. The draft arriving in the TikTok app on your phone.

### Google (console.cloud.google.com)
- **APIs:** enable YouTube Data API v3.
- **OAuth client:** type **Web application**, with the redirect URI `https://<relay>/callback/youtube`.
- **OAuth consent screen:** add the app name, logo, home page `https://<relay>/` and privacy policy `https://<relay>/privacy`. Both pages must be on a domain you verified in Google Search Console, so use the relay's custom domain.
- **Scopes:** `youtube.upload`, `youtube.readonly` and `yt-analytics.readonly`. Enable the YouTube Analytics API too.
- **Verification:** under Audience, click **Publish app**, then submit for verification. Google asks for a demo video showing the consent screen and the upload, and a short reason for each scope: "upload the user's own videos to their channel" and "show which channel is connected and the upload's processing status" and "show the channel owner their own views, likes and audience countries on the Stats page".
- **Quota:** in the YouTube API Services form, ask for more `videos.insert` quota. The default is 100 uploads a day, shared by all customers.

### Meta (developers.facebook.com)
- **App type:** Business. Use case **Manage messaging & content on Instagram**, with **API setup with Instagram login**.
- **Business login settings:** add the redirect URI `https://<relay>/callback/instagram`.
- **Settings → Basic:** add the privacy policy and terms URLs, an app icon, and a category.
- **Business verification:** complete it under Business Settings → Security Center. App Review needs it.
- **App Review:** request **Advanced Access** for `instagram_business_basic`, `instagram_business_content_publish` and `instagram_business_manage_insights` (the Stats page: the account's own views, likes, shares and follower countries).
  - Explain that the app publishes Reels the user chose to the user's own Professional account, and reads the account name and picture to show which account is connected.
  - Record a demo with an Instagram tester account. Show Connect, the Instagram login, choosing a video, Publish, and the Reel live on the profile.
- **Customers:** they need a Professional (Business or Creator) Instagram account. Switching is free in the Instagram app's settings.

After each approval, nothing changes in the app. Customers can simply connect.

## Safety notes
- Codes are forwarded only to `127.0.0.1`. The port and the app's one-use state ride inside the platform's `state`, which the app checks.
- YouTube sign-in uses PKCE end to end, so an intercepted code is useless without the app's verifier.
- Add a Cloudflare rate-limiting rule on `/token/*`, `/refresh/*` and `/media` once real traffic starts.
- Errors are logged by name only, never with request details, so tokens do not end up in Cloudflare logs.

## Test
`npm run relay:test` runs the relay in Node against an in-memory R2 stand-in and stubbed platforms. Nothing leaves the machine.
