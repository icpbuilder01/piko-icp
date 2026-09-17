// Pure CPU-bound proof-of-work search, run off the main thread so the UI
// stays responsive. Networking (getWork polling, submitProof calls) stays on
// the main thread -- this worker only ever receives a header to search and
// reports back a found nonce or periodic progress.
//
// The byte layout MUST stay identical to mother/src/main.mo's computeHash:
// sha256(previousHash (32 bytes) # height (8 bytes big-endian) # nonce (8 bytes big-endian)).

interface WorkMessage {
  type: "work";
  previousHash: Uint8Array;
  height: bigint;
  difficultyBits: number;
  // Lets N of these workers (one per CPU core) search disjoint slices of the
  // nonce space instead of every worker redundantly retrying nonce 0, 1, 2...
  // from scratch -- workerIndex is this worker's lane, workerCount is the
  // stride, so together they partition the space evenly.
  workerIndex: number;
  workerCount: number;
  // Without this, every session (this same account's other tab/device, or
  // any other miner on the network) searches from nonce 0 in the same
  // deterministic order -- for a given header there's a single fixed first
  // nonce that satisfies the difficulty target scanning that way, so two
  // uncoordinated sessions converge on the exact same answer and the slower
  // one contributes nothing (confirmed: mining the same account from two
  // devices at once measured zero speedup over the faster device alone).
  // Worse, it means whichever single miner on the whole network has the
  // highest raw hashrate deterministically wins almost every block, rather
  // than winning in proportion to their real share the way PoW is supposed
  // to work. A random per-job base offset (shared across this session's own
  // workers, so they still partition cleanly among themselves) makes each
  // session search a genuinely different, independent slice, so multiple
  // devices/tabs actually add real combined speed and no single fast
  // participant is structurally guaranteed to always win first.
  nonceOffset: bigint;
  // Fraction of full speed to hash at, 0 < dutyCycle <= 1 -- see the Power
  // message below.
  dutyCycle: number;
  // Echoed back on every progress/found report -- lets the main thread tell
  // "this reflects the job I currently expect" apart from "this was already
  // in flight under an old config (before a stop/power change) and just
  // hasn't arrived yet" (see App.tsx's jobIdRef comment for the full story).
  jobId: number;
}

// Lets the power level (Low/High/Max) change live while a search is already
// running, without losing progress or restarting the current header search
// -- dutyCycle is read fresh every loop iteration (see the module-level
// variable below), a WorkMessage only sets its *initial* value.
interface PowerMessage {
  type: "power";
  dutyCycle: number;
  jobId: number;
}

interface StopMessage {
  type: "stop";
}

type InboundMessage = WorkMessage | StopMessage | PowerMessage;

let generation = 0; // bumped on every new "work" message to abandon stale loops
let dutyCycle = 1; // 0 < dutyCycle <= 1; updated live by "work"/"power" messages
let currentJobId = 0; // stamped on every outgoing progress/found message

function natToBytes8(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let v = n;
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function leadingZeroBits(hash: Uint8Array): number {
  let count = 0;
  for (const byte of hash) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    let v = byte;
    let bit = 0;
    while (bit < 8 && (v & 0x80) === 0) {
      count++;
      v = (v << 1) & 0xff;
      bit++;
    }
    break;
  }
  return count;
}

function reportProgress(attempts: number, elapsedMs: number) {
  if (attempts <= 0) return;
  self.postMessage({
    type: "progress",
    attempts,
    hashrate: elapsedMs > 0 ? Math.round((attempts / elapsedMs) * 1000) : 0,
    jobId: currentJobId,
  });
}

async function search(
  myGeneration: number,
  previousHash: Uint8Array,
  height: bigint,
  difficultyBits: number,
  workerIndex: number,
  workerCount: number,
  nonceOffset: bigint,
) {
  const header = new Uint8Array(previousHash.length + 8);
  header.set(previousHash, 0);
  header.set(natToBytes8(height), previousHash.length);

  const stride = BigInt(Math.max(1, workerCount));
  let nonce = nonceOffset + BigInt(workerIndex);
  let attemptsSinceReport = 0;
  let lastReport = performance.now();
  // Duty-cycle throttling for Low/High power: hash flat-out for
  // DUTY_WINDOW_MS * dutyCycle, then genuinely sleep (not just slow down --
  // an actual idle worker thread) for the rest of the window, so the CPU
  // really gets to cool off during the pause instead of just spinning
  // slower. Reading the module-level `dutyCycle` fresh each iteration
  // (rather than a captured parameter) is what lets a live power-level
  // change take effect immediately without restarting the search.
  const DUTY_WINDOW_MS = 200;
  let dutyWindowStart = performance.now();
  // Real-world report, mobile only: switching power down (e.g. Max -> Low)
  // could leave the hashrate stuck until this app's own watchdog forcibly
  // killed and recreated the worker ~10s later -- but switching it *up*
  // (which the worker was already periodically sleeping under) always
  // worked instantly. Root cause: `await crypto.subtle.digest(...)`
  // resolves as a microtask, so a tight loop of nothing but awaited digest
  // calls (exactly what Max power is) never naturally yields to the
  // macrotask queue -- which is where a `postMessage`d "power"/"stop"
  // message's delivery is queued. Some engines (seen here on mobile
  // WebKit, not desktop V8) don't fairly interleave macrotasks under
  // sustained microtask pressure, so that message can sit undelivered
  // indefinitely. A periodic zero-delay `setTimeout` forces a real
  // macrotask-queue yield regardless of duty cycle, giving pending
  // messages a guaranteed chance to run at negligible cost to hashrate.
  const YIELD_INTERVAL_MS = 50;
  let lastYield = performance.now();

  while (generation === myGeneration) {
    const data = new Uint8Array(header.length + 8);
    data.set(header, 0);
    data.set(natToBytes8(nonce), header.length);

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    attemptsSinceReport++;

    if (leadingZeroBits(digest) >= difficultyBits) {
      if (generation === myGeneration) {
        self.postMessage({ type: "found", nonce, height });
      }
      return;
    }

    nonce += stride;

    const now = performance.now();
    // Deliberately does NOT reset lastReport/attemptsSinceReport around this
    // sleep -- letting the sleep gap fall inside the normal ~400ms report
    // window below is what makes the displayed hashrate honestly reflect
    // the *real* throttled rate (fewer real attempts per wall-clock second),
    // not the misleadingly-full rate this worker only hits while awake.
    if (dutyCycle < 1 && now - dutyWindowStart >= DUTY_WINDOW_MS * dutyCycle) {
      await new Promise((resolve) => setTimeout(resolve, DUTY_WINDOW_MS * (1 - dutyCycle)));
      dutyWindowStart = performance.now();
      lastYield = performance.now();
    } else if (now - lastYield >= YIELD_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }

    if (now - lastReport > 400) {
      reportProgress(attemptsSinceReport, now - lastReport);
      attemptsSinceReport = 0;
      lastReport = now;
    }
  }

  // Preempted by a new header (someone -- possibly this same user's own
  // canister miner -- won the block this loop was searching for) before
  // the next scheduled 400ms report. Reported live: the displayed attempt
  // count appeared to permanently freeze around the same number every
  // time, even without the browser itself finding anything -- caused by
  // exactly this: headers changing faster than the report interval means
  // a report is never reached, so whatever was searched in that final
  // fragment silently vanishes instead of being counted. Flushing
  // whatever was accumulated here, however small, keeps the displayed
  // count honest under frequent header changes -- which will only get
  // more common as more people (or this user's own always-on canister
  // miner) mine, not less.
  reportProgress(attemptsSinceReport, performance.now() - lastReport);
}

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (msg.type === "work") {
    dutyCycle = msg.dutyCycle;
    currentJobId = msg.jobId;
    generation++;
    search(
      generation,
      msg.previousHash,
      msg.height,
      msg.difficultyBits,
      msg.workerIndex,
      msg.workerCount,
      msg.nonceOffset,
    );
  } else if (msg.type === "power") {
    dutyCycle = msg.dutyCycle;
    currentJobId = msg.jobId;
  } else if (msg.type === "stop") {
    generation++; // abandons any in-flight search loop
  }
};
