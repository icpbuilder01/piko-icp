// Tiny WebAudio synth for the dice stage -- no audio files to ship, every
// sound is a few oscillator notes. The AudioContext is only created on the
// first sound, which always follows a user gesture (the Roll click), so
// browsers' autoplay rules never block it.

let ctx: AudioContext | null = null;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem("dice-muted") === "1";
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean) {
  muted = value;
  try {
    localStorage.setItem("dice-muted", value ? "1" : "0");
  } catch {
    // storage unavailable (private window etc.) -- the toggle still works for this visit
  }
}

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  tick() {
    tone(900 + Math.random() * 500, 0.025, "square", 0.025);
  },
  cross() {
    tone(620, 0.06, "triangle", 0.07);
  },
  land() {
    tone(160, 0.14, "sine", 0.25, 0, 55);
  },
  win(big: boolean) {
    const notes = big ? [523, 659, 784, 1047, 1319, 1568] : [523, 659, 784, 1047];
    notes.forEach((f, i) => tone(f, 0.16, "triangle", 0.09, 0.06 + i * 0.07));
  },
  lose() {
    tone(240, 0.22, "sawtooth", 0.035, 0.05, 120);
  },
};
