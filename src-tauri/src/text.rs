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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_paragraphs_while_normalizing() {
        assert_eq!(normalize_text("Uno  dos.\n\n\nTres"), "Uno dos.\n\nTres");
    }

    #[test]
    fn joins_hyphenated_line_breaks_without_damaging_unicode() {
        assert_eq!(
            normalize_text("Una palabra multi-\nlingue y una canci\u{00f3}n-\n\u{00fa}nica."),
            "Una palabra multilingue y una canci\u{00f3}n\u{00fa}nica."
        );
    }

    #[test]
    fn removes_standalone_page_numbers() {
        assert_eq!(
            normalize_text("Primer parrafo.\n\n42\n\nSegundo parrafo."),
            "Primer parrafo.\n\nSegundo parrafo."
        );
    }
}
