//! Windows application self-update (issue #43). A running `.exe` cannot be overwritten or deleted,
//! but it can be renamed inside its folder: download beside it, wait for security scanners to let
//! go, verify again, rename running → `<exe>.old` and download → `<exe>`, verify the installed file,
//! and restart only after the user's OK. `<exe>.old` is removed on the next start.
//!
//! Security-software measures: transient scan locks are retried with backoff, a quarantined or
//! altered download is detected by re-hashing before and after the swap (with rollback), and a
//! folder Controlled Folder Access (or ACLs) blocks is detected before any network work.
//! The swap/rollback core uses std only, so it is unit-tested on every OS.
use super::*;
use std::{
    io,
    path::{Path, PathBuf},
    time::Instant,
};

/// Win32 errors real-time scanners and Controlled Folder Access surface through std::io.
const ACCESS_DENIED: i32 = 5;
const SHARING_VIOLATION: i32 = 32;
const LOCK_VIOLATION: i32 = 33;
const VIRUS_INFECTED: i32 = 225;
const VIRUS_DELETED: i32 = 226;
/// How long a scan may hold the fresh download before the update gives up.
#[cfg(all(windows, target_arch = "x86_64"))]
const SETTLE: Duration = Duration::from_secs(45);
/// Retry budget for each rename while a scanner briefly holds a file.
#[cfg(all(windows, target_arch = "x86_64"))]
const RENAME: Duration = Duration::from_secs(15);

pub(super) const QUARANTINED: &str = "Windows Security (or another antivirus) quarantined or blocked the downloaded DEAS update; an unsigned build is often a false positive. Check Windows Security → Protection history, or download the release manually. The current version is kept";
const LOCKED: &str = "the file stayed locked by another program (usually an antivirus scan); the current version is kept, try again in a minute";

pub(super) struct Paths {
    dir: PathBuf,
    installed: PathBuf,
    new: PathBuf,
    old: PathBuf,
    lock: PathBuf,
}
impl Paths {
    pub(super) fn new(exe: &Path) -> Result<Self, String> {
        let dir = exe
            .parent()
            .ok_or("Executable has no parent")?
            .to_path_buf();
        let name = exe
            .file_name()
            .ok_or("Executable has no name")?
            .to_os_string();
        let with = |suffix: &str| {
            let mut n = name.clone();
            n.push(suffix);
            dir.join(n)
        };
        Ok(Self {
            installed: exe.to_path_buf(),
            new: with(".new"),
            old: with(".old"),
            lock: dir.join(".deas-update.lock"),
            dir,
        })
    }
}

fn transient(e: &io::Error) -> bool {
    matches!(
        e.raw_os_error(),
        Some(ACCESS_DENIED | SHARING_VIOLATION | LOCK_VIOLATION)
    )
}

/// Retries what a real-time scan holding the file makes fail for a moment; anything else fails at once.
fn retry<T>(budget: Duration, mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let deadline = Instant::now() + budget;
    let mut wait = Duration::from_millis(50);
    loop {
        match op() {
            Err(e) if transient(&e) && Instant::now() + wait < deadline => {
                std::thread::sleep(wait);
                wait = (wait * 2).min(Duration::from_secs(1));
            }
            result => return result,
        }
    }
}

fn explain(e: io::Error, what: &str) -> String {
    if matches!(e.raw_os_error(), Some(VIRUS_INFECTED | VIRUS_DELETED))
        || e.kind() == io::ErrorKind::NotFound
    {
        QUARANTINED.into()
    } else if transient(&e) {
        format!("{what}: {LOCKED}")
    } else {
        format!("{what}: {e}")
    }
}

fn hash_file(path: &Path) -> io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

/// Explains a folder DEAS may not write to; `cfa` is the Controlled Folder Access state when readable.
pub(super) fn blocked_folder(dir: &Path, cfa: Option<bool>) -> String {
    let dir = dir.display();
    match cfa {
        Some(true) => format!("Windows Controlled Folder Access (ransomware protection) blocks DEAS from writing to {dir}. Allow deas.exe under Windows Security → Virus & threat protection → Ransomware protection → Allow an app through Controlled folder access, or move DEAS to a folder that is not protected (not Documents or Desktop). The current version is kept"),
        Some(false) => format!("DEAS cannot write to {dir} (folder permissions). Move DEAS to a folder you own, for example %LOCALAPPDATA%\\Programs\\DEAS, or replace it manually. The current version is kept"),
        None => format!("DEAS cannot write to {dir} (folder permissions or Windows Controlled Folder Access). Allow deas.exe under Windows Security → Ransomware protection, or move DEAS to a folder you own, or replace it manually. The current version is kept"),
    }
}

/// Exclusive, self-deleting lock beside the executable. Creating it doubles as the write probe that
/// catches Controlled Folder Access/ACL blocks before any download.
fn lock(p: &Paths) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(0)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_DELETE_ON_CLOSE);
    }
    options.open(&p.lock).map_err(|e| match e.raw_os_error() {
        Some(SHARING_VIOLATION) => "Another application update is active".into(),
        Some(ACCESS_DENIED) => blocked_folder(&p.dir, controlled_folder_access()),
        _ if e.kind() == io::ErrorKind::PermissionDenied => {
            blocked_folder(&p.dir, controlled_folder_access())
        }
        _ => format!("Cannot prepare the update beside DEAS: {e}"),
    })
}

/// Lock, then clear leftovers: a remaining `.old` means the pre-update DEAS may still be running.
pub(super) fn prepare(p: &Paths) -> Result<std::fs::File, String> {
    let lock = lock(p)?;
    if p.old.exists() {
        retry(Duration::from_secs(3), || std::fs::remove_file(&p.old)).map_err(|_| {
            "A previous update is still finishing (the old DEAS may still be running); quit every DEAS window, start DEAS again and retry".to_string()
        })?;
    }
    match retry(Duration::from_secs(3), || std::fs::remove_file(&p.new)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => {
            return Err(explain(e, "Cannot remove a stale update download"))
        }
        _ => {}
    }
    Ok(lock)
}

/// Waits until scanners release the staged download, then proves it is still the verified file.
pub(super) fn settle(p: &Paths, digest: &str, budget: Duration) -> Result<(), String> {
    let got = retry(budget, || hash_file(&p.new))
        .map_err(|e| explain(e, "Cannot re-read the downloaded update"))?;
    if !got.eq_ignore_ascii_case(digest) {
        return Err("The downloaded update changed after verification (security software may have altered it); the current version is kept".into());
    }
    Ok(())
}

/// running → `.old`, download → installed, verify; any failure restores the previous executable.
pub(super) fn swap(p: &Paths, digest: &str, budget: Duration) -> Result<(), String> {
    retry(budget, || std::fs::rename(&p.installed, &p.old))
        .map_err(|e| explain(e, "Cannot move the running DEAS aside"))?;
    if let Err(e) = retry(budget, || std::fs::rename(&p.new, &p.installed)) {
        return Err(rollback(
            p,
            budget,
            explain(e, "Cannot install the downloaded update"),
        ));
    }
    match retry(budget, || hash_file(&p.installed)) {
        Ok(h) if h.eq_ignore_ascii_case(digest) => Ok(()),
        Ok(_) => Err(rollback(
            p,
            budget,
            "The installed update does not match the verified download (security software may have altered it)".into(),
        )),
        Err(e) => Err(rollback(p, budget, explain(e, "Cannot verify the installed update"))),
    }
}

fn rollback(p: &Paths, budget: Duration, cause: String) -> String {
    if p.installed.exists() {
        let _ = retry(budget, || std::fs::rename(&p.installed, &p.new));
    }
    match retry(budget, || std::fs::rename(&p.old, &p.installed)) {
        Ok(()) => {
            let _ = std::fs::remove_file(&p.new);
            format!("{cause}; the previous version was restored")
        }
        Err(_) => format!(
            "{cause}; restoring the previous version failed: quit DEAS and rename {} back to {}",
            p.old.display(),
            p.installed.display()
        ),
    }
}

/// `EnableControlledFolderAccess` (policy first): 1 blocks writes; 0/2 (audit)/3-4 (disk only) do not.
/// A readable Defender key without the value means never enabled (off); unreadable means unknown.
#[cfg(windows)]
pub(super) fn controlled_folder_access() -> Option<bool> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        KEY_WOW64_64KEY, RRF_RT_REG_DWORD, RRF_SUBKEY_WOW6464KEY,
    };
    const VALUE: &str = "EnableControlledFolderAccess";
    const POLICY: &str = r"SOFTWARE\Policies\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access";
    const DEFENDER: &str = r"SOFTWARE\Microsoft\Windows Defender\Windows Defender Exploit Guard\Controlled Folder Access";
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let read = |key: &str| {
        let (key, value) = (wide(key), wide(VALUE));
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == 0).then_some(data == 1)
    };
    let readable = |key: &str| {
        let key = wide(key);
        let mut handle: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                0,
                KEY_READ | KEY_WOW64_64KEY,
                &mut handle,
            )
        };
        if status == 0 {
            unsafe { RegCloseKey(handle) };
        }
        status == 0
    };
    read(POLICY)
        .or_else(|| read(DEFENDER))
        .or_else(|| readable(DEFENDER).then_some(false))
}
#[cfg(not(windows))]
pub(super) fn controlled_folder_access() -> Option<bool> {
    None
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn reject_reparse(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    let m = std::fs::symlink_metadata(path).map_err(|_| "Cannot inspect installed executable")?;
    if !m.is_file() || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(
            "The DEAS executable must be a regular file (not a link) to update itself".into(),
        );
    }
    Ok(())
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub(super) async fn update(auth: &crate::auth::AuthState) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|_| "Cannot locate application executable")?;
    reject_reparse(&exe)?;
    let p = Paths::new(&exe)?;
    let lock = prepare(&p)?;
    log("INFO", "Checking latest stable GitHub release");
    let client = client()?;
    let release = latest(&client, auth).await?;
    let Some(asset) = select_for(&release, env!("CARGO_PKG_VERSION"), WINDOWS)? else {
        return Ok(false);
    };
    let digest = asset
        .digest
        .clone()
        .ok_or("Release asset has no SHA-256 digest")?;
    log(
        "INFO",
        &format!(
            "Downloading verified Windows executable for {}",
            release.tag_name
        ),
    );
    let mut staged = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&p.new)
        .map_err(|e| match e.raw_os_error() {
            Some(ACCESS_DENIED) => blocked_folder(&p.dir, controlled_folder_access()),
            _ => explain(e, "Cannot stage update beside executable"),
        })?;
    let downloaded = match download_as(&client, asset, &mut staged, auth, Format::Pe).await {
        Ok(()) => staged
            .sync_all()
            .map_err(|e| explain(e, "Cannot sync staged update")),
        Err(e) => Err(e),
    };
    drop(staged);
    if let Err(e) = downloaded {
        let _ = std::fs::remove_file(&p.new);
        return Err(e);
    }
    log(
        "INFO",
        "Download verified; waiting for security scanners, then replacing the executable",
    );
    tokio::task::spawn_blocking(move || {
        let _lock = lock;
        let result = settle(&p, &digest, SETTLE).and_then(|()| swap(&p, &digest, RENAME));
        if result.is_err() {
            let _ = std::fs::remove_file(&p.new);
        }
        result
    })
    .await
    .map_err(|_| "Application update worker failed; original retained".to_string())??;
    Ok(true)
}

/// Removes `<exe>.old` left by an update; the old process may still be exiting, so retry briefly.
#[cfg(all(windows, target_arch = "x86_64"))]
pub(super) fn cleanup_previous() {
    let Ok(p) = std::env::current_exe()
        .map_err(drop)
        .and_then(|e| Paths::new(&e).map_err(drop))
    else {
        return;
    };
    if !p.old.exists() {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..60 {
            match std::fs::remove_file(&p.old) {
                Ok(()) => {
                    log("INFO", "Removed the previous executable after the update");
                    return;
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => return,
                Err(_) => std::thread::sleep(Duration::from_millis(500)),
            }
        }
        log(
            "WARN",
            &format!(
                "Cannot remove {} yet; it is retried on the next start",
                p.old.display()
            ),
        );
    });
}

#[cfg(test)]
mod tests {
    include!("app_update_windows_tests.rs");
}
