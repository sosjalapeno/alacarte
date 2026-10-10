export const isAppleRateLimited = (err) =>
  err?.status === 429 || /^Apple API 429\b/.test(String(err?.message || ''))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Apple's per-IP limit lasts 15-60 minutes, so retrying quickly only prolongs it.
// Waits when the error gives no hint (err.retryAfterSec), growing with each attempt.
export const BACKOFF_SECONDS = [60, 120, 300, 600, 900]

// For long-running jobs: pauses until Apple is expected to accept calls again.
// onWait(untilMs) is called when the pause starts and onWait(null) when it ends, so the
// job can show "waiting for Apple, resumes in ..." instead of failing items.
export async function waitOutRateLimit(
  err,
  { attempt = 0, shouldStop = () => false, onWait = () => {} } = {},
) {
  const fallback = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)]
  const seconds = Math.max(1, Number(err?.retryAfterSec) || fallback)
  const until = Date.now() + seconds * 1000
  onWait(until)
  try {
    while (Date.now() < until && !shouldStop()) await sleep(Math.min(1000, until - Date.now()))
  } finally {
    onWait(null)
  }
}

// Runs fn, and while Apple is rate limiting waits it out and tries again (until
// shouldStop() says the job was cancelled). Any other error is thrown as is.
export async function withAppleRetry(fn, opts = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      if (!isAppleRateLimited(err) || opts.shouldStop?.()) throw err
      await waitOutRateLimit(err, { ...opts, attempt })
      if (opts.shouldStop?.()) throw err
    }
  }
}
