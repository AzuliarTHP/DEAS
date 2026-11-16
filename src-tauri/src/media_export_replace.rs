//! Confirmed replacement of a captured regular file; recovery never clobbers a new arrival.
use super::*;
use std::fs::File;
#[derive(PartialEq, Eq)]
struct Stamp {
    id: (u64, u64),
    length: u64,
    modified: std::time::SystemTime,
}
fn stamp(file: &File) -> Result<Stamp, String> {
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect export destination")?;
    if !meta.is_file() {
        return Err("Export destination must be regular".into());
    }
    #[cfg(windows)]
    let id = crate::win::identity(file)?;
    #[cfg(target_os = "linux")]
    let id = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    };
    #[cfg(not(any(windows, target_os = "linux")))]
    return Err("Unsupported replacement platform".into());
    #[cfg(any(windows, target_os = "linux"))]
    Ok(Stamp {
        id,
        length: meta.len(),
        modified: meta
            .modified()
            .map_err(|_| "Cannot inspect destination timestamp")?,
    })
}
pub(super) struct Replacement {
    file: File,
    stamp: Stamp,
    parent: (u64, u64),
}
pub(super) fn capture(dest: &Path) -> Result<Option<Replacement>, String> {
    match std::fs::symlink_metadata(dest) {
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
            return Err("Replace only a regular media file".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect export destination".into()),
    }
    let parent_path = std::fs::canonicalize(dest.parent().ok_or("Missing export folder")?)
        .map_err(|_| "Export folder unavailable")?;
    let name = dest
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("Invalid export filename")?;
    let parent = Anchor::open(&parent_path)?;
    parent.validate_directory(false)?;
    let file = crate::media::star::open_media(&parent_path.join(name))?;
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect destination")?
        .is_file()
        || !parent.owns_partial(name, &file)
    {
        return Err("Export destination changed".into());
    }
    Ok(Some(Replacement {
        stamp: stamp(&file)?,
        file,
        parent: parent.identity()?,
    }))
}
fn rename(parent: &Anchor, directory: &Path, from: &str, to: &str) -> Result<(), String> {
    parent.validate_directory(false)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let _ = directory;
        let from = std::ffi::CString::new(from).map_err(|_| "Invalid filename")?;
        let to = std::ffi::CString::new(to).map_err(|_| "Invalid filename")?;
        if unsafe {
            libc::renameat2(
                parent.0.as_raw_fd(),
                from.as_ptr(),
                parent.0.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } != 0
        {
            return Err("Cannot capture export destination".into());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        if Anchor::open(directory)?.identity() != parent.identity() {
            return Err("Export folder changed".into());
        }
        crate::win::rename_no_replace(&directory.join(from), &directory.join(to))
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (directory, from, to);
        Err("Confirmed replacement is unsupported on this platform".into())
    }
}
pub(super) fn publish(
    parent: &Anchor,
    directory: &Path,
    temp: &str,
    name: &str,
    old: &Replacement,
    checkpoint: impl FnOnce(),
) -> Result<(), String> {
    let unchanged = |name: &str| {
        parent.owns_partial(name, &old.file) && stamp(&old.file).is_ok_and(|s| s == old.stamp)
    };
    if parent.identity() != Ok(old.parent) || !unchanged(name) {
        return Err("Export destination changed since confirmation; nothing was replaced".into());
    }
    let backup = format!(".deas-replaced-{}", uuid::Uuid::new_v4());
    rename(parent, directory, name, &backup)?;
    let restore = |reason: String| {
        if parent.owns_partial(&backup, &old.file)
            && rename(parent, directory, &backup, name).is_ok()
        {
            reason
        } else {
            format!(
                "{reason}; inspect recovery file at {}",
                directory.join(&backup).display()
            )
        }
    };
    if !unchanged(&backup) {
        return Err(restore(
            "Export destination changed during replacement".into(),
        ));
    }
    checkpoint();
    if let Err(error) = parent.publish(temp, name) {
        return Err(restore(error));
    }
    if !unchanged(&backup) {
        return Err(format!(
            "Export saved; changed inspect recovery file at {}",
            directory.join(&backup).display()
        ));
    }
    parent.remove_partial(&backup);
    Ok(())
}
