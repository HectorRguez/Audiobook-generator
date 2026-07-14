# Voice Model Notices

Piper voice models have terms that are separate from the Piper engine. The
models below are redistributed unchanged. Source revisions are pinned in
`runtime/voices.json` so a release can be traced to the reviewed model card.

## es_ES-sharvard-medium (Sharvard)

- Source: https://huggingface.co/rhasspy/piper-voices/tree/e21c7de8d4eab79b902f0d61e662b3f21664b8d2/es/es_ES/sharvard/medium
- Model card: https://huggingface.co/rhasspy/piper-voices/blob/e21c7de8d4eab79b902f0d61e662b3f21664b8d2/es/es_ES/sharvard/medium/MODEL_CARD
- Declared terms: Creative Commons Attribution 3.0 (CC BY 3.0)
- License: https://creativecommons.org/licenses/by/3.0/
- Required attribution: Mayo, C.; Cooke, M.; Aubanel, V.; Garcia Lecumberri,
  M. L. (2013). Sharvard. Edinburgh DataShare.
  https://doi.org/10.7488/ds/133
- Changes: the Piper project created a finetuned ONNX voice model from the
  Sharvard dataset. Audiobook Generator redistributes that model unchanged.

## es_ES-davefx-medium (Davefx)

- Source: https://huggingface.co/rhasspy/piper-voices/tree/e21c7de8d4eab79b902f0d61e662b3f21664b8d2/es/es_ES/davefx/medium
- Model card: https://huggingface.co/rhasspy/piper-voices/blob/e21c7de8d4eab79b902f0d61e662b3f21664b8d2/es/es_ES/davefx/medium/MODEL_CARD
- Declared terms: CC0 1.0
- License: https://creativecommons.org/publicdomain/zero/1.0/
- Attribution: Davefx Piper voice from OHF-Voice/voice-datasets, finetuned
  from the U.S. English lessac medium voice.
- Changes by Audiobook Generator: none; the ONNX model and configuration are
  redistributed unchanged.

## Excluded Models

`es_ES-glados-medium` is not bundled because its upstream repository does not
declare a model license. Audiobook Generator does not redistribute voice models
whose terms cannot be verified.
