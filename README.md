# Audiobook Generator

Next static renderer with Electron compatibility and a Tauri v2 migration path to
process **EPUB -> audiobook** with a durable queue.

## Highlights

- EPUB-only ingestion (multi-file enqueue)
- Persistent queue and generated library in SQLite
- 3-panel UI:
  - left: draggable processing queue
  - center: active progress + ETA
  - right: generated audios (newest first) with export button
- Checkpoint persistence while processing (chapter/chunk progress)
- Tauri v2 shell scaffold for smaller desktop binaries
- Bundled runtime plan based on embedded Python + `piper-tts[http]==1.4.2`
- Piper HTTP backend for persistent local synthesis

## Voice defaults

The bundled runtime manifest carries a curated `es_ES` set and uses
`es_ES-carlfm-high` as the default voice.

## Development

```bash
npm install
npm run dev
```

Tauri development:

```bash
npm run dev:tauri
```

## Build

```bash
npm run build:desktop
npm run dist:win
```

Tauri build:

```bash
npm run build:runtime -- --target linux-x64
npm run smoke:runtime -- --runtime runtime/dist/linux-x64
npm run build:voice-demos -- --runtime runtime/dist/linux-x64 --out voice-demos
npm run build:tauri
npm run collect:tauri-artifacts -- --target linux-x64
```

## Sidecar manifest

`electron/assets/sidecar-manifest.json` controls the legacy Electron-side
runtime asset downloads.

- Use direct downloadable URLs.
- Do not use postdownload URLs.
- Keep `paths` aligned with extracted archive layout.
- Replace current `example.com` placeholders with real pinned download URLs before shipping.

Validate manifest:

```bash
npm run verify:sidecars
```

## Piper benchmark

Compare Piper startup modes with local assets:

```bash
PIPER_BIN=/path/to/piper \
PIPER_VOICE_MODEL=/path/to/voice.onnx \
PIPER_VOICE_CONFIG=/path/to/voice.onnx.json \
npm run benchmark:piper
```

Set `PIPER_HTTP_URL` to include a locally running Piper HTTP server in the
comparison. The report is written to `.cache/` by default.

## GitHub Pages

The public download page lives under `site/` and is built with:

```bash
npm run build:site
```

The page intentionally mirrors the minimal style of the Numbda personal site:
mono text, beige background, serif title, compact headings, dot bullets, and
outlined download links.

## Notes

- Auto-update is wired via `electron-updater` for packaged Windows builds and
  only runs when `GH_TOKEN` is provided by the runtime environment.
- Tauri release workflow is in `.github/workflows/build-tauri.yml`.
- Tauri runtime assets are loaded from bundled resources or
  `AUDIOBOOK_RUNTIME_DIR` during development.
