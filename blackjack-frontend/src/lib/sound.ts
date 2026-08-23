// All effects are synthesized via the Web Audio API -- no asset files to
// ship/license, and it works the instant JS loads. Every playXxx() call is
// a no-op until the AudioContext exists, which only happens lazily on the
// first call made from inside a real user gesture (a click handler) --
// browsers refuse to start audio otherwise, so this deliberately never
// tries to construct one eagerly on page load.

const MUTE_KEY = "pikoslots-muted";

let ctx: AudioContext | null = null;
let muted = localStorage.getItem(MUTE_KEY) === "1";

function getCtx(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean) {
  muted = value;
  localStorage.setItem(MUTE_KEY, value ? "1" : "0");
}

function tone(freq: number, startAt: number, durationSec: number, gain: number, type: OscillatorType = "sine") {
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const gainNode = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = c.currentTime + startAt;
  gainNode.gain.setValueAtTime(0, t0);
  gainNode.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
  osc.connect(gainNode);
  gainNode.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + durationSec + 0.02);
}

export function playClick() {
  tone(720, 0, 0.06, 0.12, "square");
}

// A short percussive "tock" as each reel lands -- pitched a bit higher for
// later reels so the 3-reel stop reads as a little ascending run.
export function playReelStop(reelIndex: number) {
  tone(180 + reelIndex * 40, 0, 0.09, 0.18, "triangle");
}

// A quick blip when an individual line lands a win -- kept subtle since up
// to 3 of these can fire together with the net-win chime right after.
export function playLineWin() {
  tone(660, 0, 0.12, 0.1, "sine");
  tone(880, 0.05, 0.12, 0.08, "sine");
}

// A crisp, dry tick for a card landing on the table -- pitch nudges up
// slightly per call so a run of several (see playDealSequence) reads as a
// quick ascending flick rather than the exact same tock repeated.
export function playCardDeal(index = 0) {
  tone(520 + index * 30, 0, 0.05, 0.1, "triangle");
}

// A fast, rhythmic run of card-deal ticks -- used right when a hand's
// initial cards land at once (deal()'s 2 player cards, or catching up
// after a hit), so the "pace" of a bet landing reads snappier than one
// single flat tock.
export function playDealSequence(count: number) {
  for (let i = 0; i < count; i++) {
    tone(520 + i * 30, i * 0.055, 0.05, 0.1, "triangle");
  }
}

// A light single chip-tap -- the +/- bet stepper, meant to feel like
// nudging one chip onto (or off) a stack, not the full bet-placed clack
// below.
export function playChipTick() {
  tone(1500, 0, 0.03, 0.08, "square");
}

// A satisfied little clatter of chips being pushed onto the felt -- two
// quick plasticky raps at slightly different pitches, played the moment a
// bet is placed (Deal), distinct from the softer single-chip tick above.
export function playChipBet() {
  tone(1300, 0, 0.035, 0.14, "square");
  tone(1000, 0.035, 0.045, 0.12, "square");
  tone(1450, 0.07, 0.03, 0.09, "square");
}

// A bright, fast coin cascade -- layered in alongside playNetWin/
// playBigWin for extra "cha-ching" sparkle on an actual win, never played
// on its own.
export function playCoinWin() {
  const pitches = [1760, 2093, 2349, 2637, 3136]; // A6 C7 D7 E7 G7 -- bright, sparkly
  pitches.forEach((f, i) => tone(f, i * 0.04, 0.1, 0.09, "triangle"));
}

// A dull thud for busting past 21.
export function playBust() {
  tone(160, 0, 0.16, 0.14, "sawtooth");
  tone(110, 0.06, 0.22, 0.1, "sawtooth");
}

// The net-spin-result chime -- an ascending arpeggio whose length scales
// with how good the win is, only ever called for a genuine net win (see
// App.tsx's handleReelsLanded), never for an individual line in isolation.
export function playNetWin(multiplier: number) {
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5]; // C5 E5 G5 C6 E6
  const count = multiplier >= 10 ? 5 : multiplier >= 3 ? 4 : multiplier >= 1.5 ? 3 : 2;
  for (let i = 0; i < count; i++) {
    tone(notes[i], i * 0.09, 0.22, 0.14, "sine");
  }
}

export function playBigWin() {
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568.0];
  notes.forEach((f, i) => tone(f, i * 0.07, 0.35, 0.16, "sine"));
  tone(261.6, 0, 0.9, 0.1, "sawtooth"); // low sustained rumble underneath
}

export function playLose() {
  tone(220, 0, 0.18, 0.08, "sine");
  tone(180, 0.08, 0.22, 0.07, "sine");
}
