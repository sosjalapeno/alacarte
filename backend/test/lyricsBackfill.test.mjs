import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tmpConfig = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alacarte-lyrics-cfg-'))
const tmpMusic = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alacarte-lyrics-music-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic

const { startLyricsBackfill, getLyricsBackfillStatus, ttmlToLrc } = await import('../lib/lyricsBackfill.mjs')
const { buildMinimalFlacWithTags } = await import('../lib/audioTags.mjs')

function makeFlac(rel, isrc) {
  const abs = path.join(tmpMusic, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buildMinimalFlacWithTags(isrc ? { isrc } : {}))
  return abs
}

const TTML =
  '<tt xmlns="http://www.w3.org/ns/ttml" itunes:timing="Line"><body><div>' +
  '<p begin="6.399" end="7.4">I been waitin&apos; on this</p>' +
  '<p begin="1:02.5" end="1:03">Rock &amp; <span>roll</span></p>' +
  '</div></body></tt>'

async function waitUntilDone() {
  const t0 = Date.now()
  while (getLyricsBackfillStatus().running) {
    if (Date.now() - t0 > 10_000) throw new Error('backfill did not finish')
    await new Promise((r) => setTimeout(r, 20))
  }
  return getLyricsBackfillStatus()
}

function deps(overrides = {}) {
  return {
    readSettings: async () => ({ storefront: 'pl', language: 'en-US', lyricsFormat: 'lrc' }),
    readAppleCreds: async () => ({ mediaUserToken: 'token' }),
    getSongsByIsrc: async ({ isrcs }) => ({
      data: isrcs.map((isrc) => ({
        id: `id-${isrc}`,
        attributes: { isrc, hasLyrics: isrc !== 'NOLYRICS0001' },
      })).filter((s) => s.attributes.isrc !== 'UNKNOWN00001'),
    }),
    getSongLyricsTtml: async () => TTML,
    triggerNavidromeScan: async () => {},
    delayMs: 0,
    now: () => Date.now(),
    ...overrides,
  }
}

test('ttmlToLrc writes amdp-style synced lines and decodes entities', () => {
  assert.equal(ttmlToLrc(TTML), "[00:06.39]I been waitin' on this\n[01:02.50]Rock & roll\n")
  assert.equal(
    ttmlToLrc('<tt itunes:timing="None"><p>one</p><p>two</p></tt>'),
    'one\ntwo\n',
  )
  assert.equal(ttmlToLrc('<tt></tt>'), null)
})

test('backfill only fills tracks that have no lyrics sidecar', async () => {
  const withLyrics = makeFlac('A/Album/01. Has.flac', 'USAAA0000001')
  fs.writeFileSync(withLyrics.replace(/\.flac$/, '.lrc'), 'keep me\n')
  const missing = makeFlac('A/Album/02. Missing.flac', 'USAAA0000002')
  makeFlac('A/Album/03. NoLyrics.flac', 'NOLYRICS0001')
  makeFlac('A/Album/04. Unknown.flac', 'UNKNOWN00001')
  makeFlac('A/Album/05. NoIsrc.flac', null)

  const requested = []
  await startLyricsBackfill({
    deps: deps({
      getSongLyricsTtml: async ({ id, mediaUserToken }) => {
        requested.push([id, mediaUserToken])
        return TTML
      },
    }),
  })
  const s = await waitUntilDone()

  assert.equal(s.total, 5)
  assert.equal(s.scanned, 5)
  assert.deepEqual(
    { added: s.added, skipped: s.skipped, noLyrics: s.noLyrics, noMatch: s.noMatch, failed: s.failed },
    { added: 1, skipped: 1, noLyrics: 1, noMatch: 2, failed: 0 },
  )
  assert.deepEqual(requested, [['id-USAAA0000002', 'token']])
  assert.equal(fs.readFileSync(withLyrics.replace(/\.flac$/, '.lrc'), 'utf8'), 'keep me\n')
  assert.match(fs.readFileSync(missing.replace(/\.flac$/, '.lrc'), 'utf8'), /^\[00:06\.39\]/)
})

test('backfill refuses to start without a media-user-token', async () => {
  await assert.rejects(
    startLyricsBackfill({ deps: deps({ readAppleCreds: async () => ({}) }), }),
    (err) => err.statusCode === 412,
  )
})

const read = (p) => fs.readFileSync(p, 'utf8')
const sidecars = (flac) => ({
  lrc: flac.replace(/\.flac$/, '.lrc'),
  ttml: flac.replace(/\.flac$/, '.ttml'),
})

async function run(format, overrides = {}) {
  const requested = []
  await startLyricsBackfill({
    deps: deps({
      readSettings: async () => ({ storefront: 'pl', language: 'en-US', lyricsFormat: format }),
      getSongLyricsTtml: async ({ id }) => {
        requested.push(id)
        return TTML
      },
      ...overrides,
    }),
  })
  await waitUntilDone()
  return requested
}

function reset() {
  for (const name of fs.readdirSync(tmpMusic)) fs.rmSync(path.join(tmpMusic, name), { recursive: true, force: true })
}

test("format 'both': an existing .ttml is converted to .lrc locally and left in place", async () => {
  reset()
  const flac = makeFlac('B/Album/01. Song.flac', 'USBBB0000001')
  const { lrc, ttml } = sidecars(flac)
  fs.writeFileSync(ttml, TTML)
  const requested = await run('both')
  assert.equal(read(ttml), TTML)
  assert.equal(read(lrc), "[00:06.39]I been waitin' on this\n[01:02.50]Rock & roll\n")
  assert.deepEqual(requested, [], 'no Apple call needed')
  const st = getLyricsBackfillStatus()
  assert.equal(st.converted, 1)
  assert.equal(st.added, 0)
})

test("format 'both': an existing .lrc stays untouched and the .ttml is downloaded next to it", async () => {
  reset()
  const flac = makeFlac('B/Album/02. Song.flac', 'USBBB0000002')
  const { lrc, ttml } = sidecars(flac)
  fs.writeFileSync(lrc, 'my own lyrics\n')
  const requested = await run('both')
  assert.equal(read(lrc), 'my own lyrics\n')
  assert.equal(read(ttml), TTML)
  assert.deepEqual(requested, ['id-USBBB0000002'])
})

test("format 'both': a track with no lyrics gets both, from one download", async () => {
  reset()
  const flac = makeFlac('B/Album/03. Song.flac', 'USBBB0000003')
  const { lrc, ttml } = sidecars(flac)
  const requested = await run('both')
  assert.equal(read(ttml), TTML)
  assert.match(read(lrc), /^\[00:06\.39\]/)
  assert.equal(requested.length, 1)
  assert.equal(getLyricsBackfillStatus().added, 1)
})

test("format 'ttml' keeps an existing .lrc and adds the .ttml; 'lrc' keeps an existing .ttml and adds the .lrc", async () => {
  reset()
  const a = makeFlac('B/Album/04. Song.flac', 'USBBB0000004')
  fs.writeFileSync(sidecars(a).lrc, 'old lrc\n')
  await run('ttml')
  assert.equal(read(sidecars(a).lrc), 'old lrc\n')
  assert.equal(read(sidecars(a).ttml), TTML)

  reset()
  const b = makeFlac('B/Album/05. Song.flac', 'USBBB0000005')
  fs.writeFileSync(sidecars(b).ttml, TTML)
  await run('lrc')
  assert.equal(read(sidecars(b).ttml), TTML)
  assert.match(read(sidecars(b).lrc), /^\[00:06\.39\]/)
})

test('a track that already has every wanted format is skipped without any call', async () => {
  reset()
  const flac = makeFlac('B/Album/06. Song.flac', 'USBBB0000006')
  fs.writeFileSync(sidecars(flac).lrc, 'a\n')
  fs.writeFileSync(sidecars(flac).ttml, 'b\n')
  let lookups = 0
  await run('both', { getSongsByIsrc: async () => { lookups += 1; return { data: [] } } })
  assert.equal(lookups, 0)
  assert.equal(getLyricsBackfillStatus().skipped, 1)
  assert.equal(read(sidecars(flac).ttml), 'b\n')
})
