use text_splitter::TextSplitter;

use crate::text::normalize_text;

pub const MIN_SPEECH_CHARS: usize = 700;
pub const MAX_SPEECH_CHARS: usize = 1800;
pub const SENTENCE_SILENCE_MS: u64 = 250;
pub const PARAGRAPH_PAUSE_MS: u64 = 650;
pub const CHAPTER_PAUSE_MS: u64 = 1200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SilenceReason {
    Sentence,
    Paragraph,
    Chapter,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NarrationSegment {
    Speech {
        speech_index: usize,
        text: String,
        paragraph_index: usize,
    },
    Silence {
        duration_ms: u64,
        reason: SilenceReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChapterPlan {
    pub segments: Vec<NarrationSegment>,
    pub speech_segment_count: usize,
    pub total_speech_chars: usize,
}

fn paragraphs(text: &str) -> Vec<String> {
    normalize_text(text)
        .split("\n\n")
        .map(|paragraph| paragraph.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|paragraph| !paragraph.is_empty())
        .collect()
}

pub fn build_chapter_plan(text: &str) -> ChapterPlan {
    let splitter = TextSplitter::new(MIN_SPEECH_CHARS..=MAX_SPEECH_CHARS);
    let paragraphs = paragraphs(text);
    let mut segments = Vec::new();
    let mut speech_index = 0;
    let mut total_speech_chars = 0;

    for (paragraph_index, paragraph) in paragraphs.iter().enumerate() {
        let chunks = splitter
            .chunks(paragraph)
            .map(str::to_owned)
            .collect::<Vec<_>>();

        for (chunk_index, chunk) in chunks.iter().enumerate() {
            total_speech_chars += chunk.chars().count();
            segments.push(NarrationSegment::Speech {
                speech_index,
                text: chunk.clone(),
                paragraph_index,
            });
            speech_index += 1;

            if chunk_index + 1 < chunks.len() {
                segments.push(NarrationSegment::Silence {
                    duration_ms: SENTENCE_SILENCE_MS,
                    reason: SilenceReason::Sentence,
                });
            }
        }

        if !chunks.is_empty() && paragraph_index + 1 < paragraphs.len() {
            segments.push(NarrationSegment::Silence {
                duration_ms: PARAGRAPH_PAUSE_MS,
                reason: SilenceReason::Paragraph,
            });
        }
    }

    if speech_index > 0 {
        segments.push(NarrationSegment::Silence {
            duration_ms: CHAPTER_PAUSE_MS,
            reason: SilenceReason::Chapter,
        });
    }

    ChapterPlan {
        segments,
        speech_segment_count: speech_index,
        total_speech_chars,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_paragraph_and_chapter_pauses() {
        let plan = build_chapter_plan("Primer parrafo.\n\nSegundo parrafo.");

        assert_eq!(plan.speech_segment_count, 2);
        assert_eq!(
            plan.segments,
            vec![
                NarrationSegment::Speech {
                    speech_index: 0,
                    text: "Primer parrafo.".to_string(),
                    paragraph_index: 0,
                },
                NarrationSegment::Silence {
                    duration_ms: PARAGRAPH_PAUSE_MS,
                    reason: SilenceReason::Paragraph,
                },
                NarrationSegment::Speech {
                    speech_index: 1,
                    text: "Segundo parrafo.".to_string(),
                    paragraph_index: 1,
                },
                NarrationSegment::Silence {
                    duration_ms: CHAPTER_PAUSE_MS,
                    reason: SilenceReason::Chapter,
                },
            ]
        );
    }

    #[test]
    fn dependency_splits_long_text_at_unicode_boundaries() {
        let text = "palabra ".repeat(700);
        let plan = build_chapter_plan(&text);
        let speech = plan
            .segments
            .iter()
            .filter_map(|segment| match segment {
                NarrationSegment::Speech { text, .. } => Some(text),
                NarrationSegment::Silence { .. } => None,
            })
            .collect::<Vec<_>>();

        assert!(speech.len() > 1);
        assert!(speech
            .iter()
            .all(|segment| segment.chars().count() <= MAX_SPEECH_CHARS));
        assert!(speech
            .iter()
            .all(|segment| segment.split_whitespace().all(|word| word == "palabra")));
        assert!(plan.segments.iter().any(|segment| matches!(
            segment,
            NarrationSegment::Silence {
                duration_ms: SENTENCE_SILENCE_MS,
                reason: SilenceReason::Sentence,
            }
        )));
    }

    #[test]
    fn keeps_spanish_abbreviations_with_the_following_sentence_text() {
        let text = "El Sr. Garcia llego. ¿Como esta? ¡Muy bien! ".repeat(100);
        let plan = build_chapter_plan(&text);

        for segment in plan.segments {
            if let NarrationSegment::Speech { text, .. } = segment {
                assert!(!text.ends_with("Sr."));
            }
        }
    }

    #[test]
    fn plan_is_deterministic() {
        let text = "Uno. Dos. Tres. ".repeat(300);
        assert_eq!(build_chapter_plan(&text), build_chapter_plan(&text));
    }
}
