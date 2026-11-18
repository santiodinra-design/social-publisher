// UI sounds, ported from the Ethereal Enchantment app (renderer "Feel" module) so both apps sound alike.
// Everything is synthesized with Web Audio: there are no sound files and nothing is fetched. The mute
// choice is kept in localStorage. Both desktop apps turn them on (see `enableSounds`); a plain browser
// tab stays silent.

const KEY = 'sp.sounds';
let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
let enabled = false;
let muted = (() => {
	try {
		return localStorage.getItem(KEY) === 'off';
	} catch {
		return false;
	}
})();
const listeners = new Set<() => void>();

export const sounds = {
	get available() {
		return enabled;
	},
	get on() {
		return enabled && !muted;
	},
	set(on: boolean) {
		muted = !on;
		try {
			localStorage.setItem(KEY, on ? 'on' : 'off');
		} catch {}
		listeners.forEach((f) => f());
		if (on) play('toggleOn');
	},
	subscribe(f: () => void) {
		listeners.add(f);
		return () => void listeners.delete(f);
	},
};

function audio(): AudioContext {
	if (!ctx) {
		ctx = new AudioContext();
		// A soft top end (nothing harsh above ~3.2 kHz) and nothing else: no reverb and no compressor,
		// so every click stays at the level it was set to.
		const master = ctx.createGain();
		master.gain.value = 0.9;
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.value = 3200;
		lp.Q.value = 0.5;
		master.connect(lp);
		lp.connect(ctx.destination);
		bus = master;
	}
	if (ctx.state === 'suspended') void ctx.resume();
	return ctx;
}

/** One enveloped oscillator: frequency f0 settling to f1 over `glide` seconds, decaying over `dur` seconds. */
function tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, at = 0, glide = dur, attack = 0.003) {
	const a = audio();
	const t = a.currentTime + at;
	const o = a.createOscillator();
	const g = a.createGain();
	o.type = type;
	o.frequency.setValueAtTime(f0, t);
	if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
	g.gain.setValueAtTime(0.0001, t);
	g.gain.exponentialRampToValueAtTime(gain, t + attack);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	o.connect(g);
	g.connect(bus!);
	o.start(t);
	o.stop(t + dur + 0.03);
}

/** Filtered noise: the felt-tip "touch" of a tap, or a soft swish. */
function noise(dur: number, freq: number, gain: number, q = 0.8, at = 0, type: BiquadFilterType = 'bandpass') {
	const a = audio();
	const t = a.currentTime + at;
	const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
	const d = buf.getChannelData(0);
	for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / d.length);
	const s = a.createBufferSource();
	const f = a.createBiquadFilter();
	const g = a.createGain();
	s.buffer = buf;
	f.type = type;
	f.frequency.value = freq;
	f.Q.value = q;
	g.gain.setValueAtTime(gain, t);
	s.connect(f);
	f.connect(g);
	g.connect(bus!);
	s.start(t);
}

/**
 * The voice of every sound: a soft mallet on wood. A rounded sine that drops a hair into pitch, a quiet
 * fourth harmonic that dies fast (a marimba bar rather than a beep), a little low body, and a muffled
 * touch of noise. Low-mid and warm: 300-900 Hz.
 */
function mallet(f: number, dur: number, gain: number, at = 0) {
	tone('sine', f * 1.03, f, dur, gain, at, 0.012);
	tone('sine', f * 3.98, f * 3.95, dur * 0.22, gain * 0.1, at, 0.01, 0.002);
	tone('sine', f / 2, f / 2, dur * 0.5, gain * 0.28, at, dur, 0.004);
	noise(0.008, 1400, gain * 0.25, 0.7, at, 'lowpass');
}

// Variety: ordinary buttons draw from one shared pool of tap figures, dealt like a shuffled deck, so all
// play once in random order before a reshuffle, with a little random pitch, length and loudness each time.
const jit = (v: number, p: number) => v * (1 + (Math.random() * 2 - 1) * p);
function deck<T>(items: T[]): () => T {
	let order: number[] = [];
	let prev = -1;
	return () => {
		if (!order.length) {
			order = items.map((_, i) => i);
			for (let i = order.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[order[i], order[j]] = [order[j], order[i]];
			}
			if (order.length > 1 && order[order.length - 1] === prev) [order[0], order[order.length - 1]] = [order[order.length - 1], order[0]];
		}
		prev = order.pop()!;
		return items[prev];
	};
}

// One calm scale (D major pentatonic, D3 to A5), so any figure is in tune with any other.
const SCALE = [146.83, 164.81, 185, 220, 246.94, 293.66, 329.63, 369.99, 440, 493.88, 587.33, 659.25, 739.99, 880];
const MID = [6, 7, 8, 9, 10, 11]; // D4..D5: where a click lives
type Note = [index: number, delay: number, length: number, loudness: number];
const FIGURES: Note[][] = [];
for (const i of MID) FIGURES.push([[i, 0, 0.07, 1]], [[i, 0, 0.11, 0.9]]); // single taps
for (const i of MID) for (const s of [1, 2, 3]) if (i + s < SCALE.length) FIGURES.push([[i, 0, 0.06, 0.95], [i + s, 0.05, 0.1, 0.8]]); // rising pairs
for (const i of MID) if (i - 2 >= 0) FIGURES.push([[i, 0, 0.06, 0.9], [i - 2, 0.05, 0.1, 0.75]]); // gentle falling pairs
for (const i of [6, 7, 8, 9]) FIGURES.push([[i, 0, 0.05, 0.85], [i + 1, 0.04, 0.05, 0.75], [i + 2, 0.08, 0.1, 0.7]]); // little runs
for (const i of [6, 8]) FIGURES.push([[i, 0, 0.08, 0.9], [i + 4, 0, 0.08, 0.35]]); // soft two-note chords
const ui = deck(FIGURES);

const ON = deck<[number, number]>([[3, 5], [4, 6], [5, 8], [6, 8], [7, 9]]);
const OFF = deck<[number, number]>([[8, 5], [9, 6], [8, 6], [7, 4], [6, 3]]);
const LAUNCH = deck([[0, 2, 4, 7, 11], [0, 3, 5, 7, 12], [1, 3, 5, 8, 12], [0, 2, 3, 5, 10]]);
const DANGER = deck<[number, number]>([[5, 3], [6, 3], [5, 2]]);

/** Plays one figure. Notes struck together share the level, so a tap and a chord land at about the same loudness. */
function figure(f: Note[], level = 1, low = false) {
	const k = jit(1, 0.012);
	for (const [i, at, dur, g] of f) {
		const together = f.filter((x) => x[1] === at).length;
		mallet((SCALE[i] * k) / (low ? 2 : 1), jit(dur, 0.12), jit((0.13 * g * level) / Math.sqrt(together), 0.08), at);
	}
}

const SFX = {
	tick: () => figure(ui()),
	nav: () => figure(ui(), 0.95),
	open: () => (noise(0.14, jit(900, 0.15), 0.05, 0.6, 0, 'bandpass'), figure(ui(), 0.8)),
	close: () => (noise(0.1, jit(650, 0.15), 0.04, 0.6), figure(ui(), 0.7, true)),
	pop: () => figure(ui(), 1.05),
	toggleOn: () => {
		const [a, b] = ON();
		figure([[a, 0, 0.08, 0.95], [b, 0.06, 0.14, 0.85]], 0.9);
	},
	toggleOff: () => {
		const [a, b] = OFF();
		figure([[a, 0, 0.08, 0.9], [b, 0.06, 0.14, 0.8]], 0.85);
	},
	launch: () => {
		const n = LAUNCH();
		n.slice(0, 4).forEach((i, j) => mallet(SCALE[i], 0.5 - j * 0.05, 0.1 - j * 0.008, j * 0.075));
		tone('sine', SCALE[n[4]], SCALE[n[4]], 0.9, 0.025, 0.24, 0.9, 0.05);
	},
	danger: () => {
		const [a, b] = DANGER();
		mallet(jit(SCALE[a], 0.01), 0.12, 0.11);
		mallet(jit(SCALE[b] / 1.06, 0.01), 0.18, 0.1, 0.08);
	},
};
export type Sound = keyof typeof SFX;

export function play(name: Sound | string) {
	if (!sounds.on || !(name in SFX)) return;
	try {
		SFX[name as Sound]();
	} catch {}
}

/** Which sound a click makes, from what was clicked. `data-sfx` overrides it ("none" for silence). */
function soundFor(el: HTMLElement): string {
	if (el.dataset.sfx) return el.dataset.sfx;
	if (el.classList.contains('toggle')) return el.classList.contains('on') ? 'toggleOff' : 'toggleOn';
	if (el.classList.contains('nav')) return 'nav';
	if (el.classList.contains('danger')) return 'danger';
	return 'tick';
}

/** Turns the sounds on for this window: every button and navigation link clicks. */
export function enableSounds() {
	if (enabled) return;
	enabled = true;
	// The desktop app calls this when a post finishes, also while its window is hidden.
	(window as any).__publisherFinished = (n: { ok: boolean }) => play(n?.ok ? 'launch' : 'danger');
	listeners.forEach((f) => f());
	addEventListener(
		'click',
		(e) => {
			const el = (e.target as HTMLElement | null)?.closest?.('button, a.nav, [data-sfx]') as HTMLElement | null;
			if (!el || (el as HTMLButtonElement).disabled) return;
			play(soundFor(el));
		},
		true,
	);
}
