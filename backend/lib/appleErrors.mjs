import { AppleRateLimitedError } from './appleGateway.mjs'

// Sends an Apple-API failure to the client. A rate limit (Apple's 429, or our own
// local cooldown / busy rejection) becomes a 429 with Retry-After and a readable
// message instead of a generic 502.
export function sendAppleError(res, err, fallbackStatus = 502) {
  if (err instanceof AppleRateLimitedError || /^Apple API 429\b/.test(String(err?.message))) {
    const wait = Number(err?.retryAfterSec) || 60
    res.set('Retry-After', String(wait))
    const mins = Math.ceil(wait / 60)
    return res.status(429).json({
      error:
        wait >= 60
          ? `Apple is rate limiting this server. Try again in about ${mins} min.`
          : 'Apple is busy, try again in a moment.',
      retryAfterSec: wait,
    })
  }
  return res.status(fallbackStatus).json({ error: err.message })
}
