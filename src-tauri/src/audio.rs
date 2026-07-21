use anyhow::{anyhow, Context, Result};
use sanitize_filename::sanitize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

pub fn wav_is_valid(path: &Path, expected_sample_rate: Option<u32>) -> bool {
    let Ok(mut reader) = hound::WavReader::open(path) else {
        return false;
    };
    let spec = reader.spec();
    let expected_samples = u64::from(reader.duration()) * u64::from(spec.channels);
    if expected_samples == 0
        || spec.channels == 0
        || spec.sample_rate == 0
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
        || expected_sample_rate.is_some_and(|rate| spec.sample_rate != rate)
    {
        return false;
    }
    let mut actual_samples = 0_u64;
    for sample in reader.samples::<i16>() {
        if sample.is_err() {
            return false;
        }
        actual_samples += 1;
    }
    actual_samples == expected_samples
}

pub fn wav_sample_rate(path: &Path) -> Option<u32> {
    hound::WavReader::open(path)
        .ok()
        .map(|reader| reader.spec().sample_rate)
}

pub fn write_wav_atomically(
    output: &Path,
    bytes: &[u8],
    expected_sample_rate: Option<u32>,
) -> Result<()> {
    let parent = output
        .parent()
        .ok_or_else(|| anyhow!("WAV output has no parent: {}", output.display()))?;
    fs::create_dir_all(parent)?;
    let temp_path = parent.join(format!(
        ".{}.{}.part",
        output
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("audio.wav"),
        uuid::Uuid::new_v4()
    ));
    fs::write(&temp_path, bytes)?;
    if !wav_is_valid(&temp_path, expected_sample_rate) {
        let _ = fs::remove_file(&temp_path);
        return Err(anyhow!("Piper returned an invalid WAV file."));
    }
    if output.exists() {
        fs::remove_file(output)?;
    }
    fs::rename(&temp_path, output)?;
    Ok(())
}

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

fn prepend_path_env(command: &mut Command, key: &str, value: &Path) {
    let mut paths = vec![value.to_path_buf()];
    if let Some(existing) = env::var_os(key) {
        paths.extend(env::split_paths(&existing));
    }
    if let Ok(joined) = env::join_paths(paths) {
        command.env(key, joined);
    }
}

fn runtime_tool_command(exe: &Path) -> Command {
    let mut command = Command::new(exe);
    if let Some(parent) = exe.parent() {
        let lib_dir = parent.join("lib");
        if lib_dir.is_dir() {
            #[cfg(target_os = "linux")]
            prepend_path_env(&mut command, "LD_LIBRARY_PATH", &lib_dir);

            #[cfg(target_os = "macos")]
            prepend_path_env(&mut command, "DYLD_LIBRARY_PATH", &lib_dir);

            #[cfg(windows)]
            prepend_path_env(&mut command, "PATH", &lib_dir);
        }
    }
    command
}

pub async fn concat_wavs(inputs: &[PathBuf], output: &Path) -> Result<()> {
    if inputs.is_empty() {
        return Err(anyhow!("concat_wavs requires at least one input."));
    }
    let parent = output
        .parent()
        .ok_or_else(|| anyhow!("WAV output has no parent: {}", output.display()))?;
    fs::create_dir_all(parent)?;
    let temp_output = parent.join(format!(".concat-{}.part.wav", uuid::Uuid::new_v4()));

    let first_reader = hound::WavReader::open(&inputs[0])?;
    let expected_spec = first_reader.spec();
    drop(first_reader);
    if expected_spec.sample_format != hound::SampleFormat::Int
        || expected_spec.bits_per_sample != 16
    {
        return Err(anyhow!(
            "Only 16-bit PCM narration WAVs can be concatenated."
        ));
    }

    let mut writer = hound::WavWriter::create(&temp_output, expected_spec)?;
    for input in inputs {
        let mut reader = hound::WavReader::open(input)
            .with_context(|| format!("Failed to read narration WAV {}", input.display()))?;
        if reader.spec() != expected_spec {
            let _ = fs::remove_file(&temp_output);
            return Err(anyhow!(
                "Narration WAV format mismatch in {}",
                input.display()
            ));
        }
        for sample in reader.samples::<i16>() {
            writer.write_sample(sample?)?;
        }
    }
    writer.finalize()?;
    if !wav_is_valid(&temp_output, Some(expected_spec.sample_rate)) {
        let _ = fs::remove_file(&temp_output);
        return Err(anyhow!("WAV concatenation produced an invalid file."));
    }
    if output.exists() {
        fs::remove_file(output)?;
    }
    fs::rename(temp_output, output)?;
    Ok(())
}

pub async fn ensure_silence_wav(output: &Path, sample_rate: u32, duration_ms: u64) -> Result<()> {
    if wav_is_valid(output, Some(sample_rate)) {
        return Ok(());
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }

    let temp_output = output.with_file_name(format!(
        ".{}.{}.part.wav",
        output
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("silence.wav"),
        uuid::Uuid::new_v4()
    ));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&temp_output, spec)?;
    let sample_count = (u64::from(sample_rate) * duration_ms / 1_000) as usize;
    for _ in 0..sample_count {
        writer.write_sample(0_i16)?;
    }
    writer.finalize()?;
    if !wav_is_valid(&temp_output, Some(sample_rate)) {
        let _ = fs::remove_file(&temp_output);
        return Err(anyhow!("ffmpeg generated an invalid silence WAV."));
    }
    if output.exists() {
        fs::remove_file(output)?;
    }
    fs::rename(temp_output, output)?;
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
    let mut command = runtime_tool_command(ffmpeg);
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

pub fn duration_ms(input: &Path) -> Result<i64> {
    let reader = hound::WavReader::open(input)?;
    let sample_rate = u64::from(reader.spec().sample_rate);
    if sample_rate == 0 {
        return Ok(0);
    }
    Ok(((u64::from(reader.duration()) * 1_000 + sample_rate / 2) / sample_rate) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_wav_bytes(sample_rate: u32) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            writer.write_sample(0_i16).unwrap();
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn atomically_writes_only_valid_wavs() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("chunk.wav");

        write_wav_atomically(&output, &test_wav_bytes(22_050), Some(22_050)).unwrap();
        assert!(wav_is_valid(&output, Some(22_050)));
        assert!(write_wav_atomically(&output, b"not wav", Some(22_050)).is_err());
        assert!(wav_is_valid(&output, Some(22_050)));

        let mut truncated = test_wav_bytes(22_050);
        truncated.pop();
        assert!(write_wav_atomically(&output, &truncated, Some(22_050)).is_err());
        assert!(wav_is_valid(&output, Some(22_050)));
    }

    #[tokio::test]
    async fn creates_and_concatenates_silence_without_ffmpeg() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first.wav");
        let second = temp.path().join("second.wav");
        let combined = temp.path().join("combined.wav");

        ensure_silence_wav(&first, 22_050, 250).await.unwrap();
        ensure_silence_wav(&second, 22_050, 650).await.unwrap();
        concat_wavs(&[first, second], &combined).await.unwrap();

        assert!(wav_is_valid(&combined, Some(22_050)));
        assert_eq!(duration_ms(&combined).unwrap(), 900);
    }
}
