This directory is reserved for a bundled default Piper voice.

Current runtime behavior:
- If `PIPER_VOICE_MODEL` env var is set, it is used directly.
- Otherwise, the first-run sidecar bootstrap downloads the default voice archive from `electron/assets/sidecar-manifest.json`.

For fully offline distribution, place:
- `es_ES-carlfm-high.onnx`
- `es_ES-carlfm-high.onnx.json`

in this directory and update `sidecar-manifest.json` to point `defaultVoiceModel/defaultVoiceConfig` here.
