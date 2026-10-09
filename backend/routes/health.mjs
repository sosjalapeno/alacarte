import express from 'express'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { probeMp4Box } from '../lib/amdpRunner.mjs'
import { getBearerToken } from '../lib/appleToken.mjs'
import {
  getWrapperEventState,
  getWrapperPorts,
  probeTcp,
} from '../lib/wrapperHealth.mjs'
import { getSupervisorHealth } from '../lib/wrapperLogin.mjs'

export const healthRouter = express.Router()

const _ports = getWrapperPorts()
const WRAPPER_HOST = _ports.host
const WRAPPER_PORTS = {
  decrypt: _ports.decrypt,
  m3u8: _ports.m3u8,
  account: _ports.account,
}
const MUSIC_PATH = process.env.AMDL_MUSIC_PATH || '/music'
const RECOVERED_SHOW_MS = 2 * 60_000

function humanize(probe, supervisor) {
  if (probe.ok) return probe
  if (supervisor?.reason === 'unauthenticated') {
    return { ...probe, error: 'wrapper has no Apple Music credentials (sign in under Settings -> Apple Account)' }
  }
  if (supervisor?.reason === 'lease_lost') {
    return { ...probe, error: 'playback lease in use by another device' }
  }
  if (probe.error === 'ENOTFOUND') {
    return { ...probe, error: 'wrapper container is not running' }
  }
  if (probe.error === 'ECONNREFUSED') {
    return { ...probe, error: 'wrapper is starting or has no credentials' }
  }
  return probe
}

healthRouter.get('/', async (_req, res) => {
  const [decrypt, m3u8, account, mp4box, supervisor] = await Promise.all([
    probeTcp(WRAPPER_HOST, WRAPPER_PORTS.decrypt),
    probeTcp(WRAPPER_HOST, WRAPPER_PORTS.m3u8),
    probeTcp(WRAPPER_HOST, WRAPPER_PORTS.account),
    probeMp4Box(),
    getSupervisorHealth(),
  ])
  let tokenOk = false
  let tokenError = null
  try {
    const t = await getBearerToken()
    tokenOk = Boolean(t)
  } catch (err) {
    tokenError = err.message
  }
  const musicWritable = await checkWritable(MUSIC_PATH)
  const artistDirs = await checkArtistDirsWritable(MUSIC_PATH)
  const musicOk = musicWritable.ok && artistDirs.count === 0
  let musicError = musicWritable.ok ? null : musicWritable.error
  if (musicWritable.ok && artistDirs.count > 0) {
    musicError = `${artistDirs.count} artist folder(s) not writable by the container (e.g. ${artistDirs.examples.join(', ')}) — chown them to the container user`
  }
  const wrapperUp = decrypt.ok && m3u8.ok && account.ok
  const events = getWrapperEventState()
  // "Recovered" is shown for a short while after a stall ended, then the
  // pill goes back to ready; a stall still going on is reported as such.
  const stallActive = Boolean(events.stallActive)
  const stallRecent =
    !stallActive &&
    events.stallEndedAt &&
    Date.now() - events.stallEndedAt < RECOVERED_SHOW_MS
  res.json({
    ok: wrapperUp && tokenOk && musicOk && mp4box.ok,
    wrapper: {
      host: WRAPPER_HOST,
      up: wrapperUp,
      stallActive,
      stallRecent: Boolean(stallRecent),
      lastStallAt: events.stallSuspectedAt || null,
      lastStallAbortedAt: events.stallAbortedAt || null,
      lastDownAt: events.downAt || null,
      decrypt: humanize(decrypt, supervisor),
      m3u8: humanize(m3u8, supervisor),
      account: humanize(account, supervisor),
      supervisor: supervisor
        ? {
            mode: supervisor.mode,
            running: Boolean(supervisor.running),
            authenticated: Boolean(supervisor.authenticated),
            reason: supervisor.reason || null,
            restartInMs: supervisor.restartInMs ?? null,
          }
        : null,
    },
    tools: { mp4box },
    appleToken: { ok: tokenOk, error: tokenError },
    music: {
      path: MUSIC_PATH,
      ok: musicOk,
      error: musicError,
      unwritableArtistDirs: artistDirs.count,
    },
  })
})

// First-level artist folders must be writable too: the root can pass the
// writability probe while legacy root-owned artist folders make every
// download into them fail with EACCES at finalize time.
async function checkArtistDirsWritable(musicPath) {
  try {
    const entries = await fsp.readdir(musicPath, { withFileTypes: true })
    const unwritable = []
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      try {
        await fsp.access(path.join(musicPath, e.name), fs.constants.W_OK)
      } catch {
        unwritable.push(e.name)
      }
    }
    return { count: unwritable.length, examples: unwritable.slice(0, 5) }
  } catch {
    return { count: 0, examples: [] } // unreadable root is already reported
  }
}

function checkWritable(p) {
  return new Promise((resolve) => {
    fs.access(p, fs.constants.W_OK, (err) => {
      if (err) resolve({ ok: false, error: err.code || err.message })
      else resolve({ ok: true })
    })
  })
}
