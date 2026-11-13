// Public pages served by the relay: home, Terms of Service and Privacy Policy. Platform reviews
// (Google, Meta, TikTok) ask for these at public addresses. They describe exactly what Publisher and
// this relay do. Set OPERATOR_NAME and CONTACT_EMAIL, and have the text checked before relying on it.
import type { Env } from './index.js';

const UPDATED = '14 November 2026';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shell(title: string, main: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf8;--fg:#1b1b1a;--muted:#5f5e5a;--line:#e3e2dd;--accent:#2f6fe4}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0e;--fg:#ecebe8;--muted:#a3a29d;--line:#2a2a2c;--accent:#7aa7ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}
nav{display:flex;gap:18px;font-size:14px;margin-bottom:32px}nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--fg)}
h1{font-size:28px;line-height:1.25;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px}
p,li{color:var(--fg)}.muted{color:var(--muted);font-size:14px}a{color:var(--accent)}ul{padding-left:20px}
</style></head><body><main><nav><a href="/">Publisher</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></nav>${main}</main></body></html>`;
}

export function page(kind: 'home' | 'terms' | 'privacy' | 'notice', env: Env, message = ''): string {
	const who = esc(env.OPERATOR_NAME?.trim() || 'the Publisher operator');
	const contact = env.CONTACT_EMAIL?.trim() ? `<a href="mailto:${esc(env.CONTACT_EMAIL.trim())}">${esc(env.CONTACT_EMAIL.trim())}</a>` : 'the contact address shown in the app';

	if (kind === 'notice') return shell('Publisher', `<h1>Publisher</h1><p>${esc(message)}</p>`);

	if (kind === 'home') {
		return shell(
			'Publisher',
			`<h1>Publisher</h1>
<p>Publisher is a desktop app for Windows that sends one video to your own YouTube, Instagram and TikTok accounts from one screen.</p>
<ul>
<li><b>YouTube:</b> uploads videos and Shorts to your channel.</li>
<li><b>Instagram:</b> publishes Reels to your Professional (Business or Creator) account.</li>
<li><b>TikTok:</b> sends the video to your TikTok inbox as a draft. You finish and post it in the TikTok app.</li>
</ul>
<p>You connect each account through the platform's own sign-in page. Publisher never sees your passwords, and your sign-in tokens stay encrypted on your computer.</p>
<p class="muted">Operated by ${who}. Contact: ${contact}.</p>`,
		);
	}

	if (kind === 'terms') {
		return shell(
			'Terms of Service · Publisher',
			`<h1>Terms of Service</h1><p class="muted">Last updated ${UPDATED}</p>
<p>These terms cover your use of the Publisher desktop app and its sign-in service (together, "Publisher"), provided by ${who}.</p>
<h2>What Publisher does</h2>
<p>Publisher uploads videos you choose to accounts you connect: YouTube, Instagram and TikTok. It only acts when you ask it to, on accounts you have signed in to yourself.</p>
<h2>Your responsibilities</h2>
<ul>
<li>Only connect accounts you own or are allowed to manage.</li>
<li>Only publish content you have the rights to, and that follows the rules of each platform: the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, the <a href="https://help.instagram.com/581066165581870">Instagram Terms of Use</a> and the <a href="https://www.tiktok.com/legal/terms-of-service">TikTok Terms of Service</a>.</li>
<li>Do not use Publisher for spam, for misleading content, or to get around a platform's limits.</li>
</ul>
<h2>Platform services</h2>
<p>Publisher uses the official APIs of YouTube, Instagram and TikTok. Those services are run by their owners, who may change or limit them at any time. Posting limits, processing times and whether a post is accepted are decided by each platform.</p>
<h2>No warranty</h2>
<p>Publisher is provided "as is". We work to make publishing reliable, but we cannot promise that every upload succeeds or that the service is always available. Keep your own copies of your videos.</p>
<h2>Limitation of liability</h2>
<p>To the extent the law allows, ${who} is not liable for indirect or consequential losses, or for lost content, followers or revenue, arising from your use of Publisher.</p>
<h2>Ending use</h2>
<p>You can stop at any time: disconnect your accounts in the app and uninstall it. You can also remove Publisher's access in each platform's account settings. We may suspend access for misuse.</p>
<h2>Changes</h2>
<p>We may update these terms. The date above shows the latest version.</p>
<h2>Contact</h2>
<p>${contact}</p>`,
		);
	}

	return shell(
		'Privacy Policy · Publisher',
		`<h1>Privacy Policy</h1><p class="muted">Last updated ${UPDATED}</p>
<p>This policy explains what the Publisher desktop app and its sign-in service collect, and what happens to it. Publisher is provided by ${who}.</p>
<h2>What Publisher reads from your accounts</h2>
<ul>
<li><b>YouTube (Google):</b> your channel ID, name, handle and picture, to show which channel is connected. Permission to upload videos to that channel and to read their processing status, and to read the channel's own analytics (views, likes, comments, shares, watch time, subscribers, and viewers by country, age and gender) to show them to you on the Stats page.</li>
<li><b>Instagram:</b> your account ID, username, name, picture and account type, to show which account is connected. Permission to publish Reels to that account and read their status, and to read the account's own insights (views, reach, likes, comments, shares, saves, and followers by country, age and gender) for the Stats page.</li>
<li><b>TikTok:</b> your open ID, display name and avatar, to show which account is connected. Permission to send videos to your TikTok inbox as drafts and read their upload status, and to read your follower count, total likes, and your recent videos with their views, likes, comments and shares for the Stats page.</li>
</ul>
<p>Publisher does not read your messages, the content of comments, who your followers are, or anything else. Stats are fetched only when you open the Stats page, kept in memory for a few minutes, and never sent anywhere else.</p>
<h2>Where your data is kept</h2>
<ul>
<li><b>On your computer:</b> sign-in tokens, connected account names, your videos, captions and post history. Tokens are encrypted, with the key protected by Windows for your user account.</li>
<li><b>On the sign-in service:</b> nothing is stored. When you connect an account or a sign-in is renewed, the service adds the app's credentials, passes the request to the platform, and hands the tokens straight back to your computer. It does not record them.</li>
<li><b>Instagram videos:</b> Instagram can only publish a Reel from a web address, so the app uploads the video to temporary private storage. Instagram downloads it through a signed link that expires after 6 hours. The app deletes the copy as soon as Instagram has it, and anything left over is deleted automatically within 24 hours.</li>
</ul>
<h2>What we do not do</h2>
<ul>
<li>We do not sell or share your data, and we do not use it for advertising.</li>
<li>We do not run analytics or tracking in the app or on these pages.</li>
<li>We do not post anything you did not ask Publisher to post.</li>
</ul>
<h2>Service providers</h2>
<p>The sign-in service and temporary video storage run on Cloudflare. Your posts go to Google (YouTube), Meta (Instagram) and TikTok, under their own privacy policies.</p>
<h2>Your choices</h2>
<ul>
<li>Disconnect an account in the app at any time. This deletes its tokens from your computer.</li>
<li>Remove Publisher's access in your <a href="https://myaccount.google.com/permissions">Google account</a>, in Instagram (Settings → Website permissions → Apps and websites), or in TikTok (Settings → Security → Manage app permissions).</li>
<li>Uninstalling Publisher and deleting its folder (<code>%APPDATA%\\Publisher</code>) removes everything it kept on your computer.</li>
</ul>
<h2>Google API data</h2>
<p>Publisher's use of information received from Google APIs follows the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Children</h2>
<p>Publisher is not meant for anyone under 13, or under the minimum age for the platforms in your country.</p>
<h2>Changes and contact</h2>
<p>We may update this policy; the date above shows the latest version. Questions or deletion requests: ${contact}.</p>`,
	);
}
