# alacarte

Self-hosted Apple Music downloader with a polished web UI.

<div align="center">
  <img src="./assets/hero-album.png" alt="alacarte Album Detail View" width="100%" />
</div>

## What it is

alacarte is a browser-based tool that downloads lossless audio from Apple Music, converts it to FLAC, and organizes it into a clean library structure you can point any media server at.

- **Search & Discover:** Full access to the Apple Music catalog (albums, artists, songs, playlists).
- **Lossless & Hi-Res:** Download ALAC streams and auto-convert to FLAC with embedded artwork and metadata.
- **Lyrics Support:** Fetch embedded lyrics and sidecar `.lrc` files (requires `media-user-token`).
- **Smart Queuing:** Queue individual tracks, whole albums, playlists, or bulk-select entire artist discographies (filtered by LPs/EPs/Singles).
- **Library Awareness:** Duplicate prevention visually flags what is already in your library so you don't re-download.
- **Explicit / clean filtering:** Apple lists explicit and clean masters as separate albums. Pick your preference in Settings (or show both) to keep search results tidy.
- **Follow Artists:** Follow an artist to auto-download new releases as they drop. Choose to grab their current discography on follow or only watch for future releases. alacarte checks on a self-tuning schedule (configurable in Settings) that scales with your roster size to stay well under Apple's daily API limits.

Output lands in `/music/<Artist>/<Album>/01. Track.flac` (or `/music/<Artist>/Singles/` for individual songs). Playlist downloads are merged into the same artist/album library structure and also emit `/music/Playlists/<Playlist>.m3u8` with relative paths so Jellyfin/Navidrome can import playlist order.

---

## Beautiful and functional. Not just on the desktop.

<table style="border: none;">
  <tr>
    <td width="50%" align="center">
      <img src="./assets/mobile-showcase.png" alt="Mobile UI Showcase" />
      <br />
      <b>Fully responsive design</b><br />
      Search, queue, and manage your library effortlessly from your phone.
    </td>
    <td width="50%" align="center">
      <img src="./assets/status-dashboard.png" alt="Status Dashboard" />
      <br />
      <b>Complete system visibility</b><br />
      Watch your server work in real-time with an SSE-backed console, live job tracking, and granular health metrics.
    </td>
  </tr>
</table>

---

## Disclaimer
**This tool is for personal archival use only.** Downloading music you do not have a valid subscription/license for violates Apple's Terms of Service. You are responsible for ensuring your use complies with applicable terms and laws in your jurisdiction.

---

## Requirements

- **`linux/amd64` (x86_64)** — the FairPlay wrapper binary and the upstream downloader image are amd64-only. On Apple Silicon Macs, Docker Desktop transparently emulates amd64 via Rosetta. On native arm64 Linux (Raspberry Pi, ARM cloud VPS), enable `qemu-user-static` / `binfmt_misc` to run amd64 containers, or use an x86_64 host.
- Docker + Docker Compose
- An **Apple Music paid subscription**

## Quick start

1. `git clone` this repo and `cd` into it
2. Copy `.env.example` to `.env` and set `MUSIC_PATH` to your music library folder
3. Run `docker compose up -d --build`
4. Open `http://<your-host>:7373`
5. Grab the one-time setup token from logs (`docker compose logs alacarte-web`) and use it on the welcome screen with your new username/password
6. Go to Settings → enter your Apple ID email, password, and preferred storefront

## Upgrade notes

Upgrading an existing deployment:

1. Pull latest changes and rebuild: `docker compose up -d --build`
2. If your current install has no auth configured yet, open the UI and complete first-time setup with the one-time setup token from logs.
3. If you already have auth configured, sign in normally.

No manual data migration is required for `data/web/settings.json` or existing encrypted Apple credentials.

## Security

alacarte ships with a built-in single-password gate. The first time you visit the UI, you'll be prompted to set a username/password and the one-time setup token from server logs — every API endpoint and page is then locked behind it.

A few things to keep in mind:

- **Don't expose this directly to the public internet.** Several cloud providers ship hosts with permissive default firewalls. Verify your firewall, and put a reverse proxy / VPN / mesh network in front of the UI before opening it up to anything beyond your LAN.
- **No Docker socket is mounted.** First-time Apple login goes through a small supervisor inside the wrapper container (port 40020, internal network only), so the web container has no control over the host's container engine.
- **Tighten the bind to localhost only:** set `WEB_BIND=127.0.0.1` in `.env` if you front the app with a reverse proxy on the same machine and don't want the UI reachable on your LAN.
- **Already running your own auth?** Set `AUTH_DISABLED=true` in `.env` to skip the built-in password gate (e.g. when fronting with Authelia, Cloudflare Access, Tailscale, etc).
- **Rate limiting and lockouts are built in** for setup/login/password-change routes (429 + Retry-After + temporary lockouts).
- **Sessions support revoke-all** from Settings → Account ("Sign out on all devices").
- **Password hashing uses memory-hard scrypt** (`N=131072, r=8, p=1`).
- **Trust proxy and secure cookies:** set `TRUST_PROXY` correctly when running behind a reverse proxy so HTTPS detection and cookie security are accurate.
- **Existing users are preserved:** current encrypted Apple credentials in `data/web/settings.json` continue to decrypt after upgrading.
- **Change or reset:** the password lives at `data/web/auth.json`. Change it from Settings → Account, or reset by deleting that file and restarting the container — the next visit will prompt for a new one.

## First login flow

alacarte needs to authenticate with Apple to obtain decryption tokens. This happens once, then the session persists across container restarts.

1. Enter your credentials in Settings and click Save.
2. If Apple requires 2FA, you'll see a prompt asking for the 6-digit code. If a trusted device only shows Allow / Not Me, generate a code from Settings → Apple ID → Sign-In & Security → Get Verification Code.
3. Enter the code within ~2 minutes.
4. When you see "Ready", you're good to search and download.

### Sign-in troubleshooting

If Apple sign-in fails, check these first:

1. Confirm the Apple ID has an active Apple Music subscription on `music.apple.com`.
2. Confirm the Apple ID has signed into Apple Music at least once on a real Apple device or on the web app.
3. Confirm DNS, firewall, VPN, and proxy rules allow the host to reach Apple's services.
4. Confirm the storefront in Settings matches the Apple ID's region.
5. Confirm you're running the latest image/build (newer builds include login parser fixes and richer wrapper diagnostics).

Wrapper response type 4 is a generic StoreServices failure, not a credential diagnosis. Use the server message and StoreServices error in the failure log to narrow it down before retrying; repeated attempts can trigger an Apple account lockout. If the failure log shows a `StoreServices error` with a very large negative number, that came from an older wrapper build — rebuild with `docker compose build --no-cache wrapper` to get the real error code.

## How downloads behave

- Jobs run **one at a time** — queuing many items won't speed things up, it just lines them up.
- Download speed is throttled by Apple and varies by time of day.
- After a download completes, each track is converted from ALAC to FLAC and moved into your library (although you can disable this in the settings).
- The queue survives page refreshes but not container restarts.
- If a job fails (network hiccup, decryption glitch), you can re-queue it manually.

## Language support

ALACarte separates two independent language preferences:

1. **Location** — the very first control in **Settings → Catalog** — translates the app's own UI (every page: Home, Search, Downloads/Queue, Apple Music/cloud library, Following, Status, Settings, and shared components like modals and quality pickers). Choose an explicit language, or "Follow system default" to use your browser's language, falling back to English if it isn't one of the ones below or can't be detected. Built with [react-i18next](https://react.i18next.com/) + [i18next-browser-languagedetector](https://github.com/i18next/i18next-browser-languageDetector).
2. **Accepted languages for music metadata** and **downloaded file naming language**, in **Settings → Library output** — an ordered preference list (drag to reorder, click a suggestion to add, × to remove) plus a naming mode. These control what language song/album/artist *names* are downloaded in — independent of the UI language above.

Currently translated/supported: **English, Chinese (Simplified), Chinese (Traditional), Japanese, Korean, Spanish, French** — the full UI is now translated, not just navigation/settings.

**Simplified vs. Traditional Chinese codes:** Apple's own catalog API already uses BCP-47 script subtags for Chinese (see `STOREFRONT_HOME_LANGUAGE` in `backend/lib/metadataLanguage.mjs`, which has always used `zh-Hant-TW`/`zh-Hant-HK`). Under that scheme the original `zh` code here is really "zh-Hans" (Simplified). Rather than renaming it — which would silently break any existing install with `acceptedLanguages`/`uiLanguage` already set to `zh`, or the existing `zh.json` locale file — `zh` is kept as-is for Simplified Chinese, and `zh-hant` (lowercased, to match this app's other codes and its lowercase-normalizing settings validation) is added alongside it for Traditional Chinese. `detectScript()`'s cheap script-range check still can't tell Simplified from Traditional apart by character shape alone, so a detected Han-script original name is treated as matching either `zh` or `zh-hant` in your accepted-languages list.

**A note for anyone touching `frontend/src/i18n/index.ts`:** the `zh-hant` code above is our own public-facing identifier (settings storage, `SUPPORTED_LANGUAGES`, the `<select>` value), but the i18next **resources object** registers that locale's translation bundle under the key `'zh-Hant'` (capital H), not `'zh-hant'`. This isn't a typo — i18next's internal `formatLanguageCode`/`toResolveHierarchy` always title-cases a small set of known BCP-47 script subtags (`hant`, `hans`, `latn`, `cyrl`, `cans`, `mong`, `arab`) when building its language-resolution order, so `changeLanguage('zh-hant')` looks up resources in the order `['zh-Hant', 'zh', 'en']` regardless of the casing passed in. Registering the bundle under the lowercase `'zh-hant'` key means that first lookup silently misses and falls through to the `'zh'` bundle — `i18n.language` still reads back as `'zh-hant'` (so this is easy to miss in testing), but every translated string quietly renders Simplified Chinese instead of Traditional. Confirmed by reproducing directly against the installed `i18next` package. If you ever add another language whose code contains one of those script subtags, register its resource bundle under i18next's title-cased form, not your own app-level code's casing.

### Naming language modes

Given a song whose original (Chinese) name is `泡沫` and whose Apple-translated name in your configured catalog `language` is `Bubbles`:

| Mode | Behavior | Result |
|------|----------|--------|
| **Display** (default) | Use your display language, falling back to the original if Apple has no translation. | `Bubbles` |
| **Original if accepted** | Use the original-language name if that language is in your accepted list; otherwise fall back to display. | `泡沫` if `zh` is in your accepted list, else `Bubbles` |
| **Dual** | Use the display name, and append the original in parentheses when they differ. | `Bubbles (泡沫)` |

This applies to song title, album title, and artist/singer name, everywhere those drive folder/file naming — see `backend/lib/queue.mjs`'s `resolveAlbumNaming`. The default mode never triggers this pipeline, so a fresh install behaves exactly as before this feature existed.

**How "original language" is determined:** since Apple's catalog API only localizes on request, ALACarte fetches one extra copy of the album/playlist in the storefront's own home-locale language (see `STOREFRONT_HOME_LANGUAGE` in `backend/lib/metadataLanguage.mjs`) and compares it against your display-language copy. This is a heuristic, not a metadata field Apple actually provides — a storefront missing from that map, or content whose original language doesn't match its storefront, will just fall back to display naming. Which script a name is in (for deciding whether it's "accepted") is detected by a small, dependency-free character-range check (`detectScript`) that reliably tells Chinese/Japanese/Korean apart, but can't distinguish Latin-script languages (English vs. Spanish vs. French) from one another — a real language-detection library would be needed for that.

**Rate limits:** the extra home-locale lookup only happens when a non-default naming mode is selected, is paced (a minimum gap between requests) and cached forever per album/playlist (an original-language name never changes) — see `backend/lib/originalMetadataCache.mjs`. It does not run at all for playlists' individual tracks or for the "fill missing tracks" flow, to avoid multiplying Apple API calls during bulk operations; those keep display-only naming for now.

### Tags

When a naming mode other than "Display" is active, FLAC downloads also get the original-language name(s) stamped as extra Vorbis comment fields (alongside the existing `ISRC`/`BARCODE` tags — see `backend/lib/audioTags.mjs`'s `writeAudioIdentityTags`):

- `ORIGINAL_TITLE` — the track's original-language name (only set when it differs from what's embedded as the main title)
- `ORIGINAL_ALBUM` — the album's original-language name
- `ORIGINAL_ARTIST` — the artist's original-language name

### Follow-up work

- A handful more UI languages beyond the current six.
- A real per-character Hanzi-variant table (or a language-detection library), so "original if accepted" can distinguish Simplified from Traditional Chinese by script alone, instead of treating a detected Han-script name as matching either accepted-language code.
- A real language-detection library, so "original if accepted" can distinguish Latin-script languages from one another instead of only CJK/Hangul vs. everything else.
- Per-track original-language naming for playlists and for "fill missing tracks" album backfills (currently display-only, to keep Apple API call volume flat for bulk flows).
- A storefront/home-locale map covering more than the storefronts already offered in the Storefront picker.

## Notes and limits

**IP rate-limiting and proxies** Apple appears to rate-limit by IP if you query huge amounts of data at once. In my experience, this isn't a permanent ban, I got soft-blocked for about a day after downloading ~1500 songs. If you plan to archive massive collections, consider:
- Spreading large jobs across multiple days
- Running behind a VPN or proxy
- Using a container with separate networking

**Storage** - Lossless albums are ~300–600 MB each.
- By default, temporary staging is written to `/tmp/alacarte-staging` while jobs run.
- You can switch staging location in Settings → Library output.
- Stale job staging folders older than 24 hours are pruned on app boot and every 6 hours afterwards.
- If your host's `/tmp` is tmpfs (RAM-backed), large downloads can exhaust memory. Either bind-mount a disk path to `/tmp/alacarte-staging` in your compose override, or toggle "Store temp staging inside music library" on.
- If you intentionally point staging inside your music library, configure your scanner to ignore hidden directories.

**Sharing a network with Jellyfin/Plex/etc.** By default alacarte creates its own `alacarte-net` Docker network. If you'd rather attach to an existing network (e.g. the one your media server already uses), set `DOCKER_NETWORK=<name>` and `DOCKER_NETWORK_EXTERNAL=true` in `.env`.

**Local compose tweaks** If you need to change things the `.env` variables don't cover (extra volumes, additional environment, etc.), drop a `docker-compose.override.yml` next to the main compose file. Docker Compose auto-merges it and it's gitignored, so you can run `docker compose up` normally without polluting the committed config.

**Navidrome Integration** alacarte includes built-in support for triggering Subsonic API scans in Navidrome. Once you configure your Navidrome credentials in the Settings panel, alacarte will instantly instruct your server to quick-scan the library the exact moment a download completes. No more waiting for hourly cron jobs!

**Apple Music in Subsonic clients (octo-fiesta)** [filipton's octo-fiesta](https://github.com/filipton/octo-fiesta) is a Subsonic proxy for Navidrome that adds streaming catalogues to your music apps' search and downloads what you play. It can use alacarte for Apple Music: turn on **Settings → octo-fiesta Integration**, then give octo-fiesta the `AppleMusic__AlacarteUrl` and `AppleMusic__ApiToken` shown there. Both must mount the same music folder. The token only opens `/api/integration/v1`, and the integration stays off until you turn it on.

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|--------------|-----|
| "Sign in required" health warning | Wrapper isn't authenticated | Go to Settings and complete the login flow |
| "Wrapper supervisor not reachable" | Wrapper container down or still starting | Verify the wrapper container is healthy via `docker compose ps` and `docker compose logs wrapper` |
| Downloads stuck at 0% | Apple token expired or wrapper down | Wait a moment; it will auto-retry. If still stuck, restart the stack |
| Tracks show "failed" | Temporary Apple/server hiccup | Re-queue the album; transient failures usually clear |
| FLAC files are truncated | MP4Box runtime issue | Rebuild the container image and redeploy |

## Architecture

alacarte runs on a shared Docker network with three primary components:
- **web:** This repository. It wraps the downloader CLI as a child process and serves the React SPA on port `7373`.
- **amdp:** The underlying downloader binary, included at build time.
- **wrapper:** A FairPlay decryption daemon that handles the DRM removal, included at build time.

## Credits

Built upon:
- [zhaarey/apple-music-downloader](https://github.com/zhaarey/apple-music-downloader)
- [WorldObservationLog/wrapper](https://github.com/WorldObservationLog/wrapper)

The UI design was heavily inspired by the beautiful [Abyss theme](https://github.com/AumGupta/abyss-jellyfin), which was then customized and expanded from the ground up for this project.

## License

AGPL-3.0 — see LICENSE

This tool interacts with Apple Music services. You are responsible for ensuring your use complies with Apple's Terms of Service and applicable laws in your jurisdiction.
