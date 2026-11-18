// Background publisher. Runs separately from the web server, so uploads continue after the page closes.
import os from 'node:os';
import { assertSecrets } from './config.js';
import { getDb, workerBeat } from './db.js';
import './settings.js';
import { randomId } from './crypto.js';
import { cleanupMedia, setNoticeHandler, tick } from './runner.js';
import { releaseLeases } from './jobs.js';

assertSecrets();
getDb();
const owner = `${os.hostname()}:${process.pid}:${randomId(4)}`;
let stopping = false;
let lastCleanup = 0;

console.log(`[worker] started as ${owner}`);
// Heartbeat on its own timer so a long upload does not make the worker look stopped.
const startedAt = Date.now();
const beat = () => {
	try {
		workerBeat(owner, startedAt);
	} catch {}
};
beat();
const beatTimer = setInterval(beat, 10_000);
// Stop promptly: hand unfinished jobs back (marked to check first) and exit, rather than wait for a long upload.
const parent = (process as any).parentPort as { postMessage(m: unknown): void; on(e: 'message', f: (e: { data: any }) => void): void } | undefined;
function stopNow(reason: string) {
	if (stopping) return;
	stopping = true;
	try {
		const n = releaseLeases(owner);
		console.log(`[worker] ${reason}: paused ${n} job(s); they resume on next start`);
	} catch (e: any) {
		console.error('[worker] could not release jobs:', e?.message ?? e);
	}
	process.exit(0);
}
process.on('SIGINT', () => stopNow('interrupted'));
process.on('SIGTERM', () => stopNow('stopping'));
parent?.on('message', (e) => e.data?.type === 'stop' && stopNow('app is quitting'));
parent?.postMessage({ type: 'ready' });
// Finished posts are announced by the desktop app (a macOS notification and the finish sound).
setNoticeHandler((n) => {
	console.log(`[notify] ${n.title} (${n.ok ? 'ok' : 'problem'})`);
	parent?.postMessage({ type: 'notice', notice: n });
});

while (!stopping) {
	try {
		const n = await tick(owner);
		if (Date.now() - lastCleanup > 10 * 60_000) {
			const removed = cleanupMedia();
			if (removed) console.log(`[worker] removed ${removed} old video file(s)`);
			lastCleanup = Date.now();
		}
		if (n === 0) await new Promise((r) => setTimeout(r, 1500));
	} catch (e: any) {
		console.error('[worker] loop error:', e?.message ?? e);
		await new Promise((r) => setTimeout(r, 3000));
	}
}
clearInterval(beatTimer);
console.log('[worker] stopped; unfinished uploads resume on next start');
process.exit(0);
