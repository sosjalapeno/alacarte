import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  applyQobuzWriteNaming,
  sanitizeSegment,
} from './libraryMatchKey.mjs'

export { sanitizeSegment }

export function applyNamingConvention(name, convention) {
  if (convention !== 'qobuz') return name
  return applyQobuzWriteNaming(name)
}

export async function resolveArtistDir(musicRoot, desiredArtist) {
  const desired = sanitizeSegment(desiredArtist)
  try {
    const entries = await fsp.readdir(musicRoot, { withFileTypes: true })
    const lower = desired.toLowerCase()
    const existing = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase() === lower,
    )
    if (existing) return existing.name
  } catch {}
  return desired
}

export async function computeFinalDir(musicRoot, artist, album, _year) {
  const artistDir = await resolveArtistDir(musicRoot, artist)
  const albumSeg = sanitizeSegment(album)
  return path.join(musicRoot, artistDir, albumSeg)
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true, mode: 0o775 })
}

/**
 * Fail fast when a download target cannot be written: walks up from finalDir
 * to the nearest existing ancestor and checks W_OK there. Catches legacy
 * root-owned artist folders (e.g. after a rootful -> rootless container
 * migration) before the download runs instead of after.
 */
export async function assertWritableTarget(finalDir) {
  let dir = path.resolve(finalDir)
  for (;;) {
    if (fs.existsSync(dir)) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    await fsp.access(dir, fs.constants.W_OK)
  } catch (err) {
    throw new Error(
      `music library folder is not writable: ${dir} (${err.code || err.message}). ` +
        'Fix the folder ownership so the container user can write into it (e.g. chown -R the folder inside the music library).',
    )
  }
}

export async function mergeMove(src, dest) {
  await ensureDir(dest)
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (e.isDirectory()) {
      await mergeMove(from, to)
    } else {
      try {
        await fsp.rename(from, to)
      } catch (err) {
        if (err.code === 'EXDEV') {
          await fsp.copyFile(from, to)
          await fsp.unlink(from)
        } else if (err.code === 'EEXIST') {
          await fsp.rm(to)
          await fsp.rename(from, to)
        } else {
          throw err
        }
      }
    }
  }
  try {
    await fsp.rmdir(src)
  } catch {}
}

export function pathExists(p) {
  return fs.existsSync(p)
}
