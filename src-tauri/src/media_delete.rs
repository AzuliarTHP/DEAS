//! Explicit, confirmed deletion of regular media in the native-owned Input/Output roots.
use crate::downloads::fs::Anchor;
use serde::Serialize;
use std::{
    fs::File,
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
pub struct DeleteReport {
    deleted: Vec<String>,
    failed: Vec<String>,
}

struct Candidate {
    path: PathBuf,
    root: PathBuf,
    root_anchor: Anchor,
    parent: Anchor,
    file: File,
}

fn prepare(roots: &[PathBuf], paths: &[String]) -> Result<Vec<Candidate>, String> {
    if paths.is_empty() || paths.len() > 500 {
        return Err("Select between 1 and 500 media files".into());
    }
    let mut seen = std::collections::HashSet::new();
    paths
        .iter()
        .map(|path| {
            let source = Path::new(path);
            if !seen.insert(source.to_path_buf()) {
                return Err("Duplicate media selection".into());
            }
            let root = roots
                .iter()
                .find(|root| source.starts_with(root))
                .ok_or("Only files in the owned Input/Output folders can be deleted")?;
            // Reuse the physical-media boundary: reject traversal, links/reparse parents,
            // directories, read-only files, project assets and ungrouped sidecars.
            let (_, file) = crate::media::star::preflight(root, source)?;
            Ok(Candidate {
                path: source.to_path_buf(),
                root: root.clone(),
                root_anchor: Anchor::open(root)?,
                parent: Anchor::open(source.parent().ok_or("Missing media parent")?)?,
                file,
            })
        })
        .collect()
}

fn remove(candidate: &Candidate) -> Result<(), String> {
    let name = candidate
        .path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid media filename")?;
    if Anchor::open(&candidate.root)?.identity()? != candidate.root_anchor.identity()?
        || Anchor::open(candidate.path.parent().ok_or("Missing media parent")?)?.identity()?
            != candidate.parent.identity()?
        || !candidate.parent.owns_partial(name, &candidate.file)
    {
        return Err("Media identity changed; nothing was deleted".into());
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let name = std::ffi::CString::new(name).map_err(|_| "Invalid media filename")?;
        if unsafe { libc::unlinkat(candidate.parent.0.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err("Cannot delete media file".into());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
            FILE_FLAG_OPEN_REPARSE_POINT,
        };
        // DELETE | GENERIC_READ; delete by the verified handle rather than a second path lookup.
        let file = std::fs::OpenOptions::new()
            .access_mode(0x0001_0000 | 0x8000_0000)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&candidate.path)
            .map_err(|_| "Cannot open media for deletion; it may be in use")?;
        if crate::win::identity(&file)? != crate::win::identity(&candidate.file)? {
            return Err("Media identity changed; nothing was deleted".into());
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as _,
                FileDispositionInfo,
                std::ptr::addr_of!(disposition).cast(),
                std::mem::size_of_val(&disposition) as u32,
            )
        } == 0
        {
            return Err("Cannot delete media file; it may be in use".into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    Err("Safe media deletion requires Linux or Windows".into())
}

fn delete(roots: &[PathBuf], paths: &[String]) -> Result<DeleteReport, String> {
    // Validate the entire batch before touching any file. Report physical partial
    // failures explicitly; successfully removed files must never be retried blindly.
    let candidates = prepare(roots, paths)?;
    let mut report = DeleteReport {
        deleted: vec![],
        failed: vec![],
    };
    for candidate in candidates {
        let path = candidate.path.to_string_lossy().into_owned();
        if remove(&candidate).is_ok() {
            report.deleted.push(path);
        } else {
            report.failed.push(path);
        }
    }
    Ok(report)
}

fn diagnostic(failed: bool) {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    if failed {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(60)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    crate::logs::push(
        crate::logs::Source::Deas,
        if failed {
            "ERROR: Media operation=delete failed or partially completed; inspect the selection for retry (repeats limited to once per minute)"
        } else {
            "INFO: Media operation=delete completed"
        },
    );
}

#[tauri::command]
pub fn native_media_delete(
    paths: Vec<String>,
    engine: tauri::State<'_, crate::install::Engine>,
    jobs: tauri::State<'_, crate::jobs::Jobs>,
    operations: tauri::State<'_, crate::FolderOperations>,
) -> Result<DeleteReport, String> {
    let result = (|| {
        let _guard = operations.enter()?;
        let roots = [
            crate::media::star::output_root(&engine)?,
            crate::media::intake::input_root(&engine)?,
        ];
        jobs.with_idle_media_edit(|| delete(&roots, &paths))
    })();
    diagnostic(
        result
            .as_ref()
            .map_or(true, |report| !report.failed.is_empty()),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Vec<PathBuf>, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Output");
        std::fs::create_dir(&root).unwrap();
        let paths = ["one.png", "two ü.jpg"]
            .map(|name| {
                let path = root.join(name);
                std::fs::write(&path, b"fixture").unwrap();
                path.to_str().unwrap().to_owned()
            })
            .to_vec();
        (dir, vec![root], paths)
    }
    #[test]
    fn removes_only_confirmed_regular_files_and_keeps_unselected_files() {
        let (_dir, roots, paths) = fixture();
        let report = crate::jobs::Jobs::default()
            .with_idle_media_edit(|| delete(&roots, &paths[..1]))
            .unwrap();
        assert_eq!(report.deleted, paths[..1]);
        assert!(report.failed.is_empty());
        assert!(!Path::new(&paths[0]).exists());
        assert!(Path::new(&paths[1]).exists());
    }
    #[test]
    fn validates_entire_batch_before_deletion() {
        let (_dir, roots, paths) = fixture();
        for invalid in [
            roots[0].to_string_lossy().into_owned(),
            roots[0]
                .join("../outside.png")
                .to_string_lossy()
                .into_owned(),
            "relative.png".into(),
        ] {
            assert!(delete(&roots, &[paths[0].clone(), invalid]).is_err());
            assert!(Path::new(&paths[0]).exists());
        }
        assert!(delete(&roots, &[paths[0].clone(), paths[0].clone()]).is_err());
        assert!(delete(&roots, &[]).is_err());
        assert!(delete(&roots, &vec![paths[0].clone(); 501]).is_err());
    }
    #[test]
    fn refuses_sidecars_and_project_assets_without_deleting_anything() {
        let (_dir, roots, paths) = fixture();
        let sidecar = Path::new(&paths[1]).with_extension("json");
        std::fs::write(&sidecar, b"{}").unwrap();
        assert!(delete(&roots, &paths).is_err());
        assert!(Path::new(&paths[0]).exists());
        assert!(sidecar.exists());
        std::fs::remove_file(sidecar).unwrap();
        std::fs::write(roots[0].join(crate::projects::MANIFEST), b"{}").unwrap();
        assert!(delete(&roots, &paths).is_err());
        assert!(Path::new(&paths[0]).exists());
    }
    #[test]
    fn rejects_namespace_replacement_and_reports_partial_failure() {
        let (_dir, roots, paths) = fixture();
        let candidates = prepare(&roots, &paths).unwrap();
        std::fs::rename(&paths[0], roots[0].join("held.png")).unwrap();
        std::fs::write(&paths[0], b"replacement").unwrap();
        assert!(remove(&candidates[0]).is_err());
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"replacement");
        assert!(remove(&candidates[1]).is_ok());
        drop(candidates);
        assert!(!Path::new(&paths[1]).exists());
    }
    #[test]
    fn command_is_registered_permissioned_and_logs_no_paths() {
        assert!(include_str!("main.rs").contains("deas::native_media_delete"));
        assert!(include_str!("../permissions/media.toml").contains("\"native_media_delete\""));
        diagnostic(true);
        diagnostic(true);
        let logs = crate::logs::native_logs(0);
        let entries: Vec<_> = logs
            .iter()
            .filter(|entry| entry.text.contains("Media operation=delete failed"))
            .collect();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].text.contains(".png"));
    }
}
