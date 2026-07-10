# Audiobook Generator

Tauri v2 desktop app that turns EPUB files into local audiobooks with a bundled
Python runtime running `piper-tts[http]==1.4.2`.

## Highlights

- EPUB-only ingestion with multi-file enqueue.
- Persistent queue and generated-audio library in SQLite.
- Tauri v2 shell with a static Next renderer.
- Bundled per-platform runtime assets:
  - embedded Python
  - Piper HTTP server
  - ffmpeg and ffprobe
  - selected Spanish Piper voices
- Persistent local Piper HTTP synthesis backend.
- GitHub Actions matrix builds for Windows, Linux, macOS Intel, and macOS Apple
  Silicon.
- GitHub Pages download site backed by GitHub Release assets.

## Voice Defaults

The bundled runtime manifest carries a curated `es_ES` voice set and uses
`es_ES-carlfm-high` as the default voice.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts the Tauri app. The renderer can still be run directly for UI
work:

```bash
npm run dev:renderer
```

## Runtime Build And Smoke Test

```bash
npm run build:runtime -- --target linux-x64
npm run smoke:runtime -- --runtime runtime/dist/linux-x64
npm run build:voice-demos -- --runtime runtime/dist/linux-x64 --out voice-demos
```

Supported initial runtime targets:

- `win32-x64`
- `linux-x64`
- `darwin-x64`
- `darwin-arm64`

## App Build

```bash
npm run build:tauri
npm run collect:tauri-artifacts -- --target linux-x64
```

CI prepares the runtime before building Tauri. For local builds, prepare the
matching runtime target first, or set `AUDIOBOOK_RUNTIME_DIR` to a prepared
runtime directory.

## GitHub Pages

The public download page lives under `site/` and is built with:

```bash
npm run build:site
```

The page is intentionally minimal: mono text, beige background, serif title,
compact headings, dot bullets, and outlined download links. Binaries are not
stored in Pages; the page links to GitHub Release assets through
`releases/latest/download/...`.

## Release Flow

Pushes to `main` build and upload workflow artifacts, then deploy Pages. Tags
matching `v*` build the same platform matrix and publish GitHub Release assets.

```bash
git tag v0.3.0
git push origin v0.3.0
```

Initial builds are unsigned. Windows/macOS signing and notarization are a
separate hardening step.
