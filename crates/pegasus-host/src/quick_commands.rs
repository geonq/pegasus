//! Saved terminal commands per project, kept in one JSON file next to the host's other state
//! (`<agent dir>/pegasus-quick-commands.json`). Every change is written to a temp file and renamed
//! over the old one, so a crash mid-write never loses the saved list.
use pegasus_core::protocol::{ErrorCode, HostError, QuickCommand, QuickCommandSaveParams};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_NAME: usize = 80;
const MAX_COMMAND: usize = 4096;
const MAX_PER_PROJECT: usize = 50;

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    projects: BTreeMap<String, Vec<QuickCommand>>,
}

pub struct QuickCommands {
    path: PathBuf,
    /// Serialises read-modify-write so two windows saving at once cannot drop a command.
    lock: Mutex<()>,
}

fn bad(msg: impl Into<String>) -> HostError {
    HostError::new(ErrorCode::BadParams, msg)
}

fn not_found(id: &str) -> HostError {
    HostError::new(ErrorCode::NotFound, format!("no quick command {id}"))
}

impl QuickCommands {
    pub fn new(path: PathBuf) -> Self {
        QuickCommands { path, lock: Mutex::new(()) }
    }

    pub fn list(&self, project: &str) -> Result<Vec<QuickCommand>, HostError> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        Ok(self.read()?.projects.remove(project).unwrap_or_default())
    }

    pub fn get(&self, project: &str, id: &str) -> Result<QuickCommand, HostError> {
        self.list(project)?.into_iter().find(|c| c.id == id).ok_or_else(|| not_found(id))
    }

    pub fn save(&self, p: QuickCommandSaveParams) -> Result<Vec<QuickCommand>, HostError> {
        let (name, command) = (p.name.trim(), p.command.trim_end());
        if p.project.is_empty() {
            return Err(bad("project is required"));
        }
        if name.is_empty() || name.chars().count() > MAX_NAME {
            return Err(bad(format!("name must be 1 to {MAX_NAME} characters")));
        }
        if command.trim().is_empty() || command.len() > MAX_COMMAND {
            return Err(bad(format!("command must be 1 to {MAX_COMMAND} bytes")));
        }
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut saved = self.read()?;
        let list = saved.projects.entry(p.project).or_default();
        match p.id {
            Some(id) => {
                let entry = list.iter_mut().find(|c| c.id == id).ok_or_else(|| not_found(&id))?;
                entry.name = name.into();
                entry.command = command.into();
            }
            None if list.len() >= MAX_PER_PROJECT => {
                return Err(bad(format!("a project can keep up to {MAX_PER_PROJECT} quick commands")));
            }
            None => list.push(QuickCommand { id: new_id(), name: name.into(), command: command.into() }),
        }
        let out = list.clone();
        self.write(&saved)?;
        Ok(out)
    }

    pub fn delete(&self, project: &str, id: &str) -> Result<Vec<QuickCommand>, HostError> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut saved = self.read()?;
        let mut list = saved.projects.remove(project).unwrap_or_default();
        list.retain(|c| c.id != id);
        if !list.is_empty() {
            saved.projects.insert(project.to_string(), list.clone());
        }
        self.write(&saved)?;
        Ok(list)
    }

    fn read(&self) -> Result<Saved, HostError> {
        match std::fs::read(&self.path) {
            // Refuse to overwrite a file we cannot read: the owner's commands stay on disk.
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                HostError::new(ErrorCode::Io, format!("{} is not valid: {e}", self.path.display()))
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Saved::default()),
            Err(e) => Err(HostError::new(ErrorCode::Io, e.to_string())),
        }
    }

    fn write(&self, saved: &Saved) -> Result<(), HostError> {
        let body = serde_json::to_vec_pretty(saved).map_err(|e| HostError::new(ErrorCode::Internal, e.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, body)
            .and_then(|_| std::fs::rename(&tmp, &self.path))
            .map_err(|e| HostError::new(ErrorCode::Io, e.to_string()))
    }
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    format!("qc-{:x}-{}", crate::host::now_ms() as u64, N.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (QuickCommands, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pegasus-qc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pegasus-quick-commands.json");
        (QuickCommands::new(path.clone()), path)
    }

    fn save(id: Option<&str>, name: &str, command: &str) -> QuickCommandSaveParams {
        QuickCommandSaveParams { project: "D:/p".into(), id: id.map(Into::into), name: name.into(), command: command.into() }
    }

    #[test]
    fn add_edit_delete_persist_per_project() {
        let (s, path) = store("crud");
        assert!(s.list("D:/p").unwrap().is_empty());
        let added = s.save(save(None, " Test ", "cargo test\n")).unwrap();
        assert_eq!(added.len(), 1);
        assert_eq!((added[0].name.as_str(), added[0].command.as_str()), ("Test", "cargo test"));
        let id = added[0].id.clone();
        s.save(save(Some(&id), "Build", "cargo build")).unwrap();
        // A fresh store reads the same file: the change survived.
        let reread = QuickCommands::new(path);
        assert_eq!(reread.get("D:/p", &id).unwrap().command, "cargo build");
        assert!(reread.list("D:/other").unwrap().is_empty());
        assert!(s.delete("D:/p", &id).unwrap().is_empty());
        assert!(reread.list("D:/p").unwrap().is_empty());
    }

    #[test]
    fn rejects_bad_input_and_unknown_ids() {
        let (s, _) = store("bad");
        assert_eq!(s.save(save(None, "  ", "ls")).unwrap_err().code, ErrorCode::BadParams);
        assert_eq!(s.save(save(None, "x", " \n")).unwrap_err().code, ErrorCode::BadParams);
        assert_eq!(s.save(save(Some("nope"), "x", "ls")).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(s.get("D:/p", "nope").unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn a_corrupt_file_is_never_overwritten() {
        let (s, path) = store("corrupt");
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(s.save(save(None, "x", "ls")).unwrap_err().code, ErrorCode::Io);
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
    }
}
