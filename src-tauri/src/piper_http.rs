use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use std::{
    net::{SocketAddr, TcpListener},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::{
    fs,
    process::{Child, Command},
    time::sleep,
};

use crate::runtime::{ResolvedVoiceAsset, RuntimeAssets};

#[derive(Debug)]
pub struct PiperHttpEngine {
    child: Option<Child>,
    port: Option<u16>,
    voice_id: Option<String>,
    client: Client,
}

impl PiperHttpEngine {
    pub fn new() -> Self {
        Self {
            child: None,
            port: None,
            voice_id: None,
            client: Client::new(),
        }
    }

    pub async fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.port = None;
        self.voice_id = None;
    }

    pub async fn ensure_started(
        &mut self,
        assets: &RuntimeAssets,
        voice: &ResolvedVoiceAsset,
    ) -> Result<()> {
        if self.voice_id.as_deref() == Some(&voice.id) && self.is_healthy().await {
            return Ok(());
        }

        self.stop().await;
        let port = allocate_loopback_port()?;
        let mut command = Command::new(&assets.python_exe);
        command
            .arg("-m")
            .arg(&assets.piper_server_entrypoint)
            .arg("--model")
            .arg(&voice.model_path)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }

        let child = command.spawn().with_context(|| {
            format!(
                "Failed to start Piper HTTP server with {}",
                assets.python_exe.display()
            )
        })?;

        self.child = Some(child);
        self.port = Some(port);
        self.voice_id = Some(voice.id.clone());
        self.wait_until_healthy().await
    }

    pub async fn synthesize_to_file(&mut self, text: &str, output_path: &Path) -> Result<()> {
        let port = self
            .port
            .ok_or_else(|| anyhow!("Piper HTTP server is not running."))?;
        let url = format!("http://127.0.0.1:{port}/");
        let response = self
            .client
            .post(url)
            .json(&serde_json::json!({ "text": text }))
            .send()
            .await
            .context("Failed to call Piper HTTP synthesis endpoint")?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "Piper HTTP synthesis failed with {}",
                response.status()
            ));
        }
        let bytes = response.bytes().await?;
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(output_path, bytes).await?;
        Ok(())
    }

    async fn wait_until_healthy(&self) -> Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while tokio::time::Instant::now() < deadline {
            if self.is_healthy().await {
                return Ok(());
            }
            sleep(Duration::from_millis(250)).await;
        }
        Err(anyhow!("Timed out waiting for Piper HTTP /voices."))
    }

    async fn is_healthy(&self) -> bool {
        let Some(port) = self.port else {
            return false;
        };
        let url = format!("http://127.0.0.1:{port}/voices");
        self.client
            .get(url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    }
}

pub fn allocate_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_loopback_port() {
        let port = allocate_loopback_port().unwrap();
        assert!(port > 0);
    }
}
