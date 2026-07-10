# Voice Model Notices

Piper voice models have terms that are separate from the Piper engine. The
models below are redistributed unchanged. Source revisions are pinned in
`runtime/voices.json` so a release can be traced to the reviewed model card.

## es_ES-carlfm-high (Carlfm)

- Source and model card: https://huggingface.co/friyin/vits-piper-es_ES-carlfm-high/tree/901b4e5482d44f38086d05104c5f61d9b70526e9
- Declared terms: Public domain
- Attribution: CarlFM voice model trained by Daniel Fernandez (friyin) from
  the carlfm01/my-speech-datasets public-domain dataset.
- Changes by Audiobook Generator: none; the ONNX model and configuration are
  redistributed unchanged.

## es_ES-davefx-medium (Davefx)

- Source: https://huggingface.co/rhasspy/piper-voices/tree/e21c7de8d4eab79b902f0d61e662b3f21664b8d2/es/es_ES/davefx/medium
- Model card: https://huggingface.co/rhasspy/piper-voices/blob/e21c7de8d4eab79b902f0d61e662b3f21664b8d2/es/es_ES/davefx/medium/MODEL_CARD
- Declared terms: CC0 1.0
- License: https://creativecommons.org/publicdomain/zero/1.0/
- Attribution: Davefx Piper voice from OHF-Voice/voice-datasets, finetuned
  from the U.S. English lessac medium voice.
- Changes by Audiobook Generator: none; the ONNX model and configuration are
  redistributed unchanged.

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

## es_ES-miro-high (Miro)

- Source and model card: https://huggingface.co/csukuangfj/vits-piper-es_ES-miro-high/tree/0e1f773561429a9e50fa23d868a40eb341ad83c4
- Declared terms: Creative Commons Attribution-NonCommercial-ShareAlike 4.0
  (CC BY-NC-SA 4.0)
- License: https://creativecommons.org/licenses/by-nc-sa/4.0/
- Use restriction: non-commercial use only. Adaptations must be distributed
  under the same license.
- Attribution: Miro Spanish Piper model converted from
  OpenVoiceOS/pipertts_es-ES_miro and trained with
  TigreGotico/tts-train-synthetic-miro_es-ES.
- Changes by Audiobook Generator: none; the ONNX model and configuration are
  redistributed unchanged.

## Excluded Models

`es_ES-glados-medium` is not bundled because its upstream repository does not
declare a model license. Audiobook Generator does not redistribute voice models
whose terms cannot be verified.
