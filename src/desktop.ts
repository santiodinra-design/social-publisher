// Bridge to the desktop app (preload). Absent when the UI runs in a normal browser.
import type { Media } from './api';

export type PickResult = { canceled: true } | { canceled: false; media: Media; filename: string; size: number } | { canceled: false; error: string };
export type Services = { version: string; api: string; worker: string; logsDir: string; dataDir: string; port: number };
type Bridge = {
	/** Set by the Windows app. Absent in the Mac app. */
	platform?: 'windows';
	pickVideo(onProgress: (p: number) => void): Promise<PickResult>;
	openExternal(url: string): Promise<boolean>;
	revealLogs(): Promise<void>;
	/** Mac app: opens the inbox folder in Finder. */
	revealInbox?(): Promise<void>;
	services(): Promise<Services>;
};

export const desktop: Bridge | undefined = (window as any).publisher;

/** Wording that differs between the Mac and Windows apps. */
export const onWindows = desktop?.platform === 'windows';
export const computer = onWindows ? 'PC' : 'Mac';
export const logsHint = onWindows ? 'right-click the Publisher icon next to the clock → Show Logs in Explorer' : 'Help → Reveal Logs in Finder';

/** Opens a platform sign-in page: in the system browser inside the app, or this tab in a browser. */
export async function openSignIn(url: string) {
	if (desktop) await desktop.openExternal(url);
	else location.href = url;
}
