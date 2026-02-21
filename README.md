# Audiobook Generator

Electron + Next (static export) desktop app to process **EPUB -> audiobook** with a durable queue.

## Highlights

- EPUB-only ingestion (multi-file enqueue)
- Persistent queue and generated library in SQLite
- 3-panel UI:
  - left: draggable processing queue
  - center: active progress + ETA
  - right: generated audios (newest first) with export button
- Checkpoint persistence while processing (chapter/chunk progress)
- Runtime sidecar bootstrap on first launch (Piper + ffmpeg + voice)
- Platform-aware sidecars (`win32-x64`, `linux-x64`)

## Voice default

Default voice target is Spanish male: `es_ES-davefx-medium`.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build:desktop
npm run dist:win
```

## Sidecar manifest

`electron/assets/sidecar-manifest.json` controls runtime asset downloads.

- Use direct downloadable URLs.
- Do not use postdownload URLs.
- Keep `paths` aligned with extracted archive layout.
- Replace current `example.com` placeholders with real pinned download URLs before shipping.

Validate manifest:

```bash
npm run verify:sidecars
```

## Notes

- Auto-update is wired via `electron-updater` for packaged Windows builds.
- Release workflow is in `.github/workflows/build-win.yml`.
- Runtime assets are downloaded to user data under `runtime-assets/`.
