import express from 'express'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { getBearerToken } from '../lib/appleToken.mjs'
import {
  getWrapperEventState,
  getWrapperPorts,
  probeTcp,
} from '../lib/wrapperHealth.mjs'

export const healthRouter = express.Router()

const _ports = getWrapperPorts()
const WRAPPER_HOST = _ports.host
const WRAPPER_PORTS = {
  decrypt: _ports.decrypt,
  m3u8: _ports.m3u8,
  account: _ports.account,
}
const MUSIC_PATH = process.env.AMDL_MUSIC_PATH || '/music'

function humanize(probe) {
  if (probe.ok) return probe
  if (probe.error === 'ENOTFOUND') {
    return { ...probe, error: 'wrapper container is not running' }
  }
  if (probe.error === 'ECONNREFUSED') {
    return { ...probe, error: 'wrapper is starting or has no credentials' }
  }
  return probe
}

healthRouter.get('/', async (_req, res) => {
  const [decrypt, m3u8, account, mp4box] = await Promise.all([
    probeTcp(WRAPPER_HOST, WRAPPER_PORTS.decrypt),
    probeTcp(WRAPPER_HOST, WRAPPER_PORTS.m3u8),
    probeTcp(WRAPPER_HOST, WRAPPER_PORTS.account),
    probeMp4Box(),
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
  const recentStallMs = 5 * 60_000
  const stallRecent =
    events.stallSuspectedAt && Date.now() - events.stallSuspectedAt < recentStallMs
  res.json({
    ok: wrapperUp && tokenOk && musicOk && mp4box.ok,
    wrapper: {
      host: WRAPPER_HOST,
      up: wrapperUp,
      stallRecent: Boolean(stallRecent),
      lastStallAt: events.stallSuspectedAt || null,
      lastStallAbortedAt: events.stallAbortedAt || null,
      lastDownAt: events.downAt || null,
      decrypt: humanize(decrypt),
      m3u8: humanize(m3u8),
      account: humanize(account),
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

function probeMp4Box(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const child = spawn('MP4Box', ['-version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ ok: false, error: 'timeout' })
    }, timeoutMs)

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })

    child.on('error', (err) => {
      if (err?.code === 'ENOENT') {
        finish({ ok: false, error: 'MP4Box not found in PATH' })
      } else {
        finish({ ok: false, error: err.message || 'spawn failed' })
      }
    })

    child.on('close', (code) => {
      if (code === 0 && /GPAC version/i.test(out)) {
        finish({ ok: true })
      } else {
        finish({ ok: false, error: `exit ${code ?? 'unknown'}` })
      }
    })
  })
}
