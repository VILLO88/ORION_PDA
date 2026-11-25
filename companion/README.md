# Orion Companion

Desktop companion app for the **[Orion PDA V3](https://orionpda.org/)**.
Cross-platform: Windows · macOS (Apple Silicon) · Linux (x86_64).

> Ready-made builds for macOS, Windows and Linux are in the
> [Releases of the ORION_PDA repository](https://github.com/VILLO88/ORION_PDA/releases?q=companion&expanded=true).
> See [CHANGELOG.md](CHANGELOG.md) for recent changes,
> [INSTALL.md](INSTALL.md) for end-user installation,
> [APP_STORE.md](APP_STORE.md) for publishing Lua apps in the App Store,
> [BUILD_WINDOWS.md](BUILD_WINDOWS.md) / [BUILD_LINUX.md](BUILD_LINUX.md)
> for cross-platform build notes.

## Features

| Tab           | What it does |
| ------------- | ------------ |
| **Home**      | Connected device + storage overview, recent activity. |
| **Device**    | The connected ORION volumes. |
| **Notes**     | The `/NOTE` tree (`.txt` and `.md`, with a Rendered / Source preview for Markdown): copy, move, rename, back up; protected notes (`PRIVATE`); two-way sync with an Obsidian vault or Notion; also over Bluetooth. |
| **Ebooks**    | Convert EPUB / PDF / Markdown / TXT → `.pdar`, pre-paginated for the 536×336 display; to the card, a folder or over Bluetooth. |
| **Wikipedia** | Convert a Kiwix `.zim` for ORION's `wiki` app, to read offline (needs ORION firmware 0.3.0). |
| **Music**     | Convert audio via `ffmpeg` (loudnorm -14 LUFS, 48 kHz, libmp3lame VBR q=2), with cover search. |
| **Video**     | Convert `.mp4/.mkv/.mov/.avi` → `.av` (1-bit dither + PCM audio). |
| **Calendar**  | Send your computer's calendar (and `.ics` files) to ORION. |
| **Files**     | Drag/drop + clipboard manager for any file on the SD card. |
| **App Store** | Lua apps for ORION: browse, **try them in the built-in emulator**, install over USB or Bluetooth, rate and comment; publish your own (sign in with GitHub, every version is reviewed by a moderator). See [APP_STORE.md](APP_STORE.md). |
| **Firmware**  | USB DFU update via `dfu-util`, with SD-driven auto-update trigger. |

## Stack

- **Electron 30** (main + preload + renderer, hardened with `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`)
- **TypeScript 5** · **React 18** · **Tailwind 3** · **Vite** + `electron-vite` (HMR in dev)
- **electron-builder** for packaging (`.dmg`, `.zip`, NSIS `.exe`, Windows `.zip`, `.AppImage`, `.deb`)
- Bundled native tools per platform: `ffmpeg`, `ffprobe`, `dfu-util` (+ `libusb` on mac)

## Quick start (dev)

Requires **Node.js 20+** and a working C/C++ toolchain only if you bump
heavy native deps (default install on macOS/Linux/Windows works as-is).

```bash
git clone https://github.com/VILLO88/ORION_PDA.git
cd ORION_PDA/companion
npm install
npm run dev          # Electron + Vite HMR
```

Other scripts:

```bash
npm run typecheck    # main (Node) + renderer (Web) TS check
npm run build        # production bundle into out/
npm run package:mac  # .dmg + .zip (darwin-arm64)
npm run package:win  # NSIS installer + zip   ⚠ run on Windows
npm run package:linux # AppImage + .deb (amd64)        ⚠ run on Linux
```

Cross-platform packaging is **not** done from a single host — each OS
builds its own targets. See `BUILD_*.md` for the per-platform setup, or
let CI do it (below).

## Releases & CI

Releases are built by GitHub Actions:

- Workflow: [`.github/workflows/release.yml`](.github/workflows/release.yml)
- Jobs: `build-windows` (`windows-latest`) and `build-linux`
  (`ubuntu-latest`), running in parallel.
- macOS continues to build locally (unsigned dmg, no value in CI for now).

**Trigger a release**:

```bash
# 1. Bump version in package.json (e.g. 0.2.0 → 0.2.1)
# 2. Update CHANGELOG.md (move [Unreleased] entries under the new version)
# 3. Commit, then:
git tag v0.2.1
git push origin v0.2.1
```

The tag push fires the workflow, which packages Windows + Linux and
creates a **draft release** on GitHub with all artifacts attached.
Review the draft, fix the body text, then click "Publish release".

**Manual run without a tag** (smoke test):

```bash
gh workflow run "Build & Release" --ref main
gh run watch <run-id>
gh run download <run-id> -D ci-artifacts
```

Artifacts also live on the run page under "Artifacts" for ~90 days.

## Project layout

```
src/
├── main/          Electron main process (Node) — IPC, ffmpeg/dfu-util spawn
│   ├── firmware/  DFU wrapper, SD-driven auto-update, path resolver
│   ├── ffmpeg/    ffmpeg/ffprobe path resolver (bundle → PATH → well-known)
│   ├── ipc/       per-feature IPC handlers (files, mp3, video, ebook, notes, …)
│   ├── store/     App Store client: GitHub sign-in, install on the card, publish
│   └── resources/ bundled native binaries (gitignored heavy ones)
├── preload/       Context bridge: type-safe API exposed to renderer
├── shared/        IPC types shared between main and renderer
└── renderer/      React UI (TS + Tailwind)
    ├── index.html
    └── src/
        ├── App.tsx
        ├── components/
        ├── pages/   one component per top-level tab
        ├── lib/     api wrapper, DeviceContext, ActivityContext, emulator, …
        ├── emu/     ORION emulator as WebAssembly (generated from the SDK)
        └── styles/  Tailwind globals
```

The App Store's server (a Cloudflare Worker) is run by the ORION project and
is not part of this source: the app talks to it over HTTPS. A fork can point
the app to another instance with the `ORION_STORE_URL` environment variable.

## Native binaries (for local builds)

`src/main/resources/` holds platform binaries that electron-builder
bundles as `extraResources`. The macOS `dfu-util` + patched `libusb` are
committed. The `ffmpeg`/`ffprobe` binaries are **gitignored** because
they're heavy and easy to re-download; CI fetches them on every run, and
in local dev you can run a one-off:

- **macOS**: [osxexperts.net](https://osxexperts.net) static builds → `src/main/resources/ffmpeg/darwin-arm64/`
- **Windows**: [gyan.dev essentials](https://www.gyan.dev/ffmpeg/builds/) → `src/main/resources/ffmpeg/win32-x64/`
- **Linux**: [johnvansickle static](https://johnvansickle.com/ffmpeg/) → `src/main/resources/ffmpeg/linux-x64/`

Full per-platform instructions are in `BUILD_WINDOWS.md` /
`BUILD_LINUX.md`.

## Security

- Renderer is sandboxed; no `nodeIntegration`, no `remote`.
- All Node access is mediated by typed IPC channels declared in
  `src/shared/ipc-types.ts`, exposed through the preload script.
- A strict CSP is set in `src/renderer/index.html`. It allows
  `'wasm-unsafe-eval'` for the built-in emulator (WebAssembly) and images from
  `data:` and GitHub avatars only.
- App Store packages are checked against their SHA-256 before anything is
  written to the card, and may only write `/apps/<name>.lua` and
  `/apps/data/<name>/`. Markdown from notes and app pages is rendered with
  raw HTML escaped and links made inert.
- Native binaries are spawned by absolute path (no shell), with no user
  input concatenated into argv.

## License

MIT, see [`LICENSE`](LICENSE). The packaged app also contains FFmpeg,
dfu-util and libusb, which keep their own licences (GPL and LGPL): see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
