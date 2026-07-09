use anyhow::{anyhow, Context, Result};
use html_escape::decode_html_entities;
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use zip::ZipArchive;

use crate::models::{ChapterExtraction, EpubExtractionResult};
use crate::text::normalize_text;

#[derive(Debug, Clone)]
struct ManifestItem {
    href: String,
    title: Option<String>,
}

#[derive(Debug)]
struct ParsedOpf {
    title: String,
    author: Option<String>,
    manifest: HashMap<String, ManifestItem>,
    spine: Vec<String>,
}

fn read_zip_entry(archive: &mut ZipArchive<fs::File>, name: &str) -> Result<String> {
    let mut file = archive
        .by_name(name)
        .with_context(|| format!("Missing EPUB entry {name}"))?;
    let mut value = String::new();
    file.read_to_string(&mut value)?;
    Ok(value)
}

fn attr_value(event: &quick_xml::events::BytesStart<'_>, name: &[u8]) -> Option<String> {
    event
        .attributes()
        .flatten()
        .find(|attr| attr.key.as_ref() == name)
        .and_then(|attr| String::from_utf8(attr.value.to_vec()).ok())
}

fn find_rootfile(container_xml: &str) -> Result<String> {
    let mut reader = Reader::from_str(container_xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event()? {
            Event::Start(event) | Event::Empty(event)
                if event.name().as_ref().ends_with(b"rootfile") =>
            {
                if let Some(path) = attr_value(&event, b"full-path") {
                    return Ok(path);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Err(anyhow!("EPUB container has no rootfile."))
}

fn parse_opf(opf: &str) -> Result<ParsedOpf> {
    let mut reader = Reader::from_str(opf);
    reader.config_mut().trim_text(true);
    let mut title = String::new();
    let mut author = None;
    let mut current_text_tag: Option<String> = None;
    let mut manifest = HashMap::new();
    let mut spine = Vec::new();

    loop {
        match reader.read_event()? {
            Event::Start(event) => {
                let name = String::from_utf8_lossy(event.name().as_ref()).to_string();
                if name.ends_with("title") || name.ends_with("creator") {
                    current_text_tag = Some(name);
                }
            }
            Event::Empty(event) => {
                let name = String::from_utf8_lossy(event.name().as_ref()).to_string();
                if name.ends_with("item") {
                    if let (Some(id), Some(href)) =
                        (attr_value(&event, b"id"), attr_value(&event, b"href"))
                    {
                        manifest.insert(
                            id,
                            ManifestItem {
                                href,
                                title: attr_value(&event, b"title"),
                            },
                        );
                    }
                }
                if name.ends_with("itemref") {
                    if let Some(idref) = attr_value(&event, b"idref") {
                        spine.push(idref);
                    }
                }
            }
            Event::Text(text) => {
                if let Some(tag) = &current_text_tag {
                    let value = text.decode()?.trim().to_string();
                    if tag.ends_with("title") && title.is_empty() {
                        title = value;
                    } else if tag.ends_with("creator") && author.is_none() {
                        author = Some(value);
                    }
                }
            }
            Event::End(_) => current_text_tag = None,
            Event::Eof => break,
            _ => {}
        }
    }

    if title.is_empty() {
        title = "Untitled".to_string();
    }
    Ok(ParsedOpf {
        title,
        author,
        manifest,
        spine,
    })
}

fn resolve_epub_path(opf_path: &str, href: &str) -> String {
    let base = Path::new(opf_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    base.join(href).to_string_lossy().replace('\\', "/")
}

fn strip_html(html: &str) -> String {
    let without_scripts = Regex::new(r"(?is)<script[^>]*>.*?</script>")
        .unwrap()
        .replace_all(html, " ");
    let without_styles = Regex::new(r"(?is)<style[^>]*>.*?</style>")
        .unwrap()
        .replace_all(&without_scripts, " ");
    let block_separated = Regex::new(r"(?i)</(p|div|section|article|h[1-6]|li)>")
        .unwrap()
        .replace_all(&without_styles, "\n\n");
    let no_tags = Regex::new(r"(?s)<[^>]+>")
        .unwrap()
        .replace_all(&block_separated, " ");
    let decoded = decode_html_entities(no_tags.as_ref());
    normalize_text(decoded.as_ref())
}

fn chapter_title(item: &ManifestItem, fallback_index: usize) -> String {
    item.title
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| format!("Chapter {}", fallback_index + 1))
}

pub fn extract_epub(epub_path: &Path, work_dir: &Path) -> Result<EpubExtractionResult> {
    let file = fs::File::open(epub_path)
        .with_context(|| format!("Failed to open EPUB {}", epub_path.display()))?;
    let mut archive = ZipArchive::new(file)?;
    let container_xml = read_zip_entry(&mut archive, "META-INF/container.xml")?;
    let opf_path = find_rootfile(&container_xml)?;
    let opf = read_zip_entry(&mut archive, &opf_path)?;
    let ParsedOpf {
        mut title,
        author,
        manifest,
        spine,
    } = parse_opf(&opf)?;
    if title == "Untitled" {
        title = epub_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled")
            .to_string();
    }

    let chapters_dir = work_dir.join("chapters");
    fs::create_dir_all(&chapters_dir)?;
    let mut chapters = Vec::new();
    let mut total_chars = 0_i64;

    for idref in spine {
        let Some(item) = manifest.get(&idref) else {
            continue;
        };
        let entry_path = resolve_epub_path(&opf_path, &item.href);
        let Ok(html) = read_zip_entry(&mut archive, &entry_path) else {
            continue;
        };
        let text = strip_html(&html);
        if text.chars().filter(|ch| ch.is_alphabetic()).count() < 20 {
            continue;
        }
        let index = chapters.len();
        let text_path: PathBuf = chapters_dir.join(format!("{:04}.txt", index + 1));
        fs::write(&text_path, &text)?;
        total_chars += text.len() as i64;
        chapters.push(ChapterExtraction {
            index: index as i64,
            title: chapter_title(item, index),
            text_path: text_path.to_string_lossy().to_string(),
        });
    }

    if chapters.is_empty() {
        return Err(anyhow!("EPUB parser produced zero readable chapters."));
    }

    Ok(EpubExtractionResult {
        title,
        author,
        chapters,
        total_chars,
    })
}
