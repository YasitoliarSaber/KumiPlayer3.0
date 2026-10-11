use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct WindowPreferences {
    pub minimize_to_tray: bool,
    pub close_to_tray: bool,
}

pub struct WindowPreferencesStore {
    path: PathBuf,
    preferences: Mutex<WindowPreferences>,
    save_lock: Mutex<()>,
}

impl WindowPreferencesStore {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        let preferences = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "窗口设置文件无法读取，请检查文件内容".to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                WindowPreferences::default()
            }
            Err(_) => return Err("无法读取窗口设置文件".to_string()),
        };
        Ok(Self {
            path,
            preferences: Mutex::new(preferences),
            save_lock: Mutex::new(()),
        })
    }

    pub fn get(&self) -> Result<WindowPreferences, String> {
        self.preferences
            .lock()
            .map(|value| *value)
            .map_err(|_| "窗口设置状态已损坏".to_string())
    }

    pub fn save(&self, preferences: WindowPreferences) -> Result<WindowPreferences, String> {
        self.save_with(preferences, || self.persist(preferences))
    }

    pub(crate) fn save_with(
        &self,
        preferences: WindowPreferences,
        persist: impl FnOnce() -> Result<(), String>,
    ) -> Result<WindowPreferences, String> {
        // 磁盘事务串行化，但不能持有窗口事件读取的内存锁等待磁盘。
        let _serial = self
            .save_lock
            .lock()
            .map_err(|_| "窗口设置状态已损坏".to_string())?;
        persist()?;
        *self
            .preferences
            .lock()
            .map_err(|_| "窗口设置状态已损坏".to_string())? = preferences;
        Ok(preferences)
    }

    fn persist(&self, preferences: WindowPreferences) -> Result<(), String> {
        let parent = self.path.parent().ok_or("窗口设置目录无效")?;
        std::fs::create_dir_all(parent).map_err(|_| "无法创建窗口设置目录".to_string())?;
        let bytes = serde_json::to_vec_pretty(&preferences).map_err(|error| error.to_string())?;
        let temporary = self.path.with_extension("json.tmp");
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &self.path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temporary);
            return Err("窗口设置未能保存".to_string());
        }
        Ok(())
    }
}
