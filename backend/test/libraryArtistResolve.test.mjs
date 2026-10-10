import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-artist-resolve-'))
const tmpMusic = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-artist-resolve-music-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic
// This test mocks a 429 for one artist and expects the rest to still resolve.
process.env.APPLE_429_COOLDOWN_MS = '0'
process.env.APPLE_GATEWAY_INTERVAL_MS = '0'
process.env.APPLE_GATEWAY_MIN_INTERVAL_MS = '0'
process.env.AMDL_ARTIST_RESOLVE_INTERVAL_MS = '1'
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const ARTISTS = Array.from({ length: 20 }, (_, i) => `Artist ${i}`)
for (const name of [...ARTISTS, '龘Broken', '颜人中']) {
  fs.mkdirSync(path.join(tmpMusic, name, 'Album'), { recursive: true })
  fs.writeFileSync(path.join(tmpMusic, name, 'Album', '01. Song.flac'), 'x')
}

const realFetch = globalThis.fetch
let tokenFetches = 0
let inFlightSearches = 0
let maxInFlightSearches = 0
const searchedTerms = []
globalThis.fetch = async (url) => {
  const u = String(url)
  await new Promise((r) => setTimeout(r, 20))
  if (u === 'https://music.apple.com') {
    tokenFetches++
    return new Response('<script src="/assets/index~abc.js"></script>')
  }
  if (u.includes('/assets/index~')) return new Response('x="eyJa.eyJb.sig"')
  const term = new URL(u).searchParams.get('term')
  searchedTerms.push(term)
  inFlightSearches++
  maxInFlightSearches = Math.max(maxInFlightSearches, inFlightSearches)
  await new Promise((r) => setTimeout(r, 20))
  inFlightSearches--
  if (term === '龘Broken') return new Response('slow down', { status: 429 })
  return Response.json({
    results: {
      artists: {
        data: [{ id: `id-${term}`, attributes: { name: term } }],
      },
    },
  })
}

const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset

const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpConfig)
loadSecretsAtBoot(tmpConfig)
const { libraryRouter } = await import('../routes/library.mjs')

test.after(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
})

async function getLibrary() {
  const app = express()
  app.use('/api/library', libraryRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/library`)
    return res.json()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const waitFor = async (cond) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}
const idOf = (lib, artist) => lib.albums.find((a) => a.artistName === artist).artistId

test('GET /api/library answers from disk and makes no Apple call while the request waits', async () => {
  const lib = await getLibrary()
  assert.equal(lib.albums.length, 22)
  assert.equal(idOf(lib, 'Artist 3'), null)
  assert.equal(searchedTerms.length, 0, 'no lookup happens inside the request')
})

test('missing artist ids are looked up one at a time in the background and stored', async () => {
  await waitFor(() => searchedTerms.length >= 22)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(searchedTerms.length, 22)
  assert.equal(maxInFlightSearches, 1)
  const lib = await getLibrary()
  assert.equal(idOf(lib, 'Artist 3'), 'id-Artist 3')
  assert.equal(idOf(lib, '颜人中'), 'id-颜人中', 'non-Latin names resolve too')
})

test('a failed (429) lookup is not stored, resolved ones are never looked up again', async () => {
  const before = searchedTerms.length
  const lib = await getLibrary()
  assert.equal(idOf(lib, '龘Broken'), null)
  await new Promise((r) => setTimeout(r, 50))
  // only the unresolved artist is retried, once, and the run stops on the 429
  assert.deepEqual(searchedTerms.slice(before), ['龘Broken'])
  offset = 6 * 24 * 60 * 60 * 1000
  const lib2 = await getLibrary()
  assert.equal(idOf(lib2, 'Artist 3'), 'id-Artist 3')
  await waitFor(() => searchedTerms.length - before >= 2)
  assert.deepEqual(searchedTerms.slice(before), ['龘Broken', '龘Broken'])
})
