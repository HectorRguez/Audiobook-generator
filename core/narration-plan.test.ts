import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChapterPlan,
  splitParagraphs,
  splitSentences
} from "./narration-plan";
import { normalizeText } from "./text-utils";

test("normalizeText preserves paragraph boundaries", () => {
  const normalized = normalizeText("Uno  dos.\n\n\nTres   cuatro.");
  assert.equal(normalized, "Uno dos.\n\nTres cuatro.");
  assert.deepEqual(splitParagraphs(normalized), ["Uno dos.", "Tres cuatro."]);
});

test("splitSentences handles common Spanish abbreviations", () => {
  const sentences = splitSentences("Sr. Garcia llego temprano. Despues hablo.");
  assert.deepEqual(sentences, ["Sr. Garcia llego temprano.", "Despues hablo."]);
});

test("buildChapterPlan produces deterministic speech and silence segments", () => {
  const input = {
    index: 1,
    title: "Chapter",
    text: "Primera frase. Segunda frase.\n\nNuevo parrafo."
  };

  assert.deepEqual(buildChapterPlan(input), buildChapterPlan(input));
});

test("buildChapterPlan splits long sentences at word boundaries", () => {
  const longSentence = Array.from({ length: 40 }, (_, idx) => `palabra${idx}`).join(" ");
  const plan = buildChapterPlan(
    { index: 0, title: "Long", text: `${longSentence}.` },
    { maxSpeechChars: 80, minSpeechChars: 30 }
  );
  const speechSegments = plan.segments.filter((segment) => segment.kind === "speech");

  assert.ok(speechSegments.length > 1);
  speechSegments.forEach((segment) => {
    assert.ok(segment.text.length <= 80);
    assert.equal(segment.text.trim(), segment.text);
  });
});

test("buildChapterPlan applies default paragraph and chapter pauses", () => {
  const plan = buildChapterPlan({
    index: 0,
    title: "Pauses",
    text: "Primer parrafo.\n\nSegundo parrafo."
  });
  const silenceSegments = plan.segments.filter((segment) => segment.kind === "silence");

  assert.equal(plan.sentenceSilenceSeconds, 0.25);
  assert.ok(silenceSegments.some((segment) => segment.reason === "paragraph" && segment.durationMs === 650));
  assert.ok(silenceSegments.some((segment) => segment.reason === "chapter" && segment.durationMs === 1200));
});
