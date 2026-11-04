// A fixed-window rate limiter: at most `max` takes per key in each window.
// In memory, so it resets on restart and is per process. That is enough for
// one small server; several servers would need a shared store (e.g. Redis).
//
// Known weakness of fixed windows: a client can use `max` at the end of one
// window and `max` again at the start of the next, so a burst of up to 2x
// is possible. Fine here; a sliding window would close it.

export type RateLimiterConfig = {
  max: number;
  windowMs: number;
  now?: () => number; // injectable clock, for tests
};

const SWEEP_ABOVE = 10_000; // entries; bounds memory under a flood of distinct keys

export function createRateLimiter(config: RateLimiterConfig) {
  const now = config.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    // Returns true if this call is allowed, false if the key is over its limit.
    take(key: string): boolean {
      const t = now();
      if (windows.size > SWEEP_ABOVE) {
        for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
      }
      const w = windows.get(key);
      if (w === undefined || w.resetAt <= t) {
        windows.set(key, { count: 1, resetAt: t + config.windowMs });
        return true;
      }
      if (w.count >= config.max) return false;
      w.count += 1;
      return true;
    },

    // Seconds until the key's window ends (for the Retry-After header).
    retryAfterSeconds(key: string): number {
      const w = windows.get(key);
      return w === undefined ? 0 : Math.max(1, Math.ceil((w.resetAt - now()) / 1000));
    },
  };
}
