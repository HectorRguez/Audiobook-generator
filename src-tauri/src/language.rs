use whatlang::{detect, Lang};

pub const ENGLISH: &str = "en";
pub const SPANISH: &str = "es";

fn supported_language_tag(value: &str) -> Option<&'static str> {
    let normalized = value.trim().to_ascii_lowercase().replace('_', "-");
    let language = normalized.split('-').next().unwrap_or_default();
    match language {
        ENGLISH => Some(ENGLISH),
        SPANISH => Some(SPANISH),
        _ => None,
    }
}

pub fn resolve_narration_language(metadata: Option<&str>, text: &str) -> Option<&'static str> {
    if let Some(language) = metadata.and_then(supported_language_tag) {
        return Some(language);
    }

    let detected = detect(text)?;
    match detected.lang() {
        Lang::Eng => Some(ENGLISH),
        Lang::Spa => Some(SPANISH),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_common_epub_language_tags() {
        assert_eq!(resolve_narration_language(Some("en-US"), ""), Some(ENGLISH));
        assert_eq!(resolve_narration_language(Some("es_ES"), ""), Some(SPANISH));
    }

    #[test]
    fn metadata_takes_priority_over_content_detection() {
        let spanish = "Este texto esta escrito en espanol y contiene suficientes palabras para detectar el idioma.";
        assert_eq!(
            resolve_narration_language(Some("en"), spanish),
            Some(ENGLISH)
        );
    }

    #[test]
    fn detects_supported_languages_when_metadata_is_missing() {
        let english = "This chapter tells a long story about a family travelling across the country together.";
        let spanish = "Este capitulo cuenta una larga historia sobre una familia que viaja junta por todo el pais.";
        assert_eq!(resolve_narration_language(None, english), Some(ENGLISH));
        assert_eq!(resolve_narration_language(None, spanish), Some(SPANISH));
    }

    #[test]
    fn rejects_languages_without_a_bundled_voice() {
        let french = "Ce chapitre raconte une longue histoire sur une famille qui voyage ensemble dans le pays.";
        assert_eq!(resolve_narration_language(Some("fr"), french), None);
    }
}
