import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'

// Single admission point for every request to Apple's catalog API.
//
// Apple rate-limits per source IP and answers 429 for 15-60 minutes once it trips, so
// the aim is the highest steady request rate the address tolerates and no more:
//  - lanes: interactive (UI), batch (importer, integration API, download jobs) and
//    background (schedulers, backfills, lookups nobody is waiting for). Interactive goes
//    first, batch is guaranteed a share, background only uses what is left.
//  - one adaptive gap between dispatches: it shrinks a little after a long run of
//    successes and doubles on a 429, and never drops below a floor learned from the
//    429s seen so far.
//  - after a 429 everything fails locally for a cooldown that grows with repeat
//    offences (x1, x2, x4), then a single probe call decides whether to reopen.
// State that must survive a restart (gap, floor, cooldown, history) is kept in a small
// JSON file.

export const LANES = ['interactive', 'batch', 'background']

const laneStore = new AsyncLocalStorage()
// Calls made inside fn are admitted in this lane (follows async continuations).
export const runInLane = (lane, fn) => laneStore.run(lane, fn)
// Code that does not say otherwise is treated as background, so it cannot crowd out a user.
export const currentLane = () => laneStore.getStore() || 'background'

export class AppleRateLimitedError extends Error {
  constructor(requestPath, retryAfterSec, detail) {
    // "Apple API 429 on ..." is what existing handlers match on.
    super(`Apple API 429 on ${requestPath || '/'}: ${detail}`)
    this.name = 'AppleRateLimitedError'
    this.status = 429
    this.retryAfterSec = retryAfterSec
    this.local = true
  }
}

const HOUR = 60 * 60 * 1000
const STRIKE_MULTIPLIERS = [1, 2, 4]

export function createGateway({
  intervalMs: defaultIntervalMs = 1500,
  minIntervalMs: defaultMinIntervalMs = 600,
  maxIntervalMs = 8000,
  speedUpAfter = 100,
  speedUpFactor = 0.9,
  burst = 4,
  maxInFlight = 2,
  batchEvery = 4, // while interactive calls keep coming, every 4th dispatch is a batch one
  interactiveMaxWaitMs = 30_000,
  cooldownBaseMs: defaultCooldownBaseMs = 15 * 60 * 1000,
  strikeWindowMs = 24 * HOUR,
  stateFile = null,
  now = () => Date.now(),
} = {}) {
  const queues = { interactive: [], batch: [], background: [] }
  const dispatched = { interactive: 0, batch: 0, background: 0 }
  // Settings the user can change at runtime (configure()); null/undefined = default.
  let startIntervalMs = defaultIntervalMs
  let minIntervalMs = defaultMinIntervalMs
  let cooldownBaseMs = defaultCooldownBaseMs
  let adaptive = true
  // Raised by every 429: never go faster than a margin above a pace that failed.
  let learnedFloor = 0
  let interval = startIntervalMs
  let cooldownUntil = 0
  let probing = false
  let strikes = 0
  let lastStrikeAt = 0
  let history = []
  let successStreak = 0
  let allowance = burst
  let lastRefillAt = now()
  let lastDispatchAt = 0
  let inFlight = 0
  let interactiveRun = 0
  let timer = null

  const floor = () => Math.max(minIntervalMs, learnedFloor)

  function load() {
    if (!stateFile) return
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (Number.isFinite(s.learnedFloor)) learnedFloor = Math.max(0, s.learnedFloor)
      if (Number.isFinite(s.interval)) interval = Math.min(maxIntervalMs, Math.max(0, s.interval))
      interval = Math.max(floor(), interval)
      cooldownUntil = Number(s.cooldownUntil) || 0
      strikes = Number(s.strikes) || 0
      lastStrikeAt = Number(s.lastStrikeAt) || 0
      history = Array.isArray(s.history) ? s.history.slice(-20) : []
    } catch {}
  }

  function save() {
    if (!stateFile) return
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ interval, learnedFloor, cooldownUntil, strikes, lastStrikeAt, history }),
      )
    } catch {}
  }

  load()

  function inCooldown() {
    if (cooldownUntil > 0 && now() >= cooldownUntil) {
      // Cooldown over: let exactly one call through to see whether Apple has reopened.
      cooldownUntil = 0
      probing = true
      save()
    }
    return cooldownUntil > 0
  }

  function cooldownRemainingMs() {
    return inCooldown() ? cooldownUntil - now() : 0
  }

  const retryAfterSec = () => Math.max(1, Math.ceil(cooldownRemainingMs() / 1000))

  function limitedError(requestPath) {
    return new AppleRateLimitedError(
      requestPath,
      retryAfterSec(),
      `rate limited by Apple, retry in ${retryAfterSec()}s`,
    )
  }

  function rejectQueued() {
    for (const lane of LANES) {
      for (const entry of queues[lane].splice(0)) {
        clearTimeout(entry.timer)
        entry.reject(limitedError(entry.path))
      }
    }
  }

  function refill() {
    const t = now()
    allowance = interval > 0 ? Math.min(burst, allowance + (t - lastRefillAt) / interval) : burst
    lastRefillAt = t
  }

  // Milliseconds until this lane may dispatch. Interactive may burst (up to `burst`
  // calls saved up while idle); the other lanes are strictly spaced.
  function waitFor(lane) {
    if (interval <= 0) return 0
    refill()
    if (lane === 'interactive') return allowance >= 1 ? 0 : Math.ceil((1 - allowance) * interval)
    return Math.max(0, lastDispatchAt + interval - now())
  }

  function nextLane() {
    const { interactive, batch, background } = queues
    if (interactive.length && !(batch.length && interactiveRun >= batchEvery - 1)) return 'interactive'
    if (batch.length) return 'batch'
    if (interactive.length) return 'interactive'
    return background.length ? 'background' : null
  }

  function pump() {
    clearTimeout(timer)
    timer = null
    while (true) {
      if (inCooldown()) return rejectQueued()
      const lane = nextLane()
      if (!lane) return
      if (inFlight >= (probing ? 1 : maxInFlight)) return // re-pumped when a call settles
      const wait = waitFor(lane)
      if (wait > 0) {
        timer = setTimeout(pump, wait)
        timer.unref?.()
        return
      }
      dispatch(lane)
    }
  }

  function dispatch(lane) {
    const entry = queues[lane].shift()
    clearTimeout(entry.timer)
    interactiveRun = lane === 'interactive' ? interactiveRun + 1 : 0
    dispatched[lane] += 1
    lastDispatchAt = now()
    allowance = Math.max(0, allowance - 1)
    inFlight += 1
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        inFlight -= 1
        pump()
      })
  }

  function schedule(task, { lane = 'background', path: requestPath = '' } = {}) {
    if (!LANES.includes(lane)) lane = 'background'
    if (inCooldown()) return Promise.reject(limitedError(requestPath))
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, path: requestPath, timer: null }
      if (lane === 'interactive' && interactiveMaxWaitMs > 0) {
        entry.timer = setTimeout(() => {
          const i = queues.interactive.indexOf(entry)
          if (i === -1) return
          queues.interactive.splice(i, 1)
          reject(new AppleRateLimitedError(requestPath, 5, 'busy, try again in a moment'))
        }, interactiveMaxWaitMs)
        entry.timer.unref?.()
      }
      queues[lane].push(entry)
      pump()
    })
  }

  function onRateLimited() {
    const t = now()
    strikes = t - lastStrikeAt < strikeWindowMs ? strikes + 1 : 1
    lastStrikeAt = t
    const cooldownMs = cooldownBaseMs * STRIKE_MULTIPLIERS[Math.min(strikes - 1, STRIKE_MULTIPLIERS.length - 1)]
    // This pace was too fast: never go back below a margin above it.
    learnedFloor = Math.min(maxIntervalMs, Math.max(learnedFloor, Math.round(interval * 1.25)))
    history.push({ at: t, intervalMs: interval, strikes, cooldownMs })
    history = history.slice(-20)
    interval = Math.min(maxIntervalMs, Math.max(floor(), interval * 2))
    successStreak = 0
    probing = false
    cooldownUntil = cooldownMs > 0 ? t + cooldownMs : 0
    save()
    if (cooldownUntil > 0) rejectQueued()
  }

  // Called by the request code with the HTTP status of each completed call.
  function report(status) {
    if (status === 429) return onRateLimited()
    if (status >= 500) return
    probing = false
    successStreak += 1
    if (adaptive && successStreak >= speedUpAfter && interval > floor()) {
      interval = Math.max(floor(), Math.round(interval * speedUpFactor))
      successStreak = 0
      save()
    }
  }

  function status() {
    const t = now()
    const recent = history.filter((h) => t - h.at < 24 * HOUR)
    const cooling = inCooldown()
    return {
      state: cooling ? 'cooldown' : probing ? 'probing' : 'ok',
      cooldownSeconds: cooling ? Math.ceil((cooldownUntil - t) / 1000) : 0,
      intervalMs: interval,
      floorMs: floor(),
      learnedFloorMs: learnedFloor,
      config: {
        intervalMs: startIntervalMs,
        minIntervalMs,
        adaptive,
        cooldownMinutes: Math.round(cooldownBaseMs / 60_000),
      },
      inFlight,
      queued: {
        interactive: queues.interactive.length,
        batch: queues.batch.length,
        background: queues.background.length,
      },
      dispatched: { ...dispatched },
      strikes,
      rateLimited24h: recent.length,
      lastRateLimitedAt: history.length ? history[history.length - 1].at : null,
    }
  }

  // Applies user settings. A key that is null/undefined goes back to its default.
  // resetPace: false (used at boot) keeps the pace the gateway had adapted to.
  function configure(
    { intervalMs, minIntervalMs: min, adaptive: auto, cooldownMinutes } = {},
    { resetPace = true } = {},
  ) {
    startIntervalMs = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : defaultIntervalMs
    minIntervalMs = Number.isFinite(min) ? Math.max(0, min) : defaultMinIntervalMs
    adaptive = auto !== false
    cooldownBaseMs = Number.isFinite(cooldownMinutes) ? Math.max(0, cooldownMinutes * 60_000) : defaultCooldownBaseMs
    // The configured starting gap applies right away (never below the floor).
    interval = Math.min(maxIntervalMs, Math.max(floor(), resetPace ? startIntervalMs : interval))
    if (resetPace) successStreak = 0
    save()
    pump()
  }

  // Forgets what 429s taught it (the raised floor and the strike count); a running
  // cooldown stays.
  function resetLearned() {
    learnedFloor = 0
    strikes = 0
    history = []
    interval = Math.min(maxIntervalMs, Math.max(floor(), startIntervalMs))
    successStreak = 0
    save()
  }

  return { schedule, report, status, cooldownRemainingMs, configure, resetLearned }
}

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v))

// Process-wide instance, tuned through environment variables.
export const appleGateway = createGateway({
  intervalMs: num(process.env.APPLE_GATEWAY_INTERVAL_MS, 1500),
  minIntervalMs: num(process.env.APPLE_GATEWAY_MIN_INTERVAL_MS, 600),
  cooldownBaseMs: num(process.env.APPLE_429_COOLDOWN_MS, 15 * 60 * 1000),
  stateFile: path.join(process.env.AMDL_CONFIG_DIR || '/config', 'apple-rate.json'),
})
