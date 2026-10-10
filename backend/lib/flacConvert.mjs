import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ttmlToLrc } from './ttmlLrc.mjs'

// A single track converts in seconds; a hung ffmpeg would otherwise hold
// the one-at-a-time queue forever.
const FFMPEG_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.AMDL_FFMPEG_TIMEOUT_MS) || 15 * 60_000,
)

function runFfmpeg(args, { signal, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else if (timedOut) reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`))
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`))
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export async function convertToFlac(inputPath, { deleteOriginal = true, signal, timeoutMs } = {}) {
  const dir = path.dirname(inputPath)
  const base = path.basename(inputPath, path.extname(inputPath))
  const outPath = path.join(dir, `${base}.flac`)
  const lrcPath = path.join(dir, `${base}.lrc`)
  const ttmlPath = path.join(dir, `${base}.ttml`)
  let lrcArgs = []
  try {
    let lrc = await fsp.readFile(lrcPath, 'utf8').catch(() => '')
    if (!lrc) {
      const ttml = await fsp.readFile(ttmlPath, 'utf8').catch(() => '')
      if (ttml) {
        lrc = ttmlToLrc(ttml)
      }
    }
    if (lrc && lrc.trim()) {
      lrcArgs = [
        '-metadata',
        `lyrics=${lrc}`,
        '-metadata',
        `LYRICS=${lrc}`,
        '-metadata',
        `UNSYNCEDLYRICS=${lrc}`,
      ]
    }
  } catch {}
  // ffmpeg writes to a hidden temp file that only becomes the .flac once it
  // finished, so a failed or killed conversion leaves no partial track to be
  // moved into the library next to the original.
  const tmpPath = path.join(dir, `.${base}.converting.flac`)
  try {
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-map',
      '0',
      '-map_metadata',
      '0',
      ...lrcArgs,
      '-c:a',
      'flac',
      '-compression_level',
      '8',
      '-c:v',
      'copy',
      '-disposition:v:0',
      'attached_pic',
      '-metadata',
      'encoder=FLAC',
      tmpPath,
    ], { signal, timeoutMs })
    await fsp.rename(tmpPath, outPath)
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }
  if (deleteOriginal) {
    try {
      await fsp.unlink(inputPath)
    } catch {}
  }
  return outPath
}

async function collectInputFiles(dir) {
  const out = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await collectInputFiles(p)))
    } else {
      const ext = path.extname(e.name).toLowerCase()
      if (ext === '.m4a' || ext === '.alac') out.push(p)
    }
  }
  return out
}

export async function convertDirToFlac(dir, opts = {}) {
  const { onProgress, ...convertOpts } = opts
  const files = await collectInputFiles(dir)
  const total = files.length
  let converted = 0
  let failed = 0
  for (let i = 0; i < files.length; i++) {
    const p = files[i]
    // A cancelled job stops converting instead of counting the rest as failed.
    convertOpts.signal?.throwIfAborted()
    try {
      await convertToFlac(p, convertOpts)
      converted++
    } catch (err) {
      convertOpts.signal?.throwIfAborted()
      console.error(`FLAC convert failed for ${p}: ${err.message}`)
      failed++
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({ file: p, index: i + 1, total })
      } catch {}
    }
  }
  return { converted, failed, total }
}

export async function extractFolderArt(dir, { size = 1000 } = {}) {
  const target = path.join(dir, 'folder.jpg')
  if (fs.existsSync(target)) return target
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const audio = entries.find(
    (e) => e.isFile() && /\.(flac|m4a|mp3)$/i.test(e.name),
  )
  if (!audio) return null
  const input = path.join(dir, audio.name)
  try {
    await runFfmpeg([
      '-y',
      '-i',
      input,
      '-an',
      '-vcodec',
      'mjpeg',
      '-vf',
      `scale='min(${size},iw)':-1`,
      target,
    ])
    return fs.existsSync(target) ? target : null
  } catch (err) {
    console.error(`folder.jpg extraction failed: ${err.message}`)
    return null
  }
}

