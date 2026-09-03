# wrapper

Prebuilt FairPlay decryption daemon from
[WorldObservationLog/wrapper](https://github.com/WorldObservationLog/wrapper).

This directory contains:

- `wrapper` — the prebuilt `x86_64` Linux binary
- `rootfs/` — bundled Android rootfs (libs + system binaries) required by the decryptor
- `wrapper_login_fix.c` — Android preload that preserves colon-containing passwords, uses the container's DNS, and logs StoreServices failures
- `preload_host.c` — host-side preload placeholder used before the wrapper enters the Android rootfs
- `preload_libdl_stub.c` — link-only shim for Android's linker-provided `libdl.so`
- `wrapper-entrypoint.sh` — copies the container resolver config into the Android rootfs
- `Dockerfile` — packages the above into `debian:stable-slim` and exposes the three daemon ports

The contents come from the project's GitHub Releases. If you need a different architecture (e.g. arm64), download the matching release zip and unzip over this directory.

## Ports

| Port  | Purpose                   |
|-------|---------------------------|
| 10020 | Decrypt service           |
| 20020 | M3U8 service              |
| 30020 | Account (storefront) info |

## Login

The web UI handles first-time login automatically. Go to Settings → Apple Account, enter your credentials, and the wrapper will authenticate. Credentials are cached inside `rootfs/data` (volume-mounted to `./data/wrapper` by the parent compose file) so you only need to sign in once.
