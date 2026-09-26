import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

const CONFIG_DIR = process.env.AMDL_CONFIG_DIR || '/config'
const AMDP_CONFIG = path.join(CONFIG_DIR, 'amdp-config.yaml')

const WRAPPER_HOST = process.env.AMDL_WRAPPER_HOST || '127.0.0.1'
const WRAPPER_DECRYPT_PORT = process.env.AMDL_WRAPPER_DECRYPT_PORT || '10020'
const WRAPPER_M3U8_PORT = process.env.AMDL_WRAPPER_M3U8_PORT || '20020'

function emitYaml(obj) {
  const lines = []
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      lines.push(`${k}: ${JSON.stringify(v)}`)
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${k}: ${v}`)
    } else if (v == null) {
      lines.push(`${k}: ""`)
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`)
    }
  }
  return lines.join('\n') + '\n'
}

export async function writeAmdpConfig({
  settings,
  mediaUserToken,
  stagingRoot,
}) {
  const lyricsEnabled = Boolean(settings.downloadLyrics && mediaUserToken)
  const cfg = {
    'media-user-token': mediaUserToken || '',
    'authorization-token': '',
    language: settings.language || '',
    'lrc-type': settings.lyricsType || 'lyrics',
    'lrc-format': settings.lyricsFormat || 'lrc',
    'embed-lrc': lyricsEnabled,
    'save-lrc-file': lyricsEnabled,
    'save-artist-cover': false,
    'save-animated-artwork': false,
    'emby-animated-artwork': false,
    'embed-cover': true,
    'cover-size': settings.coverSize || '1400x1400',
    'cover-format': 'jpg',
    'alac-save-folder': stagingRoot,
    'atmos-save-folder': stagingRoot,
    'aac-save-folder': stagingRoot,
    'mv-save-folder': stagingRoot,
    'max-memory-limit': 256,
    // Without this amdp waits for Enter after a failed pass; with stdin closed
    // that returns immediately and it re-runs the whole pass forever (#19).
    'exit-on-error': true,
    'decrypt-m3u8-port': `${WRAPPER_HOST}:${WRAPPER_DECRYPT_PORT}`,
    'get-m3u8-port': `${WRAPPER_HOST}:${WRAPPER_M3U8_PORT}`,
    'get-m3u8-from-device': true,
    'get-m3u8-mode': 'hires',
    'aac-type': 'aac-lc',
    'alac-max': 192000,
    'atmos-max': 2768,
    'limit-max': 200,
    'album-folder-format': '{AlbumName}',
    'playlist-folder-format': '{PlaylistName}',
    'song-file-format': '{SongNumer}. {SongName}',
    'artist-folder-format': '{ArtistName}',
    'explicit-choice': '[E]',
    'clean-choice': '[C]',
    'apple-master-choice': '[M]',
    // Tag playlist tracks with their real album, album artist and track
    // number rather than the playlist's, so they import into album folders.
    'use-songinfo-for-playlist': true,
    'dl-albumcover-for-playlist': false,
    'mv-audio-type': 'atmos',
    'mv-max': 2160,
    storefront: settings.storefront || 'us',
    'convert-after-download': false,
    'convert-format': 'flac',
    'convert-keep-original': false,
    'convert-skip-if-source-matches': true,
    'ffmpeg-path': 'ffmpeg',
    'convert-extra-args': '',
    'convert-with-metadata': true,
    'convert-warn-lossy-to-lossless': true,
    'convert-skip-lossy-to-lossless': true,
    'convert-check-bad-alac': false,
    'convert-delete-bad-alac': false,
  }
  const configPath = path.join(stagingRoot, 'config.yaml')
  await fsp.writeFile(configPath, emitYaml(cfg), { mode: 0o600 })
  return configPath
}

export function spawnAmdp({ args, cwd, onLine, signal }) {
  const child = spawn('apple-music-dl', args, {
    cwd: cwd || path.dirname(AMDP_CONFIG),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    signal,
  })
  let stdoutBuf = ''
  let stderrBuf = ''
  let stdoutPending = ''
  let stderrPending = ''

  const emitLine = (raw, which) => {
    const line = stripAnsi(raw).trim()
    if (!line) return
    try {
      onLine?.({ line, which })
    } catch (err) {
      console.error('amdp onLine handler threw', err)
    }
  }

  const handle = (chunk, which) => {
    const s = chunk.toString()
    if (which === 'stdout') stdoutBuf += s
    else stderrBuf += s

    // Treat both \n and \r as line terminators so schollz/progressbar updates
    // (which use bare \r) become individual lines for the parser.
    let pending = which === 'stdout' ? stdoutPending + s : stderrPending + s
    const parts = pending.split(/\r\n|\n|\r/)
    const tail = parts.pop() ?? ''
    for (const part of parts) emitLine(part, which)
    if (which === 'stdout') stdoutPending = tail
    else stderrPending = tail
  }

  child.stdout.on('data', (c) => handle(c, 'stdout'))
  child.stderr.on('data', (c) => handle(c, 'stderr'))
  child.stdout.on('end', () => {
    if (stdoutPending) {
      emitLine(stdoutPending, 'stdout')
      stdoutPending = ''
    }
  })
  child.stderr.on('end', () => {
    if (stderrPending) {
      emitLine(stderrPending, 'stderr')
      stderrPending = ''
    }
  })

  const waitExit = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, sig) =>
      resolve({ code, signal: sig, stdout: stdoutBuf, stderr: stderrBuf }),
    )
  })
  return { child, waitExit }
}

export function stripAnsi(s) {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><]/g,
    '',
  )
}

export const AMDP_CONFIG_PATH = AMDP_CONFIG
