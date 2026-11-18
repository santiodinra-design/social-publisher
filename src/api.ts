export type Platform = 'tiktok' | 'instagram' | 'youtube';
export type State = 'queued' | 'uploading' | 'processing' | 'published' | 'failed' | 'needs_attention';

export type Account = { id: string; platform: Platform; displayName: string; handle: string | null; avatarUrl: string | null; isDemo: boolean; status: string; statusDetail: string | null; accessExpiresAt: number | null; connectedAt: number };
/** `hosted`: connects with one click through the app's sign-in service (Windows build only; absent elsewhere). */
export type PlatformInfo = { configured: boolean; hosted?: boolean; available: boolean; mode: string; note: string; limits: { note: string } };
/** `videoHosting`: Instagram can download videos from the sign-in service's temporary storage (Windows build only). */
export type Config = { demoMode: boolean; publicBaseUrl: boolean; videoHosting?: boolean; features?: string[]; draftsOnly?: boolean; platforms: Record<Platform, PlatformInfo> };
/** The inbox folder that turns dropped videos into drafts (Mac app). */
export type Inbox = { enabled: boolean; dir: string; recent: { name: string; at: number; status: 'sent' | 'failed' | 'working'; message: string; postId?: string }[] };
export type Prefs = { notifications: boolean; draftsOnly?: boolean };
/** Whether the backend offers a feature beyond the original contract (the Windows build lists them; the Mac server lists none). */
export const has = (c: Config | null | undefined, feature: string) => Boolean(c?.features?.includes(feature));
export type Media = { id: string; filename: string; size: number; duration: number | null; width: number | null; height: number | null; videoCodec: string | null; audioCodec: string | null; fps?: number | null; shortsShape: boolean; issues: Record<Platform, string[]>; previewUrl?: string };
export type Target = { id: string; platform: Platform; account: { name: string; handle: string | null; avatarUrl: string | null; isDemo: boolean }; settings: any; state: State; phase: string | null; progress: number; attempts: number; outcomeUnknown: boolean; accountStatus: string; nextRunAt: number | null; scheduled?: boolean; canMarkPosted?: boolean; accountId?: string; error: string | null; permalink: string | null; updatedAt: number; events: { at: number; message: string }[] };
export type Post = { id: string; caption: string; isDemo: boolean; createdAt: number; scheduledAt?: number | null; scheduled?: boolean; media: { id?: string; filename: string; duration: number | null; width: number | null; height: number | null; size: number; deleted: boolean }; targets: Target[]; done: boolean };
/** `accountId`: set by the composer's own checks, so two accounts on one platform keep their problems apart. */
/** A saved set of accounts for "Post to" (Mac server feature `groups`). */
export type Group = { id: string; name: string; accountIds: string[] };
/** How Publisher signs in to Instagram (depends on what the Meta app offers). */
export type IgLogin = 'facebook' | 'unified' | 'instagram';
export type Issue = { field: string; message: string; accountId?: string };
export type Status = { worker: { state: 'running' | 'stale' | 'never'; lastSeenAt: number | null; startedAt: number | null }; activeJobs: number; noSignIn: boolean; demoMode: boolean; now: number };
export type Verify = { ok: boolean; simulated?: boolean; reconnect?: boolean; checkedAt: number; message: string };
export type Setup = {
	appUrl: string;
	publicBaseUrl: { value: string | null; source: 'app' | 'env' | null };
	platforms: Record<Platform, { configured: boolean; source: 'app' | 'env' | null; idPreview: string | null; hasSecret: boolean; redirectUri: string; idLabel: string; secretLabel: string; configPreview?: string | null; loginMode?: IgLogin }>;
};

/** One account's stats for a period (Windows build). Totals a platform does not report are absent. */
export type Stats = {
	accountId: string;
	platform: Platform;
	name: string;
	handle: string | null;
	avatarUrl: string | null;
	isDemo: boolean;
	days: number;
	status: 'ok' | 'reconnect' | 'error';
	message: string | null;
	followers: number | null;
	totals: Record<string, number>;
	daily: ({ date: string } & Record<string, number | string>)[];
	countries: { code: string; value: number; share: number }[];
	countriesOf: 'views' | 'followers';
	ages: { age: string; female: number; male: number; other: number }[];
	top: { id: string; title: string; thumbnail: string | null; permalink: string | null; publishedAt: string | number | null; views: number | null; likes: number | null; comments: number | null; shares: number | null }[];
	notes: string[];
};
export type StatsReport = { days: number; generatedAt: number; accounts: Stats[] };

export class ApiError extends Error {
	constructor(message: string, readonly status: number, readonly issues: Issue[] = []) {
		super(message);
	}
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		credentials: 'same-origin',
		headers: { 'X-Requested-With': 'social-publisher', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.issues ?? []);
	return data as T;
}

export const api = {
	session: () => call<{ signedIn: boolean; demoMode: boolean; noSignIn?: boolean }>('GET', '/api/session'),
	signIn: (password: string) => call('POST', '/api/session', { password }),
	signOut: () => call('DELETE', '/api/session'),
	config: () => call<Config>('GET', '/api/config'),
	accounts: () => call<Account[]>('GET', '/api/accounts'),
	disconnect: (id: string) => call('DELETE', `/api/accounts/${id}`),
	addDemoAccounts: () => call<Account[]>('POST', '/api/demo/accounts'),
	setup: () => call<Setup>('GET', '/api/setup'),
	saveKeys: (p: Platform, body: { id: string; secret: string; publicBaseUrl?: string; configId?: string; loginMode?: IgLogin }) => call<Setup>('PUT', `/api/setup/${p}`, body),
	removeKeys: (p: Platform) => call<Setup>('DELETE', `/api/setup/${p}`),
	savePublicUrl: (url: string) => call<Setup>('PUT', '/api/setup/public-url', { publicBaseUrl: url }),
	status: () => call<Status>('GET', '/api/status'),
	media: (id: string) => call<Media>('GET', `/api/media/${encodeURIComponent(id)}`),
	beginOAuth: (p: Platform) => call<{ url: string }>('POST', `/api/oauth/${p}/begin`),
	groups: () => call<Group[]>('GET', '/api/groups'),
	createGroup: (name: string, accountIds: string[]) => call<Group>('POST', '/api/groups', { name, accountIds }),
	updateGroup: (id: string, name: string, accountIds: string[]) => call<Group[]>('PUT', `/api/groups/${id}`, { name, accountIds }),
	deleteGroup: (id: string) => call<Group[]>('DELETE', `/api/groups/${id}`),
	verify: (accountId: string) => call<Verify>('POST', `/api/accounts/${accountId}/verify`),
	posts: () => call<Post[]>('GET', '/api/posts'),
	post: (id: string) => call<Post>('GET', `/api/posts/${id}`),
	publish: (body: unknown) => call<{ post: Post; duplicate: boolean }>('POST', '/api/posts', body),
	retry: (id: string, targetIds?: string[]) => call<{ post: Post }>('POST', `/api/posts/${id}/retry`, { targetIds }),
	/** `at` null publishes now. */
	schedule: (id: string, at: number | null) => call<{ post: Post }>('POST', `/api/posts/${id}/schedule`, { at }),
	markPosted: (targetId: string, permalink: string) => call<{ post: Post }>('POST', `/api/targets/${targetId}/posted`, { permalink }),
	/** Saves a cover image (JPEG or PNG, up to 8 MB). */
	uploadCover: async (file: File) => {
		const res = await fetch('/api/covers', { method: 'PUT', credentials: 'same-origin', headers: { 'X-Requested-With': 'social-publisher', 'Content-Type': file.type || 'application/octet-stream' }, body: file });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new ApiError(data.error ?? `Upload failed (${res.status})`, res.status);
		return data as { id: string; mime: string; size: number; width: number | null; height: number | null; url: string };
	},
	analytics: (days: number, fresh = false) => call<StatsReport>('GET', `/api/analytics?days=${days}${fresh ? '&fresh=1' : ''}`),
	prefs: () => call<Prefs>('GET', '/api/desktop/prefs'),
	setPrefs: (p: Partial<Prefs>) => call<Prefs>('PUT', '/api/desktop/prefs', p),
	inbox: () => call<Inbox>('GET', '/api/inbox'),
	cancelSchedule: (id: string) => call<{ post: Post }>('POST', `/api/posts/${id}/cancel`, {}),
};

/** Upload with progress. The server streams the body straight to disk. */
export function uploadVideo(file: File, onProgress: (p: number) => void): { promise: Promise<Media>; abort: () => void } {
	const xhr = new XMLHttpRequest();
	const promise = new Promise<Media>((resolve, reject) => {
		xhr.open('PUT', '/api/media');
		xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
		xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
		xhr.setRequestHeader('X-Requested-With', 'social-publisher');
		xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
		xhr.onload = () => {
			let data: any = {};
			try {
				data = JSON.parse(xhr.responseText);
			} catch {}
			if (xhr.status >= 200 && xhr.status < 300) resolve(data);
			else reject(new ApiError(data.error ?? `Upload failed (${xhr.status})`, xhr.status));
		};
		xhr.onerror = () => reject(new ApiError('Upload failed. Check your connection.', 0));
		xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0));
		xhr.send(file);
	});
	return { promise, abort: () => xhr.abort() };
}

export const PLATFORM_NAME: Record<Platform, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' };
export const fmtDur = (s: number | null) => (s == null ? '–' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
export const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);
export const fmtTime = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
