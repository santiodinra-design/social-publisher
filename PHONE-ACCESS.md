# Using Publisher from a phone (Android and iPhone)

Publisher stays a computer app: the Windows or Mac app keeps uploading and publishing, and jobs keep
running when the window is closed. A phone is a remote for it. Pick a video from the camera roll,
write the caption, choose accounts and post. Then watch it finish in Post history.

This works the same on Android and iPhone, in the phone's own browser, with no app store, Xcode or
Android Studio. Added to the home screen, it opens full screen like an app.

## Set up (once per phone)
1. On the computer: **Connected accounts → Phone access → Turn on**.
   - Windows may ask whether Publisher may use the network. Allow it on private networks.
   - macOS may ask whether Publisher may accept incoming connections. Allow it.
2. Tap **Pair a phone**. A QR code appears.
3. On the phone, open the camera, scan the code and tap the link. The phone lands in Publisher, paired.
4. Optional, to keep it like an app:
   - **Android (Chrome):** menu ⋮ → **Add to Home screen**.
   - **iPhone (Safari):** Share → **Add to Home Screen**.

The phone and the computer must be on the same Wi-Fi. To use the phone away from home, set the
public HTTPS address (the tunnel Instagram needs, under Instagram's setup). The pairing panel then
shows a link that works anywhere, encrypted.

## What a phone can and cannot do
- **Can:** post, schedule, see Post history and Stats, use and manage account groups, disconnect an account. It shows whether Drafts only is on.
- **Stays on the computer:** switching Drafts only (so a phone key, even a stolen one, cannot post publicly), connecting accounts (sign-in returns to the computer), developer keys, the public address, the file picker and folders, and phone access itself.

## Safety
- Off by default. Turning it off closes the Wi-Fi listener and refuses every phone at once.
- Each phone gets its own random key (only a hash is stored). Remove one under Phone access, or tap **Unpair** on the phone itself.
- A pairing code works once, for 10 minutes.
- Over home Wi-Fi the connection is plain HTTP, so someone on the same Wi-Fi could copy a phone's key. Use it only on your own network, or use the HTTPS tunnel, which is encrypted. A copied key still cannot switch off Drafts only, change keys or connect accounts, and removing the phone or turning phone access off ends it.

## How it is built
- Windows: `windows/core/src/phone.rs`. Mac: `server/phone.ts`. Same rules in both; tests in `windows/core/tests/phone.rs` and `tests/phone.test.ts`.
- Phone screens: the shared React UI with a phone layout (bottom tab bar, safe areas for the notch and home indicator, 40 px touch targets, 16 px fields so iOS does not zoom), plus `public/manifest.webmanifest` and home-screen icons.

## Security fix found while building this
The Mac server's sign-in check read the raw URL, so `/%61pi/accounts` skipped it while the router
served `/api/accounts`. That returned the account list without signing in. It was reachable through
the tunnel whenever one ran. The guard now checks the path the way the router reads it, and it
refuses a request when the two disagree (`routedPath` in `server/app.ts`). Tests cover encoded
paths, absolute request targets and fragments. The Windows server was not affected; it has a test too.
