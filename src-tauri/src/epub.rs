use anyhow::{anyhow, Context, Result};
use html2text::render::TrivialDecorator;
use rbook::{epub::reader::LinearBehavior, Epub};
use std::{collections::HashMap, fs, path::Path};

use crate::language::resolve_narration_language;
use crate::models::{ChapterExtraction, EpubExtractionResult};
use crate::text::normalize_text;

fn html_to_text(html: &str) -> Result<String> {
    let rendered =
        html2text::from_read_with_decorator(html.as_bytes(), usize::MAX, TrivialDecorator::new())
            .context("Failed to render EPUB XHTML as text")?;
    Ok(normalize_text(&rendered))
}

fn navigation_labels(epub: &Epub) -> HashMap<String, String> {
    let mut labels = HashMap::new();
    if let Some(root) = epub.toc().contents() {
        for entry in root.flatten() {
            let label = entry.label().trim();
            if label.is_empty() {
                continue;
            }
            if let Some(manifest_entry) = entry.manifest_entry() {
                labels
                    .entry(manifest_entry.id().to_string())
                    .or_insert_with(|| label.to_string());
            }
        }
    }
    labels
}

pub fn extract_epub(epub_path: &Path, work_dir: &Path) -> Result<EpubExtractionResult> {
    let epub = Epub::options()
        .strict(false)
        .open(epub_path)
        .with_context(|| format!("Failed to parse EPUB {}", epub_path.display()))?;

    let metadata = epub.metadata();
    let title = metadata
        .title()
        .map(|entry| entry.value().trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            epub_path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "Untitled".to_string());
    let author = metadata
        .creators()
        .map(|entry| entry.value().trim().to_string())
        .find(|value| !value.is_empty());
    let declared_language = metadata
        .language()
        .map(|entry| entry.value().trim().to_string())
        .filter(|value| !value.is_empty());
    let labels = navigation_labels(&epub);

    let chapters_dir = work_dir.join("chapters");
    let _ = fs::remove_dir_all(&chapters_dir);
    fs::create_dir_all(&chapters_dir)?;
    let mut chapters = Vec::new();
    let mut total_chars = 0_i64;
    let mut language_sample = String::new();
    let reader = epub
        .reader_builder()
        .linear_behavior(LinearBehavior::Original)
        .create();

    for content_result in reader {
        let content = content_result.context("Failed to read an EPUB spine entry")?;
        let text = html_to_text(content.content())?;
        if text.chars().filter(|ch| ch.is_alphabetic()).count() < 20 {
            continue;
        }

        let index = chapters.len();
        let text_path = chapters_dir.join(format!("{:04}.txt", index + 1));
        fs::write(&text_path, &text)?;
        total_chars += text.chars().count() as i64;
        if language_sample.chars().count() < 50_000 {
            let remaining = 50_000_usize.saturating_sub(language_sample.chars().count());
            language_sample.extend(text.chars().take(remaining));
            language_sample.push('\n');
        }

        let manifest_id = content.manifest_entry().id();
        chapters.push(ChapterExtraction {
            index: index as i64,
            title: labels
                .get(manifest_id)
                .cloned()
                .unwrap_or_else(|| format!("Chapter {}", index + 1)),
            text_path: text_path.to_string_lossy().to_string(),
        });
    }

    if chapters.is_empty() {
        return Err(anyhow!("EPUB parser produced zero readable chapters."));
    }

    let language = resolve_narration_language(declared_language.as_deref(), &language_sample)
        .ok_or_else(|| anyhow!("Only English and Spanish EPUBs are supported."))?;

    Ok(EpubExtractionResult {
        title,
        author,
        language: language.to_string(),
        chapters,
        total_chars,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_files(root: &Path, directory: &Path, files: &mut Vec<String>) {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                fixture_files(root, &path, files);
            } else {
                files.push(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }

    fn write_fixture_epub(source: &Path, destination: &Path) {
        let output = fs::File::create(destination).unwrap();
        let mut archive = zip::ZipWriter::new(output);
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        archive.start_file("mimetype", stored).unwrap();
        archive
            .write_all(&fs::read(source.join("mimetype")).unwrap())
            .unwrap();
        let mut files = Vec::new();
        fixture_files(source, source, &mut files);
        files.sort();
        for relative in files.into_iter().filter(|path| path != "mimetype") {
            archive.start_file(&relative, deflated).unwrap();
            archive
                .write_all(&fs::read(source.join(relative)).unwrap())
                .unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn renders_html_with_structure_and_without_markup() {
        let text = html_to_text(
            r#"<html><head><style>.hidden { display: none; }</style></head><body><p>Uno <em>dos</em>.</p><p>Tres &amp; cuatro.<br>Fin.</p><script>ignored()</script></body></html>"#,
        )
        .unwrap();

        assert_eq!(text, "Uno dos.\n\nTres & cuatro.\nFin.");
    }

    #[test]
    fn extracts_epub3_metadata_navigation_and_spine_from_fixture() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("epub3-book");
        let temp = tempfile::tempdir().unwrap();
        let epub_path = temp.path().join("fixture.epub");
        write_fixture_epub(&fixture, &epub_path);

        let result = extract_epub(&epub_path, &temp.path().join("work")).unwrap();

        assert_eq!(result.title, "Fixture Book");
        assert_eq!(result.author.as_deref(), Some("Fixture Author"));
        assert_eq!(result.language, "en");
        assert_eq!(result.chapters.len(), 2);
        assert_eq!(result.chapters[0].title, "The First Chapter");
        assert_eq!(result.chapters[1].title, "The Second Chapter");
        assert!(result.total_chars > 100);
        assert!(fs::read_to_string(&result.chapters[0].text_path)
            .unwrap()
            .contains("This is the first fixture chapter"));
    }

    #[test]
    fn extracts_epub2_ncx_navigation_from_fixture_archive() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("epub2-book");
        let temp = tempfile::tempdir().unwrap();
        let epub_path = temp.path().join("fixture-2.epub");
        write_fixture_epub(&fixture, &epub_path);

        let result = extract_epub(&epub_path, &temp.path().join("work")).unwrap();

        assert_eq!(result.title, "Spanish Fixture");
        assert_eq!(result.author.as_deref(), Some("Fixture Author"));
        assert_eq!(result.language, "es");
        assert_eq!(result.chapters.len(), 1);
        assert_eq!(result.chapters[0].title, "Capitulo de prueba");
    }
}
