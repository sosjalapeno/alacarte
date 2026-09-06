import fsp from 'node:fs/promises'
import path from 'node:path'

import { artworkUrl } from './appleApi.mjs'
import { ensureDir, sanitizeSegment } from './folderLayout.mjs'
import { purgePlaylistExportsSharingIds } from './libraryIndex.mjs'

const MUSIC_ROOT = process.env.AMDL_MUSIC_PATH || '/music'

// Shared playlist export writer: m3u8 under <music>/Playlists plus an Apple
// cover image sidecar. Used by full playlist downloads and followed-playlist
// syncs alike so both produce the same file conventions.
export async function writePlaylistM3U({
    playlistName,
    playlistId,
    libraryPlaylistId,
    tracks,
    artworkTemplate,
    reuseArtwork = false,
}) {
    const playlistsDir = path.join(MUSIC_ROOT, 'Playlists')
    await ensureDir(playlistsDir)
    const base = sanitizeSegment(playlistName || 'Playlist')
    const filePath = path.join(playlistsDir, `${base}.m3u8`)

    await purgePlaylistExportsSharingIds(MUSIC_ROOT, {
        playlistId,
        libraryPlaylistId,
        keepAbsPath: filePath,
    })

    const lines = ['#EXTM3U', `#PLAYLIST:${playlistName || 'Playlist'}`]
    if (playlistId) {
        lines.push(`#ALACARTE_PLAYLIST_ID:${playlistId}`)
    }
    if (libraryPlaylistId) {
        lines.push(`#ALACARTE_LIBRARY_PLAYLIST_ID:${libraryPlaylistId}`)
    }
    for (const absPath of tracks) {
        const rel = path
            .relative(playlistsDir, absPath)
            .split(path.sep)
            .join('/')
        lines.push(rel)
    }
    await fsp.writeFile(filePath, `${lines.join('\n')}\n`, { mode: 0o664 })

    // Frequent rebuilds (followed-playlist syncs) reuse an existing cover
    // instead of re-fetching the artwork on every write.
    let existingCover = null
    if (reuseArtwork) {
        for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
            const candidate = path.join(playlistsDir, `${base}${ext}`)
            const stat = await fsp.stat(candidate).catch(() => null)
            if (stat?.isFile()) {
                existingCover = candidate
                break
            }
        }
    }
    if (!existingCover) {
        await unlinkPlaylistImageSidecars(playlistsDir, base)
        if (artworkTemplate) {
            await writePlaylistCoverFromAppleTemplate(
                artworkTemplate,
                path.join(playlistsDir, `${base}.jpg`),
            )
        }
    }
    return filePath
}

export async function unlinkPlaylistImageSidecars(playlistsDir, base) {
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
        await fsp.unlink(path.join(playlistsDir, `${base}${ext}`)).catch(() => null)
    }
}

export async function writePlaylistCoverFromAppleTemplate(artworkTemplate, absImagePathHint) {
    const urlStr = artworkUrl(artworkTemplate, 1200)
    if (!urlStr) return
    try {
        const res = await fetch(urlStr, {
            redirect: 'follow',
            headers: { Accept: 'image/*', 'User-Agent': 'ALACarte/playlist-artwork' },
        })
        if (!res.ok) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length < 500) return
        const dot = absImagePathHint.lastIndexOf('.')
        const basePath = dot > 0 ? absImagePathHint.slice(0, dot) : absImagePathHint
        let dest
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
            dest = `${basePath}.jpg`
        } else if (
            buf.length >= 8 &&
            buf[0] === 0x89 &&
            buf[1] === 0x50 &&
            buf[2] === 0x4e &&
            buf[3] === 0x47
        ) {
            dest = `${basePath}.png`
        } else if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') {
            dest = `${basePath}.webp`
        } else {
            return
        }
        await fsp.writeFile(dest, buf, { mode: 0o664 })
    } catch {}
}
