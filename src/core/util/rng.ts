/** Deterministic PRNG so every run of the console is reproducible and reviewable. */
export class Rng {
  private s: number;

  constructor(seed = 1) {
    this.s = (seed >>> 0) || 1;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }

  bool(p: number): boolean {
    return this.next() < p;
  }
}

/** Monotonic virtual clock. Lets the UI animate real durations without real waiting. */
export class VirtualClock {
  private t = 0;

  now(): number {
    return this.t;
  }

  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }

  reset(): void {
    this.t = 0;
  }
}

export const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
