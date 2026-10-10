import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Format milliseconds or timestamp string (hh:mm:ss.xxx, mm:ss.xxx, or seconds)
 * into standard LRC timestamp string [mm:ss.xx].
 */
export function formatLrcTimestamp(rawTime) {
  if (!rawTime) return '[00:00.00]'
  const t = String(rawTime).trim().replace(/s$/, '')
  const parts = t.split(':')
  let totalSec = 0
  if (parts.length === 3) {
    totalSec = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2])
  } else if (parts.length === 2) {
    totalSec = parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
  } else {
    totalSec = parseFloat(t) || 0
  }
  const totalCs = Math.max(0, Math.round(totalSec * 100))
  const m = Math.floor(totalCs / 6000)
  const s = Math.floor((totalCs % 6000) / 100)
  const cs = totalCs % 100
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/**
 * Convert TTML XML string to LRC format text.
 */
export function ttmlToLrc(xml) {
  if (!xml || typeof xml !== 'string') return ''
  // Match <p ... begin="time" ...>inner</p>
  const pRegex = /<p\b[^>]*\bbegin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi
  const lines = []
  let match
  while ((match = pRegex.exec(xml)) !== null) {
    const time = formatLrcTimestamp(match[1])
    const rawText = match[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
    const cleanText = decodeXmlEntities(rawText).trim()
    if (cleanText) {
      lines.push(`${time}${cleanText}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`))
    })
    proc.on('error', reject)
  })
}

async function embedLrcInM4a(m4aPath, lrcContent) {
  const tmpPath = `${m4aPath}.tmp.m4a`
  await runFfmpeg([
    '-y',
    '-i',
    m4aPath,
    '-c',
    'copy',
    '-metadata',
    `lyrics=${lrcContent}`,
    tmpPath,
  ])
  await fsp.rename(tmpPath, m4aPath)
}

/**
 * Ensures that any directory containing .ttml sidecars also contains the corresponding
 * .lrc sidecars (converted from TTML) and that any companion .m4a audio file has its
 * embedded lyrics tag set to standard LRC text rather than raw TTML XML.
 */
export async function syncDualLyricsInDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await syncDualLyricsInDir(fullPath)
    } else if (/\.ttml$/i.test(entry.name)) {
      const base = path.basename(entry.name, path.extname(entry.name))
      const lrcPath = path.join(dir, `${base}.lrc`)
      const lrcExists = await fsp.stat(lrcPath).then((s) => s.isFile()).catch(() => false)
      let lrcContent = ''
      if (!lrcExists) {
        const ttmlXml = await fsp.readFile(fullPath, 'utf8').catch(() => '')
        lrcContent = ttmlToLrc(ttmlXml)
        if (lrcContent) {
          await fsp.writeFile(lrcPath, lrcContent, 'utf8')
        }
      } else {
        lrcContent = await fsp.readFile(lrcPath, 'utf8').catch(() => '')
      }

      if (lrcContent) {
        const m4aPath = path.join(dir, `${base}.m4a`)
        const m4aExists = await fsp.stat(m4aPath).then((s) => s.isFile()).catch(() => false)
        if (m4aExists) {
          try {
            await embedLrcInM4a(m4aPath, lrcContent)
          } catch (err) {
            console.warn(`[lyrics] Failed to embed LRC in ${m4aPath}:`, err.message)
          }
        }
      }
    }
  }
}
