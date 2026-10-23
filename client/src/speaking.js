// "Is this person talking?" for the green ring around a call tile. Pure (no React, no audio objects):
// client/scripts/speaking-test.mjs tests it in Node. Call.jsx feeds it samples from a Web Audio AnalyserNode.

// Loudness of one block of samples as 0..1. `bytes` is what AnalyserNode.getByteTimeDomainData fills: 128 is silence.
export function levelOf(bytes) {
  if (!bytes || !bytes.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) { const v = (bytes[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / bytes.length);
}

// Turns a stream of loudness readings into a steady yes/no, so the ring does not flicker between words:
//   starts when the level reaches `on`; stays on while it is above `off`; and after it drops, stays on for `hold` ms more.
export class SpeakingGate {
  constructor({ on = 0.02, off = 0.011, hold = 420 } = {}) {
    this.on = on; this.off = off; this.hold = hold;
    this.speaking = false; this.last = 0;
  }
  update(level, now) {
    if (level >= this.on) { this.speaking = true; this.last = now; }
    else if (this.speaking && level >= this.off) this.last = now;
    else if (this.speaking && now - this.last > this.hold) this.speaking = false;
    return this.speaking;
  }
  reset() { this.speaking = false; this.last = 0; }
}
