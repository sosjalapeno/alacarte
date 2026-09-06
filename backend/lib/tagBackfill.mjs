import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent } from './eventBus.mjs'
import {
    readAudioIdentityTags,
    readAudioMetaTags,
    writeAudioIdentityTags,
} from './audioTags.mjs'
import { readSettings } from './settingsStore.mjs'
import { searchCatalog } from './appleApi.mjs'
import { invalidateLibraryCache } from './libraryIndex.mjs'
import { normalizeForMatchKey } from './libraryMatchKey.mjs'

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'
const SEARCH_DELAY_MS = 250
const PROGRESS_MIN_INTERVAL_MS = 400

// One shared background run: resolves untagged FLACs against the Apple
// catalog and stamps ISRC/BARCODE so presence matching works regardless of
// folder naming. Long-running by nature (a catalog search per file), hence
// the start/status/stop shape instead of a request/response endpoint.
const state = {
    running: false,
    dryRun: false,
    scanned: 0,
    total: 0,
    stamped: 0,
    skipped: 0,
    noMatch: 0,
    failed: 0,
    current: null,
    startedAt: null,
    finishedAt: null,
    stopRequested: false,
    error: null,
}

const defaultDeps = {
    searchCatalog,
    readSettings,
    now: () => Date.now(),
}

let lastEmitAt = 0

function status() {
    return {
        running: state.running,
        dryRun: state.dryRun,
        scanned: state.scanned,
        total: state.total,
        stamped: state.stamped,
        skipped: state.skipped,
        noMatch: state.noMatch,
        failed: state.failed,
        current: state.current,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        stopRequested: state.stopRequested,
        error: state.error,
    }
}

export function getTagBackfillStatus() {
    return status()
}

export function stopTagBackfill() {
    if (!state.running) return { ok: false, running: false }
    state.stopRequested = true
    emit(true)
    return { ok: true, running: true }
}

function emit(force = false) {
    const now = Date.now()
    if (!force && now - lastEmitAt < PROGRESS_MIN_INTERVAL_MS) return
    lastEmitAt = now
    emitEvent('tags.backfill.progress', {
        ...status(),
        done: !state.running,
    })
}

function nameMatchesLoose(a, b) {
    const x = normalizeForMatchKey(a).toLowerCase()
    const y = normalizeForMatchKey(b).toLowerCase()
    if (!x || !y) return false
    return x === y || y.startsWith(`${x} `) || x.startsWith(`${y} `)
}

function artistMatchesLoose(a, b) {
    const tokens = normalizeForMatchKey(a)
        .toLowerCase()
        .split(' ')
        .filter(Boolean)
    const pool = new Set(
        normalizeForMatchKey(b)
            .toLowerCase()
            .split(' ')
            .filter(Boolean),
    )
    if (tokens.length === 0 || pool.size === 0) return false
    return tokens.every((t) => pool.has(t))
}

async function collectFlacs(dir, out) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            await collectFlacs(abs, out)
        } else if (/\.flac$/i.test(entry.name)) {
            out.push(abs)
        }
    }
}

async function resolveFile(file, { searchCatalog: search, settings }) {
    const meta = readAudioMetaTags(file)
    const artist = meta.albumArtist || meta.artist
    const title = meta.title
    if (!artist || !title) return null

    let songs = []
    let albums = []
    try {
        const json = await search({
            storefront: settings.storefront || 'us',
            term: `${artist} ${title}`.trim(),
            types: 'songs,albums',
            limit: 10,
            language: settings.language || 'en-US',
        })
        songs = json?.results?.songs?.data || []
        albums = json?.results?.albums?.data || []
    } catch {
        return null
    }

    let bestSong = null
    let bestSongScore = -1
    for (const raw of songs) {
        const a = raw.attributes || {}
        let score = 0
        if (nameMatchesLoose(title, a.name)) score += 4
        if (artistMatchesLoose(artist, a.artistName)) score += 3
        if (meta.album && nameMatchesLoose(meta.album, a.albumName || '')) {
            score += 2
        }
        if (score > bestSongScore) {
            bestSongScore = score
            bestSong = raw
        }
    }
    if (bestSongScore < 7 || !bestSong?.attributes?.isrc) return null

    const songAlbumName = bestSong.attributes?.albumName || ''
    const albumNameCandidate = meta.album || songAlbumName
    let upc = null
    for (const raw of albums) {
        const a = raw.attributes || {}
        if (
            albumNameCandidate &&
            nameMatchesLoose(albumNameCandidate, a.name) &&
            artistMatchesLoose(artist, a.artistName)
        ) {
            upc = a.upc || null
            break
        }
    }

    return { isrc: bestSong.attributes.isrc, upc }
}

async function runBackfill(deps) {
    try {
        const settings = await deps.readSettings()
        const files = []
        await collectFlacs(MUSIC_ROOT, files)
        state.total = files.length
        emit(true)

        for (const file of files) {
            if (state.stopRequested) break
            const rel = path.relative(MUSIC_ROOT, file)
            state.current = rel
            state.scanned += 1
            const existing = await readAudioIdentityTags(file)
            if (existing.isrc && existing.upc) {
                state.skipped += 1
                emit()
                continue
            }
            try {
                const match = await resolveFile(file, {
                    searchCatalog: deps.searchCatalog,
                    settings,
                })
                if (!match) {
                    state.noMatch += 1
                    emit()
                    continue
                }
                const needsIsrc = !existing.isrc && match.isrc
                const needsUpc = !existing.upc && match.upc
                if (!needsIsrc && !needsUpc) {
                    state.skipped += 1
                    emit()
                    continue
                }
                if (!state.dryRun) {
                    const ok = writeAudioIdentityTags(file, {
                        isrc: needsIsrc ? match.isrc : null,
                        upc: needsUpc ? match.upc : null,
                    })
                    if (!ok) {
                        state.failed += 1
                        emit()
                        continue
                    }
                    await fsp
                        .utimes(path.dirname(file), new Date(), new Date())
                        .catch(() => null)
                }
                state.stamped += 1
                emit()
            } catch (err) {
                state.failed += 1
                state.error = err.message || 'backfill error'
                emit()
            }
            await new Promise((resolve) =>
                setTimeout(resolve, SEARCH_DELAY_MS),
            )
        }
    } catch (err) {
        state.error = err.message || 'backfill failed'
    } finally {
        state.running = false
        state.current = null
        state.finishedAt = deps.now()
        if (!state.dryRun && state.stamped > 0) {
            invalidateLibraryCache()
        }
        emit(true)
    }
}

export async function startTagBackfill({ dryRun = false, deps = defaultDeps } = {}) {
    if (state.running) {
        const err = new Error('a tag backfill is already running')
        err.statusCode = 409
        throw err
    }
    state.running = true
    state.dryRun = Boolean(dryRun)
    state.scanned = 0
    state.total = 0
    state.stamped = 0
    state.skipped = 0
    state.noMatch = 0
    state.failed = 0
    state.current = null
    state.startedAt = deps.now()
    state.finishedAt = null
    state.stopRequested = false
    state.error = null
    emit(true)

    runBackfill(deps).catch(() => {
        state.running = false
        state.finishedAt = deps.now()
        emit(true)
    })
    return status()
}
