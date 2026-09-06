import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import { healthRouter } from './routes/health.mjs'
import { settingsRouter } from './routes/settings.mjs'
import { searchRouter } from './routes/search.mjs'
import { albumRouter } from './routes/album.mjs'
import { artistRouter } from './routes/artist.mjs'
import { downloadRouter } from './routes/download.mjs'
import { queueRouter } from './routes/queue.mjs'
import { eventsRouter } from './routes/events.mjs'
import { libraryRouter } from './routes/library.mjs'
import { authRouter } from './routes/auth.mjs'
import { playlistRouter } from './routes/playlist.mjs'
import { followingRouter } from './routes/following.mjs'
import { cloudLibraryRouter } from './routes/cloudLibrary.mjs'
import { playlistFollowingRouter } from './routes/playlistFollowing.mjs'
import { ensureConfigDir } from './lib/settingsStore.mjs'
import { loadSecretsAtBoot } from './lib/secretKey.mjs'
import { originGuard } from './lib/originGuard.mjs'
import { isPasswordSet } from './lib/authStore.mjs'
import { generateSetupToken } from './lib/setupToken.mjs'
import { isAuthDisabled, requireAuth } from './lib/requireAuth.mjs'
import { startAutoDownloadScheduler } from './lib/autoDownloads.mjs'
import { startPlaylistSyncScheduler } from './lib/playlistSync.mjs'
import { initQueue } from './lib/queue.mjs'

const PORT = Number(process.env.PORT || 7373)
const CONFIG_DIR = process.env.AMDL_CONFIG_DIR || '/config'
const MUSIC_PATH = process.env.AMDL_MUSIC_PATH || '/music'

await ensureConfigDir(CONFIG_DIR)
loadSecretsAtBoot(CONFIG_DIR)
await initQueue().catch((err) => {
  console.error('queue init failed:', err.message)
})

const setupToken =
  !isAuthDisabled() && !(await isPasswordSet())
    ? generateSetupToken()
    : null

if (setupToken) {
  console.log(`[auth] one-time setup token: ${setupToken}  (use it in the X-Setup-Token header)`)
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback')
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'https://*.mzstatic.com', 'data:'],
        connectSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        scriptSrcAttr: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: {
      maxAge: 15552000,
      includeSubDomains: true,
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  }),
)
app.use(express.json({ limit: '64kb' }))
app.use(cookieParser())
app.use(originGuard())

if (isAuthDisabled()) {
  console.warn(
    '[auth] AUTH_DISABLED=true — built-in password gate is OFF. ' +
      'Only safe when fronted by your own auth (reverse proxy, VPN, mesh network).',
  )
}

app.use((req, _res, next) => {
  const stamp = new Date().toISOString()
  if (!req.path.startsWith('/api/events')) {
    console.log(`[${stamp}] ${req.method} ${req.path}`)
  }
  next()
})

// Auth router is mounted before the guard so /state, /setup, and /login
// remain reachable for bootstrap. The guard then protects everything else.
app.use('/api/auth', authRouter)
app.use(requireAuth())

app.use('/api/health', healthRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/search', searchRouter)
app.use('/api/album', albumRouter)
app.use('/api/artist', artistRouter)
app.use('/api/download', downloadRouter)
app.use('/api/queue', queueRouter)
app.use('/api/events', eventsRouter)
app.use('/api/library', libraryRouter)
app.use('/api/playlist', playlistRouter)
app.use('/api/following', followingRouter)
app.use('/api/playlist-following', playlistFollowingRouter)
app.use('/api/cloud-library', cloudLibraryRouter)

startAutoDownloadScheduler()
startPlaylistSyncScheduler()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, 'public')
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: false, maxAge: '1h' }))
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('text/plain')
      .send('alacarte backend running (frontend not bundled)')
  })
}

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: String(err?.message || err) })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `alacarte listening on :${PORT} (music=${MUSIC_PATH} config=${CONFIG_DIR})`,
  )
})
