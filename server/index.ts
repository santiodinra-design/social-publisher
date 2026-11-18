import { assertSecrets, config } from './config.js';
import { getDb } from './db.js';
import './settings.js';
import { buildApp } from './app.js';
import { inboxDir, startInbox } from './inbox.js';

assertSecrets();
getDb();
const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: '127.0.0.1' });
(process as any).parentPort?.postMessage({ type: 'ready', port: config.port });
if (config.desktop || process.env.INBOX_DIR) {
	startInbox(app);
	console.log(`[api] watching inbox ${inboxDir()}`);
}
console.log(`[api] listening on http://127.0.0.1:${config.port}${config.demoMode ? '  (DEMO MODE: publishing is simulated)' : ''}${config.noSignIn ? '  (sign-in turned off)' : ''}`);
