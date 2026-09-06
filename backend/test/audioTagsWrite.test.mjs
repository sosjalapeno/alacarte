import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const hasFfmpeg =
    spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0

const { writeAudioIdentityTags, readAudioMetaTags } = await import(
    '../lib/audioTags.mjs'
)
const { readAudioIdentityTagsSync } = await import('../lib/audioTags.mjs')
const { __test__ } = await import('../lib/queue.mjs')

function makeRealFlac(dir, name, { title } = {}) {
    fs.mkdirSync(dir, { recursive: true })
    const abs = path.join(dir, name)
    const args = [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.05',
        '-c:a',
        'flac',
    ]
    if (title) args.push('-metadata', `TITLE=${title}`)
    args.push(abs)
    const res = spawnSync('ffmpeg', args, { encoding: 'utf8' })
    if (res.status !== 0) throw new Error('ffmpeg could not create test flac')
    return abs
}

test('writeAudioIdentityTags stamps isrc and barcode without losing metadata', (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alacarte-tagwrite-'))
    const file = makeRealFlac(dir, '01. Song.flac', { title: 'Song' })

    const ok = writeAudioIdentityTags(file, {
        isrc: 'us-um7-25-00427',
        upc: '00888072804555',
    })
    assert.equal(ok, true)

    const identity = readAudioIdentityTagsSync(file)
    assert.equal(identity.isrc, 'USUM72500427')
    assert.equal(identity.upc, '00888072804555')

    const meta = readAudioMetaTags(file)
    assert.equal(meta.title, 'Song')
})

test('writeAudioIdentityTags rejects non-flac and empty input', (t) => {
    if (!hasFfmpeg) {
        t.skip('ffmpeg not available on this host')
        return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alacarte-tagwrite-'))
    const m4a = path.join(dir, 'song.m4a')
    fs.writeFileSync(m4a, 'x')
    assert.equal(writeAudioIdentityTags(m4a, { isrc: 'USUM72500427' }), false)

    const flac = makeRealFlac(dir, 'song.flac')
    assert.equal(writeAudioIdentityTags(flac, {}), false)
    assert.equal(fs.existsSync(flac), true)
})

test('matchTrackForFile matches by track number then title', () => {
    const tracks = [
        { name: 'GONE FISHING', trackNumber: 1, isrc: 'AAA111111111' },
        { name: 'EVIL GRIN', trackNumber: 2, isrc: 'BBB222222222' },
        { name: 'Some Song (feat. X)', trackNumber: 3, isrc: 'CCC333333333' },
    ]
    const { matchTrackForFile } = __test__
    assert.equal(matchTrackForFile('01. GONE FISHING.flac', tracks).isrc, 'AAA111111111')
    assert.equal(matchTrackForFile('2. EVIL GRIN.flac', tracks).isrc, 'BBB222222222')
    assert.equal(
        matchTrackForFile('03. Some Song [E].flac', tracks).isrc,
        'CCC333333333',
    )
    // number prefix wins even if the title drifted
    assert.equal(
        matchTrackForFile('01. Wrong Name Here.flac', tracks).isrc,
        'AAA111111111',
    )
    assert.equal(matchTrackForFile('99. Unknown.flac', tracks), null)
    assert.equal(matchTrackForFile('anything.flac', null), null)
})
