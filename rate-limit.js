// rate-limit.js - Minimal in-memory, per-IP fixed-window rate limiter. No external dependency —
// consistent with this codebase's existing preference for small hand-rolled utilities over a
// package for a simple need (see proxy-config.js's withBrowserSlot for the same philosophy). Only
// ever needs to survive one process's lifetime — a restart resetting every counter is harmless
// here — so a plain in-memory Map is sufficient, no Mongo/Redis required.

function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Sweeps expired windows periodically so `hits` doesn't grow unbounded across every distinct IP
  // that's ever hit this limiter. unref() so this timer never keeps the process alive on its own.
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }, windowMs).unref();

  function middleware(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    let entry = hits.get(ip);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }

    entry.count++;

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests — try again shortly.' });
    }

    next();
  }

  // Test-only escape hatch — lets a test tear down the sweep timer instead of waiting on unref()
  // (which only stops the timer from keeping the PROCESS alive, not from firing).
  middleware.stopSweep = () => clearInterval(sweepInterval);
  return middleware;
}

module.exports = { createRateLimiter };
