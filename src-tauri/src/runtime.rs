use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

use crate::models::VoiceInfo;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub target: String,
    pub python_version: String,
    pub python_build_standalone_version: String,
    pub piper_version: String,
    pub runtime_sha256: String,
    pub python_exe: String,
    pub piper_server_entrypoint: String,
    pub ffmpeg_exe: String,
    pub ffprobe_exe: String,
    pub voices: Vec<VoiceAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAsset {
    pub id: String,
    pub name: String,
    pub locale: String,
    pub quality: String,
    pub model_path: String,
    pub config_path: String,
    pub sample_rate: Option<u32>,
    pub source_url: Option<String>,
    pub model_card_url: Option<String>,
    pub license_id: Option<String>,
    pub license_name: Option<String>,
    pub license_url: Option<String>,
    pub usage_note: Option<String>,
    pub attribution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAssets {
    pub root_dir: PathBuf,
    pub manifest_path: PathBuf,
    pub target: String,
    pub python_version: String,
    pub piper_version: String,
    pub python_exe: PathBuf,
    pub piper_server_entrypoint: String,
    pub ffmpeg_exe: PathBuf,
    pub ffprobe_exe: PathBuf,
    pub voices: Vec<ResolvedVoiceAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVoiceAsset {
    pub id: String,
    pub name: String,
    pub locale: String,
    pub quality: String,
    pub model_path: PathBuf,
    pub config_path: PathBuf,
    pub sample_rate: Option<u32>,
    pub source_url: Option<String>,
    pub model_card_url: Option<String>,
    pub license_id: Option<String>,
    pub license_name: Option<String>,
    pub license_url: Option<String>,
    pub usage_note: Option<String>,
    pub attribution: Option<String>,
}

impl RuntimeAssets {
    pub fn default_voice_id(&self) -> Option<String> {
        self.voices.first().map(|voice| voice.id.clone())
    }

    pub fn voice(&self, id: &str) -> Option<ResolvedVoiceAsset> {
        self.voices.iter().find(|voice| voice.id == id).cloned()
    }

    pub fn voice_infos(&self) -> Vec<VoiceInfo> {
        self.voices
            .iter()
            .map(|voice| VoiceInfo {
                id: voice.id.clone(),
                name: voice.name.clone(),
                model_path: Some(voice.model_path.to_string_lossy().to_string()),
                locale: Some(voice.locale.clone()),
                speaker: voice.id.split('-').nth(1).map(|value| value.to_string()),
                quality: Some(voice.quality.clone()),
                source_url: voice.source_url.clone(),
                model_card_url: voice.model_card_url.clone(),
                license_id: voice.license_id.clone(),
                license_name: voice.license_name.clone(),
                license_url: voice.license_url.clone(),
                usage_note: voice.usage_note.clone(),
                attribution: voice.attribution.clone(),
            })
            .collect()
    }
}

fn target_key_for(os: &str, arch: &str) -> String {
    let os = match os {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

fn target_key() -> String {
    target_key_for(env::consts::OS, env::consts::ARCH)
}

fn candidate_runtime_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("runtime").join(target_key()));
        dirs.push(resource_dir.join("runtime"));
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(value) = env::var("AUDIOBOOK_RUNTIME_DIR") {
            dirs.push(PathBuf::from(value));
        }
        dirs.push(PathBuf::from("runtime").join("dist").join(target_key()));
    }
    dirs
}

pub fn load_runtime_assets(app: &AppHandle) -> Result<RuntimeAssets> {
    let mut tried = Vec::new();
    for dir in candidate_runtime_dirs(app) {
        let manifest_path = dir.join("runtime-manifest.json");
        tried.push(manifest_path.display().to_string());
        if manifest_path.is_file() {
            return load_manifest(&dir, &manifest_path);
        }
    }
    Err(anyhow!(
        "Runtime manifest not found. Tried: {}",
        tried.join(", ")
    ))
}

pub fn load_manifest(root_dir: &Path, manifest_path: &Path) -> Result<RuntimeAssets> {
    let raw = fs::read_to_string(manifest_path)
        .with_context(|| format!("Failed to read {}", manifest_path.display()))?;
    let manifest: RuntimeManifest = serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse {}", manifest_path.display()))?;

    let assets = RuntimeAssets {
        root_dir: root_dir.to_path_buf(),
        manifest_path: manifest_path.to_path_buf(),
        target: manifest.target.clone(),
        python_version: manifest.python_version.clone(),
        piper_version: manifest.piper_version.clone(),
        python_exe: root_dir.join(&manifest.python_exe),
        piper_server_entrypoint: manifest.piper_server_entrypoint.clone(),
        ffmpeg_exe: root_dir.join(&manifest.ffmpeg_exe),
        ffprobe_exe: root_dir.join(&manifest.ffprobe_exe),
        voices: manifest
            .voices
            .iter()
            .map(|voice| ResolvedVoiceAsset {
                id: voice.id.clone(),
                name: voice.name.clone(),
                locale: voice.locale.clone(),
                quality: voice.quality.clone(),
                model_path: root_dir.join(&voice.model_path),
                config_path: root_dir.join(&voice.config_path),
                sample_rate: voice.sample_rate,
                source_url: voice.source_url.clone(),
                model_card_url: voice.model_card_url.clone(),
                license_id: voice.license_id.clone(),
                license_name: voice.license_name.clone(),
                license_url: voice.license_url.clone(),
                usage_note: voice.usage_note.clone(),
                attribution: voice.attribution.clone(),
            })
            .collect(),
    };
    validate_assets(&assets)?;
    Ok(assets)
}

fn validate_assets(assets: &RuntimeAssets) -> Result<()> {
    let required = [&assets.python_exe, &assets.ffmpeg_exe, &assets.ffprobe_exe];
    for path in required {
        if !path.is_file() {
            return Err(anyhow!("Runtime asset missing: {}", path.display()));
        }
    }
    for voice in &assets.voices {
        if !voice.model_path.is_file() {
            return Err(anyhow!(
                "Voice model missing: {}",
                voice.model_path.display()
            ));
        }
        if !voice.config_path.is_file() {
            return Err(anyhow!(
                "Voice config missing: {}",
                voice.config_path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_runtime_manifest() {
        let manifest = r#"{
      "target":"linux-x64",
      "pythonVersion":"3.12.11",
      "pythonBuildStandaloneVersion":"20250611",
      "piperVersion":"1.4.2",
      "runtimeSha256":"abc",
      "pythonExe":"python/bin/python3",
      "piperServerEntrypoint":"piper.http_server",
      "ffmpegExe":"ffmpeg/bin/ffmpeg",
      "ffprobeExe":"ffmpeg/bin/ffprobe",
      "voices":[{"id":"es_ES-carlfm-high","name":"Carlfm","locale":"es_ES","quality":"high","modelPath":"voices/a.onnx","configPath":"voices/a.onnx.json","sampleRate":22050}]
    }"#;
        let parsed: RuntimeManifest = serde_json::from_str(manifest).unwrap();
        assert_eq!(parsed.piper_version, "1.4.2");
        assert_eq!(parsed.voices[0].id, "es_ES-carlfm-high");
    }

    #[test]
    fn normalizes_packaged_target_keys() {
        assert_eq!(target_key_for("linux", "x86_64"), "linux-x64");
        assert_eq!(target_key_for("macos", "aarch64"), "darwin-arm64");
        assert_eq!(target_key_for("windows", "x86_64"), "win32-x64");
    }
}
