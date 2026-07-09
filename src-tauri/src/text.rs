use regex::Regex;

fn remove_hyphenated_line_breaks(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] == '-'
            && chars.get(index + 1) == Some(&'\n')
            && chars
                .get(index + 2)
                .is_some_and(|next| next.is_alphanumeric() || *next == '_')
        {
            index += 2;
            continue;
        }

        output.push(chars[index]);
        index += 1;
    }

    output
}

fn is_sentence_terminal(ch: char) -> bool {
    matches!(ch, '.' | '!' | '?')
}

fn is_sentence_starter(ch: char) -> bool {
    ch.is_ascii_uppercase()
        || ch.is_ascii_digit()
        || matches!(
            ch,
            'Á' | 'É' | 'Í' | 'Ó' | 'Ú' | 'Ñ' | 'Ü' | '"' | '\'' | '¿' | '¡'
        )
}

fn split_sentences_legacy(text: &str) -> Vec<String> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut sentences = Vec::new();
    let mut start = 0;
    let mut index = 0;

    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if ch.is_whitespace() && index > 0 && is_sentence_terminal(chars[index - 1].1) {
            let mut next = index;
            while next < chars.len() && chars[next].1.is_whitespace() {
                next += 1;
            }

            if next < chars.len() && is_sentence_starter(chars[next].1) {
                let sentence = text[start..byte_index].trim();
                if !sentence.is_empty() {
                    sentences.push(sentence.to_string());
                }
                start = chars[next].0;
                index = next;
                continue;
            }
        }

        index += 1;
    }

    let sentence = text[start..].trim();
    if !sentence.is_empty() {
        sentences.push(sentence.to_string());
    }

    sentences
}

pub fn normalize_text(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut value = input.replace('\r', "");
    value = value.replace('\u{000c}', "\n");
    value = remove_hyphenated_line_breaks(&value);
    value = Regex::new(r"[ \t]+")
        .unwrap()
        .replace_all(&value, " ")
        .to_string();
    value = Regex::new(r"[ \t]*\n[ \t]*")
        .unwrap()
        .replace_all(&value, "\n")
        .to_string();
    value = Regex::new(r"\n{3,}")
        .unwrap()
        .replace_all(&value, "\n\n")
        .to_string();
    value = Regex::new(r"(?m)^\s*\d+\s*$")
        .unwrap()
        .replace_all(&value, "")
        .to_string();
    value.trim().to_string()
}

pub fn split_into_chunks(text: &str, min_chars: usize, max_chars: usize) -> Vec<String> {
    let normalized = normalize_text(text);
    if normalized.is_empty() {
        return Vec::new();
    }

    let sentences = split_sentences_legacy(&normalized);

    let mut chunks = Vec::new();
    let mut current = String::new();
    for sentence in sentences {
        if current.is_empty() {
            current = sentence;
            continue;
        }

        if current.len() + sentence.len() < max_chars {
            current.push(' ');
            current.push_str(&sentence);
            continue;
        }

        if current.len() < min_chars && sentence.len() < max_chars {
            current.push(' ');
            current.push_str(&sentence);
            continue;
        }

        chunks.push(current);
        current = sentence;
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    if chunks.is_empty() {
        vec![normalized.chars().take(max_chars).collect()]
    } else {
        chunks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_paragraphs_while_normalizing() {
        assert_eq!(normalize_text("Uno  dos.\n\n\nTres"), "Uno dos.\n\nTres");
    }

    #[test]
    fn chunks_sentences() {
        let chunks = split_into_chunks("Uno. Dos. Tres.", 1, 10);
        assert_eq!(chunks, vec!["Uno. Dos.", "Tres."]);
    }
}
