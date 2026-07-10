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
- GitHub Actions matrix builds for Windows and Linux.
- GitHub Pages download site backed by GitHub Release assets.

## Voice Defaults

The bundled runtime manifest carries a curated `es_ES` voice set and uses
`es_ES-carlfm-high` as the default voice.

## Licensing

The bundled [Piper 1.4.2](https://github.com/OHF-Voice/piper1-gpl/tree/v1.4.2)
runtime is licensed under GPL-3.0. Its license text and corresponding source
archive are included in every packaged runtime.

Voice models have separate terms:

- `es_ES-carlfm-high`: public domain.
- `es_ES-davefx-medium`: CC0 1.0.
- `es_ES-sharvard-medium`: CC BY 3.0; attribution is included.
- `es_ES-miro-high`: CC BY-NC-SA 4.0; non-commercial use only.

Full source links, attribution, change notices, and license texts are in
[`runtime/licenses/VOICE_MODELS.md`](runtime/licenses/VOICE_MODELS.md).
`es_ES-glados-medium` is intentionally not bundled because its upstream model
repository does not declare a model license.

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

## Automatic Updates

The desktop app checks
`https://github.com/HectorRguez/Audiobook-generator/releases/latest/download/latest.json`
when it starts. If a newer signed release is available, the app shows an update
band with download progress and installs it after user confirmation. Updating is
disabled while an audiobook job is active so a restart cannot interrupt work.

Windows NSIS and Linux AppImage builds support in-app installation. The Linux
`.deb` remains available as a conventional package, but it must be updated
manually. GitHub Actions artifacts are test builds and do not trigger installed
apps; only tagged GitHub Releases are used as the stable public update channel.

## Release Flow

Pushes to `main` build and upload workflow artifacts, then deploy Pages. Tags
matching `v*` build the Windows/Linux matrix, publish GitHub Release assets, and
publish the signed `latest.json` updater manifest. The tag version is injected
into the packaged app during CI.

```bash
git tag v0.3.1
git push origin v0.3.1
```

Initial Windows builds are unsigned. Code signing is a separate hardening step.
Updater packages are still cryptographically signed with Tauri's dedicated
update key. The required GitHub Actions secrets are:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The current private key and password have protected local backups at
`~/.tauri/audiobook-generator.key` and
`~/.tauri/audiobook-generator.key.password`. Back up both files in a secure
secret store. Losing either prevents publishing updates that existing installs
will accept; neither file belongs in Git.
