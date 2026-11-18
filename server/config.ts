import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader for development. The desktop app never reads .env: its main process
// passes settings to the services directly (SP_DESKTOP=1).
const envFile = path.resolve(process.cwd(), '.env');
if (!process.env.SP_DESKTOP && fs.existsSync(envFile)) {
	for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
	}
}

/** Settings saved in the app (see settings.ts) override .env without a restart. */
export const overrides: { get: (key: string) => string | undefined } = { get: () => undefined };
const env = (k: string, d = '') => process.env[k] ?? d;
const live = (k: string, d = '') => overrides.get(k) ?? process.env[k] ?? d;
const flag = (k: string) => ['1', 'true', 'yes', 'on'].includes(env(k).toLowerCase());

export const config = {
	port: Number(env('API_PORT', '8787')),
	appUrl: env('APP_URL', 'http://localhost:5173'),
	// Public HTTPS base that platforms can reach (needed for Instagram, which pulls video from a URL).
	get publicBaseUrl() {
		return live('PUBLIC_BASE_URL');
	},
	dataDir: path.resolve(env('DATA_DIR', './data')),
	appPassword: env('APP_PASSWORD'),
	sessionSecret: env('SESSION_SECRET'),
	tokenKey: env('TOKEN_ENCRYPTION_KEY'),
	demoMode: flag('DEMO_MODE'),
	// Owner testing on this computer only: skips the password screen. The API still only listens on 127.0.0.1.
	noSignIn: flag('NO_SIGN_IN'),
	/** Desktop app: a per-launch secret the main process places in its own window's cookie jar. */
	desktopToken: env('DESKTOP_TOKEN'),
	get desktop() {
		return Boolean(process.env.SP_DESKTOP);
	},
	uiDist: path.resolve(env('UI_DIST', 'dist')),
	ffprobePath: env('FFPROBE_PATH', 'ffprobe'),
	mediaRetentionHours: Number(env('MEDIA_RETENTION_HOURS', '72')),
	maxUploadBytes: Number(env('MAX_UPLOAD_MB', '4096')) * 1024 * 1024,
	tiktok: {
		get clientKey() {
			return live('TIKTOK_CLIENT_KEY');
		},
		get clientSecret() {
			return live('TIKTOK_CLIENT_SECRET');
		},
		// Direct Post needs an audited app; personal tools are not eligible, so it is off unless you say otherwise.
		directPostEnabled: flag('TIKTOK_DIRECT_POST_ENABLED'),
	},
	instagram: {
		get appId() {
			return live('INSTAGRAM_APP_ID');
		},
		get appSecret() {
			return live('INSTAGRAM_APP_SECRET');
		},
		apiVersion: env('INSTAGRAM_API_VERSION', 'v25.0'),
		/** Meta "Unified login" configuration ID. When set, Instagram signs in through Facebook Login for Business. */
		get configId() {
			return live('INSTAGRAM_CONFIG_ID');
		},
		/** 'facebook' = Instagram API with Facebook Login (needs a Facebook Page linked to each account, no business portfolio). */
		get loginMode() {
			return live('INSTAGRAM_LOGIN');
		},
	},
	youtube: {
		get clientId() {
			return live('GOOGLE_CLIENT_ID');
		},
		get clientSecret() {
			return live('GOOGLE_CLIENT_SECRET');
		},
	},
};

/**
 * Where each platform sends the browser back after sign-in.
 * YouTube: Google accepts loopback addresses (any port) for "Desktop app" clients, so the local server works.
 * Instagram and TikTok require registered HTTPS addresses, so they use PUBLIC_BASE_URL (a tunnel) when set.
 */
export const redirectUri = (platform: string) => {
	const pub = config.publicBaseUrl;
	const base = platform !== 'youtube' && /^https:\/\//.test(pub) ? pub : config.appUrl;
	return `${base.replace(/\/$/, '')}/api/oauth/${platform}/callback`;
};

export const configured = {
	tiktok: () => Boolean(config.tiktok.clientKey && config.tiktok.clientSecret),
	instagram: () => Boolean(config.instagram.appId && config.instagram.appSecret),
	youtube: () => Boolean(config.youtube.clientId && config.youtube.clientSecret),
};

export function assertSecrets() {
	const access = config.desktop ? ['DESKTOP_TOKEN'] : config.noSignIn ? [] : ['APP_PASSWORD'];
	const missing = [...access, 'SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY'].filter((k) => !process.env[k]);
	if (missing.length) {
		throw new Error(`Missing required settings: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
	}
	if (Buffer.from(config.tokenKey, 'base64').length !== 32) {
		throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (see .env.example).');
	}
}
