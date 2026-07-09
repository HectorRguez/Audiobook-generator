use anyhow::{anyhow, Context, Result};
use sanitize_filename::sanitize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

pub fn output_paths(
    output_dir: &Path,
    title: &str,
    author: Option<&str>,
    format: &str,
) -> (PathBuf, PathBuf) {
    let safe_title = sanitize(if title.trim().is_empty() {
        "Untitled"
    } else {
        title
    });
    let safe_author = sanitize(author.unwrap_or("Unknown"));
    let folder = format!(
        "{} - {}",
        if safe_title.is_empty() {
            "Untitled"
        } else {
            &safe_title
        },
        if safe_author.is_empty() {
            "Unknown"
        } else {
            &safe_author
        }
    );
    let extension = if format == "m4b" { "m4b" } else { "mp3" };
    let destination_dir = output_dir.join(folder);
    let final_path = destination_dir.join(format!(
        "{}.{}",
        if safe_title.is_empty() {
            "Untitled"
        } else {
            &safe_title
        },
        extension
    ));
    (destination_dir, final_path)
}

fn quote_for_concat(path: &Path) -> String {
    format!("file '{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

pub async fn concat_wavs(
    ffmpeg: &Path,
    inputs: &[PathBuf],
    output: &Path,
    temp_dir: &Path,
) -> Result<()> {
    if inputs.is_empty() {
        return Err(anyhow!("concat_wavs requires at least one input."));
    }
    fs::create_dir_all(temp_dir)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let list_path = temp_dir.join(format!("concat-{}.txt", uuid::Uuid::new_v4()));
    let list = inputs
        .iter()
        .map(|path| quote_for_concat(path))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&list_path, list)?;
    let status = Command::new(ffmpeg)
        .args(["-y", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list_path)
        .args(["-c", "copy"])
        .arg(output)
        .stdin(Stdio::null())
        .status()
        .await
        .context("Failed to run ffmpeg concat")?;
    let _ = fs::remove_file(&list_path);
    if !status.success() {
        return Err(anyhow!("ffmpeg concat failed with {status}"));
    }
    Ok(())
}

pub async fn encode_final_audio(
    ffmpeg: &Path,
    input_wav: &Path,
    output: &Path,
    format: &str,
    title: &str,
    author: Option<&str>,
) -> Result<()> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut command = Command::new(ffmpeg);
    command.arg("-y").arg("-i").arg(input_wav);
    command.arg("-metadata").arg(format!("title={title}"));
    if let Some(author) = author {
        command.arg("-metadata").arg(format!("artist={author}"));
    }
    if format == "m4b" {
        command.args(["-c:a", "aac", "-b:a", "128k"]);
    } else {
        command.args(["-c:a", "libmp3lame", "-q:a", "2"]);
    }
    let status = command
        .arg(output)
        .stdin(Stdio::null())
        .status()
        .await
        .context("Failed to run ffmpeg encode")?;
    if !status.success() {
        return Err(anyhow!("ffmpeg encode failed with {status}"));
    }
    Ok(())
}

pub async fn duration_ms(ffprobe: &Path, input: &Path) -> Result<i64> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
        ])
        .arg(input)
        .stdin(Stdio::null())
        .output()
        .await
        .context("Failed to run ffprobe")?;
    if !output.status.success() {
        return Ok(0);
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    let seconds = parsed
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| duration.as_str())
        .and_then(|duration| duration.parse::<f64>().ok())
        .unwrap_or(0.0);
    Ok((seconds * 1000.0).round() as i64)
}
