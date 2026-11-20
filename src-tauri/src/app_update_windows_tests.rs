use super::*;

fn scratch(installed: &[u8], new: Option<&[u8]>) -> (tempfile::TempDir, Paths) {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("deas.exe");
    std::fs::write(&exe, installed).unwrap();
    let p = Paths::new(&exe).unwrap();
    if let Some(bytes) = new {
        std::fs::write(&p.new, bytes).unwrap();
    }
    (dir, p)
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[test]
fn swap_moves_the_running_executable_aside_and_verifies_the_installed_file() {
    let (_dir, p) = scratch(b"old build", Some(b"new build"));
    settle(&p, &digest(b"new build"), Duration::from_secs(1)).unwrap();
    swap(&p, &digest(b"new build"), Duration::from_secs(1)).unwrap();
    assert_eq!(std::fs::read(&p.installed).unwrap(), b"new build");
    assert_eq!(std::fs::read(&p.old).unwrap(), b"old build");
    assert!(!p.new.exists());
}

#[test]
fn swap_restores_the_previous_executable_when_the_download_is_missing_or_altered() {
    let (_dir, p) = scratch(b"old build", None);
    let error = swap(&p, &digest(b"new build"), Duration::from_millis(200)).unwrap_err();
    assert!(
        error.contains("quarantined") && error.contains("restored"),
        "{error}"
    );
    assert_eq!(std::fs::read(&p.installed).unwrap(), b"old build");
    assert!(!p.old.exists());

    let (_dir, p) = scratch(b"old build", Some(b"tampered"));
    let error = swap(&p, &digest(b"new build"), Duration::from_millis(200)).unwrap_err();
    assert!(
        error.contains("does not match") && error.contains("restored"),
        "{error}"
    );
    assert_eq!(std::fs::read(&p.installed).unwrap(), b"old build");
    assert!(!p.old.exists() && !p.new.exists());
}

#[test]
fn settle_detects_quarantined_and_altered_downloads() {
    let (_dir, p) = scratch(b"old build", None);
    assert_eq!(
        settle(&p, &digest(b"new build"), Duration::from_millis(100)).unwrap_err(),
        QUARANTINED
    );
    std::fs::write(&p.new, b"altered").unwrap();
    assert!(
        settle(&p, &digest(b"new build"), Duration::from_millis(100))
            .unwrap_err()
            .contains("changed after verification")
    );
}

#[test]
fn retry_waits_out_scan_locks_but_not_permanent_errors() {
    let mut calls = 0;
    let value = retry(Duration::from_secs(2), || {
        calls += 1;
        if calls < 3 {
            Err(io::Error::from_raw_os_error(SHARING_VIOLATION))
        } else {
            Ok(7)
        }
    })
    .unwrap();
    assert_eq!((value, calls), (7, 3));
    let mut calls = 0;
    let _ = retry(Duration::from_secs(2), || {
        calls += 1;
        Err::<(), _>(io::Error::from(io::ErrorKind::NotFound))
    });
    assert_eq!(calls, 1);
    let started = Instant::now();
    let error = retry(Duration::from_millis(300), || {
        Err::<(), _>(io::Error::from_raw_os_error(LOCK_VIOLATION))
    })
    .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(explain(error, "Rename").contains("antivirus"));
    assert_eq!(
        explain(io::Error::from_raw_os_error(VIRUS_INFECTED), "x"),
        QUARANTINED
    );
}

#[test]
fn prepare_clears_stale_downloads_and_previous_executables() {
    let (_dir, p) = scratch(b"build", Some(b"stale"));
    std::fs::write(&p.old, b"previous").unwrap();
    let lock = prepare(&p).unwrap();
    assert!(!p.new.exists() && !p.old.exists());
    #[cfg(windows)]
    assert_eq!(
        prepare(&p).unwrap_err(),
        "Another application update is active"
    );
    drop(lock);
}

#[test]
fn blocked_folder_names_controlled_folder_access_and_a_way_out() {
    let dir = Path::new("C:/Users/me/Documents/DEAS");
    assert!(blocked_folder(dir, Some(true)).contains("Controlled Folder Access"));
    assert!(blocked_folder(dir, Some(true)).contains("Allow an app"));
    assert!(!blocked_folder(dir, Some(false)).contains("Controlled Folder Access"));
    assert!(blocked_folder(dir, None).contains("Controlled Folder Access"));
    for cfa in [Some(true), Some(false), None] {
        assert!(blocked_folder(dir, cfa).contains("current version is kept"));
    }
}

/// Real Windows: a running copy is renamed aside while a simulated scanner holds the download
/// exclusively for 2 s; prints the Controlled Folder Access state and the denied-folder diagnosis.
#[cfg(windows)]
#[test]
#[ignore = "Windows host acceptance: spawns a scratch process"]
fn windows_live_swap_of_a_running_executable_under_a_scan_lock() {
    use std::os::windows::fs::OpenOptionsExt;
    if std::env::var_os("DEAS_SWAP_SLEEPER").is_some() {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let me = std::env::current_exe().unwrap();
    let exe = dir.path().join("deas.exe");
    std::fs::copy(&me, &exe).unwrap();
    let mut child = std::process::Command::new(&exe)
        .args([
            "--ignored",
            "--exact",
            "app_update::windows::tests::windows_live_swap_of_a_running_executable_under_a_scan_lock",
        ])
        .env("DEAS_SWAP_SLEEPER", "1")
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        std::fs::remove_file(&exe).is_err(),
        "running exe must be undeletable"
    );
    let p = Paths::new(&exe).unwrap();
    let lock = prepare(&p).unwrap();
    let mut replacement = std::fs::read(&me).unwrap();
    replacement.extend_from_slice(b"DEAS swap probe");
    std::fs::write(&p.new, &replacement).unwrap();
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&p.new)
        .unwrap();
    let scanner = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        drop(held);
    });
    let started = Instant::now();
    settle(&p, &digest(&replacement), Duration::from_secs(10)).unwrap();
    let settled = started.elapsed();
    swap(&p, &digest(&replacement), Duration::from_secs(10)).unwrap();
    scanner.join().unwrap();
    assert_eq!(std::fs::read(&p.installed).unwrap(), replacement);
    assert!(
        child.try_wait().unwrap().is_none(),
        "old process keeps running"
    );
    assert!(
        std::fs::remove_file(&p.old).is_err(),
        ".old stays locked while running"
    );
    child.kill().unwrap();
    child.wait().unwrap();
    retry(Duration::from_secs(5), || std::fs::remove_file(&p.old)).unwrap();
    drop(lock);
    assert!(!p.lock.exists(), "lock deletes itself on close");

    // An ACL-denied folder is diagnosed before any download.
    let denied = dir.path().join("denied");
    std::fs::create_dir(&denied).unwrap();
    let user = std::env::var("USERNAME").unwrap();
    let icacls = |args: &[&str]| {
        assert!(std::process::Command::new("icacls")
            .arg(&denied)
            .args(args)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap()
            .success())
    };
    icacls(&["/deny", &format!("{user}:(WD,AD)")]);
    let blocked = prepare(&Paths::new(&denied.join("deas.exe")).unwrap()).unwrap_err();
    icacls(&["/remove:d", &user]);
    assert!(
        blocked.contains("cannot write") || blocked.contains("blocks DEAS"),
        "{blocked}"
    );
    println!(
        "LIVE_SWAP {}",
        serde_json::json!({
            "settled_ms": settled.as_millis(),
            "controlled_folder_access": controlled_folder_access(),
            "denied_folder": blocked,
        })
    );
}
