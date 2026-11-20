import React, { useEffect, useState } from 'react';
import { api, type Pairing, type PhoneAccess } from '../api';
import { computer, onWindows } from '../desktop';

/**
 * Phone access (desktop apps): pair an Android phone or iPhone by scanning a code. The phone then
 * uses Publisher over Wi-Fi (or the HTTPS tunnel when one is set) while this computer does the work.
 */
export function PhonePanel() {
	const [state, setState] = useState<PhoneAccess | null>(null);
	const [pairing, setPairing] = useState<Pairing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => void api.phone().then(setState).catch(() => undefined), []);
	// A new phone appears in the list as soon as it scans the code.
	useEffect(() => {
		if (!pairing) return;
		const t = setInterval(() => {
			if (Date.now() > pairing.expiresAt) setPairing(null);
			api.phone()
				.then((s) => {
					if (state && s.devices.length > state.devices.length) setPairing(null);
					setState(s);
				})
				.catch(() => undefined);
		}, 2500);
		return () => clearInterval(t);
	}, [pairing, state?.devices.length]);
	if (!state) return null;

	const run = async (f: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await f();
		} catch (e: any) {
			setError(e.message);
		} finally {
			setBusy(false);
		}
	};
	const toggle = () =>
		run(async () => {
			const s = await api.setPhone(!state.enabled);
			setState(s);
			setPairing(null);
			if (s.problem) setError(s.problem);
		});
	const pair = () => run(async () => setPairing(await api.pairPhone()));

	return (
		<section className="panel phone-panel" aria-label="Phone access">
			<div className="block-head">
				<h3>Phone access</h3>
				<span className="grow" />
				<button type="button" className={`btn sm ${state.enabled ? 'quiet' : 'primary'}`} disabled={busy} onClick={toggle}>{state.enabled ? 'Turn off' : 'Turn on'}</button>
			</div>
			<p className="hint" style={{ margin: '0 0 10px' }}>
				Post from your Android phone or iPhone. The phone picks the video and caption; this {computer} uploads and publishes, so keep Publisher open.
				{' '}Connecting accounts and developer keys stay on this {computer}.
			</p>
			{error && <div className="err" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
			{state.enabled && (
				<>
					<div className="phone-where">
						{state.wifiUrl ? <span>On the same Wi-Fi: <span className="mono">{state.wifiUrl}</span></span> : <span className="faint">Not reachable over Wi-Fi right now.</span>}
						{state.httpsUrl && <span>Anywhere, through your tunnel: <span className="mono">{state.httpsUrl}</span></span>}
					</div>
					{onWindows && state.wifiUrl && <p className="hint" style={{ margin: '6px 0 0' }}>If Windows asks whether Publisher may use the network, allow it on private networks.</p>}
					{pairing ? (
						<div className="pair-box">
							<img className="qr" alt="Pairing code" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qr)}`} />
							<div className="grow" style={{ minWidth: 0 }}>
								<b>Scan with the phone’s camera</b>
								<p className="hint" style={{ margin: '4px 0 8px' }}>The code works once, for 10 minutes. On the phone, tap the link that appears. To keep it like an app: Android, browser menu → Add to Home screen. iPhone, Share → Add to Home Screen.</p>
								<div className="mono ellipsis faint" style={{ fontSize: 11.5 }}>{pairing.url}</div>
								{pairing.awayUrl && <div className="hint" style={{ marginTop: 6 }}>Not on this Wi-Fi? Open this on the phone instead: <span className="mono">{pairing.awayUrl}</span></div>}
								<button type="button" className="btn sm quiet" style={{ marginTop: 8 }} onClick={() => setPairing(null)}>Done</button>
							</div>
						</div>
					) : (
						<button type="button" className="btn sm" style={{ marginTop: 10 }} disabled={busy} onClick={pair}>Pair a phone</button>
					)}
					{!state.httpsUrl && state.wifiUrl && <p className="hint" style={{ margin: '10px 0 0' }}>Over Wi-Fi the connection is not encrypted, so only use it on your own home network. A public HTTPS address (the tunnel Instagram uses) works anywhere and is encrypted.</p>}
				</>
			)}
			{state.devices.length > 0 && (
				<ul className="phone-list">
					{state.devices.map((d) => (
						<li key={d.id}>
							<b className="grow ellipsis">{d.name}</b>
							<small className="faint">{d.lastSeenAt ? `Last used ${new Date(d.lastSeenAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Paired'}</small>
							<button type="button" className="btn sm quiet danger" onClick={() => run(async () => setState(await api.removePhone(d.id)))}>Remove</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
