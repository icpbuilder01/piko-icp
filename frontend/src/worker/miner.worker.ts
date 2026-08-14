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
}

interface StopMessage {
  type: "stop";
}

type InboundMessage = WorkMessage | StopMessage;

let generation = 0; // bumped on every new "work" message to abandon stale loops

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
  });
}

async function search(myGeneration: number, previousHash: Uint8Array, height: bigint, difficultyBits: number) {
  const header = new Uint8Array(previousHash.length + 8);
  header.set(previousHash, 0);
  header.set(natToBytes8(height), previousHash.length);

  let nonce = 0n;
  let attemptsSinceReport = 0;
  let lastReport = performance.now();

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

    nonce++;

    const now = performance.now();
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
    generation++;
    search(generation, msg.previousHash, msg.height, msg.difficultyBits);
  } else if (msg.type === "stop") {
    generation++; // abandons any in-flight search loop
  }
};
