use super::*;
use std::fs;
use std::io::Cursor;

fn dirs() -> (tempfile::TempDir, tempfile::TempDir) {
    (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap())
}

fn png_chunks(bytes: &[u8]) -> Vec<String> {
    let mut at = 8;
    let mut names = Vec::new();
    while at < bytes.len() {
        let len = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        names.push(String::from_utf8_lossy(&bytes[at + 4..at + 8]).into_owned());
        at += 12 + len;
    }
    names
}

fn png_pixels(bytes: &[u8]) -> Vec<u8> {
    let mut reader = png::Decoder::new(bytes).read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).unwrap();
    buf.truncate(info.buffer_size());
    buf
}

fn tagged_png() -> Vec<u8> {
    let pixels: Vec<u8> = (0..4 * 4 * 4).map(|i| (i * 7) as u8).collect();
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, 4, 4);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .add_text_chunk("prompt".into(), "{\"1\":{}}".into())
        .unwrap();
    encoder
        .add_ztxt_chunk("workflow".into(), "{\"nodes\":[]}".into())
        .unwrap();
    encoder
        .add_itxt_chunk("parameters".into(), "a cat, Steps: 20".into())
        .unwrap();
    let mut writer = encoder.write_header().unwrap();
    let mut icc = b"sRGB\0\0".to_vec();
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(&[7u8; 64]).unwrap();
    icc.extend(z.finish().unwrap());
    writer
        .write_chunk(png::chunk::ChunkType(*b"iCCP"), &icc)
        .unwrap();
    writer
        .write_chunk(png::chunk::ChunkType(*b"eXIf"), b"MM\0*\0\0\0\x08")
        .unwrap();
    writer.write_image_data(&pixels).unwrap();
    writer.finish().unwrap();
    bytes
}

#[test]
fn png_drops_text_and_exif_keeps_icc_and_pixels() {
    let (root, out) = dirs();
    let source = root.path().join("raw").join("shot.png");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    let original = tagged_png();
    fs::write(&source, &original).unwrap();
    let before = crate::media_metadata::read_metadata(&source).unwrap();
    assert!(before.iter().any(|(k, _)| k == "prompt"));

    let dest = out.path().join("shot-clean.png");
    let done = export_clean(root.path(), &source, Some(&dest))
        .unwrap()
        .unwrap();
    let clean = fs::read(&dest).unwrap();
    assert_eq!(done.size, clean.len() as u64);
    let names = png_chunks(&clean);
    assert!(names.contains(&"iCCP".to_string()), "{names:?}");
    for gone in ["tEXt", "zTXt", "iTXt", "eXIf"] {
        assert!(!names.iter().any(|n| n == gone), "{names:?}");
    }
    assert_eq!(png_pixels(&clean), png_pixels(&original));
    let after = crate::media_metadata::read_metadata(&dest).unwrap();
    assert!(
        !after
            .iter()
            .any(|(k, _)| matches!(k.as_str(), "prompt" | "workflow" | "parameters")),
        "{after:?}"
    );
    assert_eq!(fs::read(&source).unwrap(), original, "source untouched");
    assert_eq!(fs::read_dir(out.path()).unwrap().count(), 1, "no temp left");
}

#[test]
fn jpeg_drops_exif_xmp_iptc_and_comments_only() {
    let seg = |marker: u8, body: &[u8]| {
        let mut s = vec![0xFF, marker];
        s.extend(((body.len() + 2) as u16).to_be_bytes());
        s.extend_from_slice(body);
        s
    };
    let app0 = seg(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
    let exif = seg(0xE1, b"Exif\0\0prompt");
    let xmp = seg(0xE1, b"http://ns.adobe.com/xap/1.0/\0<x/>");
    let icc = seg(0xE2, b"ICC_PROFILE\0\x01\x01data");
    let iptc = seg(0xED, b"Photoshop 3.0\0");
    let com = seg(0xFE, b"workflow");
    let dqt = seg(0xDB, &[0; 65]);
    let scan = [
        &seg(0xDA, &[1, 1, 0, 0, 63, 0])[..],
        &[0x12, 0xFF, 0, 0x34],
        &[0xFF, 0xD9],
    ]
    .concat();
    let source_bytes = [
        &[0xFF, 0xD8][..],
        &app0,
        &exif,
        &xmp,
        &icc,
        &iptc,
        &com,
        &dqt,
        &scan,
    ]
    .concat();
    let expected = [&[0xFF, 0xD8][..], &app0, &icc, &dqt, &scan].concat();
    let (root, out) = dirs();
    let source = root.path().join("a.JPG");
    fs::write(&source, &source_bytes).unwrap();
    let dest = out.path().join("a-clean.jpg");
    export_clean(root.path(), &source, Some(&dest)).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), expected);
    assert!(
        strip_jpeg(&source_bytes[..20]).is_err(),
        "truncated refuses"
    );
}

#[test]
fn webp_drops_exif_xmp_clears_flags_and_keeps_pixels() {
    let pixels: Vec<u8> = (0..8 * 8 * 4).map(|i| (i * 3) as u8).collect();
    let mut original = Vec::new();
    let mut encoder = image_webp::WebPEncoder::new(&mut original);
    encoder.set_icc_profile(vec![1; 16]);
    encoder.set_exif_metadata(b"Exif prompt".to_vec());
    encoder.set_xmp_metadata(b"<x:xmpmeta/>".to_vec());
    encoder
        .encode(&pixels, 8, 8, image_webp::ColorType::Rgba8)
        .unwrap();
    assert_eq!(original[20] & 0x0C, 0x0C, "fixture carries EXIF/XMP flags");

    let (root, out) = dirs();
    let source = root.path().join("v.webp");
    fs::write(&source, &original).unwrap();
    let dest = out.path().join("v-clean.webp");
    export_clean(root.path(), &source, Some(&dest)).unwrap();
    let clean = fs::read(&dest).unwrap();
    assert_eq!(
        u32::from_le_bytes(clean[4..8].try_into().unwrap()) as usize,
        clean.len() - 8
    );
    assert_eq!(&clean[12..16], b"VP8X");
    assert_eq!(clean[20] & 0x0C, 0, "EXIF/XMP flags cleared");
    assert_eq!(clean[20] & 0x20, 0x20, "ICC flag kept");
    let decode = |bytes: &[u8]| {
        let mut d = image_webp::WebPDecoder::new(Cursor::new(bytes)).unwrap();
        let mut buf = vec![0; d.output_buffer_size().unwrap()];
        d.read_image(&mut buf).unwrap();
        (
            buf,
            d.icc_profile().unwrap(),
            d.exif_metadata().unwrap(),
            d.xmp_metadata().unwrap(),
        )
    };
    let (a, _, _, _) = decode(&original);
    let (b, icc, exif, xmp) = decode(&clean);
    assert_eq!(a, b);
    assert_eq!(icc, Some(vec![1; 16]));
    assert_eq!((exif, xmp), (None, None));
}

#[test]
fn refuses_outside_root_symlinks_source_and_existing_destinations() {
    let (root, out) = dirs();
    let outside = out.path().join("x.png");
    fs::write(&outside, tagged_png()).unwrap();
    let dest = out.path().join("y.png");
    assert!(export_clean(root.path(), &outside, Some(&dest)).is_err());
    assert!(!dest.exists());

    let inside = root.path().join("in.png");
    fs::write(&inside, tagged_png()).unwrap();
    #[cfg(unix)]
    {
        let link = root.path().join("link.png");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(export_clean(root.path(), &link, Some(&dest)).is_err());
    }
    let traversal = root.path().join("sub/../in.png");
    assert!(export_clean(root.path(), &traversal, Some(&dest)).is_err());
    assert!(export_clean(root.path(), root.path(), Some(&dest)).is_err());

    let error = export_clean(root.path(), &inside, Some(&inside)).unwrap_err();
    assert!(error.contains("source"), "{error}");
    fs::write(&dest, b"keep").unwrap();
    assert!(export_clean(root.path(), &inside, Some(&dest)).is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"keep", "never overwritten");
    let wrong = out.path().join("z.jpg");
    assert!(export_clean(root.path(), &inside, Some(&wrong)).is_err());
    assert!(!wrong.exists());
}

#[test]
fn cancel_writes_nothing() {
    let (root, out) = dirs();
    let source = root.path().join("a.png");
    fs::write(&source, tagged_png()).unwrap();
    assert_eq!(export_clean(root.path(), &source, None).unwrap(), None);
    assert_eq!(fs::read_dir(out.path()).unwrap().count(), 0);
}

#[test]
fn command_is_registered_and_permitted() {
    assert!(include_str!("../permissions/media.toml").contains("\"native_media_export_clean\""));
    assert!(include_str!("main.rs").contains("deas::native_media_export_clean,"));
}

#[test]
fn real_ffmpeg_remux_drops_tags_and_keeps_packets() {
    if Command::new("ffmpeg").arg("-version").output().is_err() {
        eprintln!("ffmpeg unavailable; clean-export remux fixture skipped");
        return;
    }
    let (root, out) = dirs();
    let source = root.path().join("clip.mp4");
    assert!(Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x64:rate=10:duration=1"
        ])
        .args(["-f", "lavfi", "-i", "sine=duration=1", "-shortest"])
        .args([
            "-metadata",
            "comment=prompt",
            "-metadata:s:v:0",
            "title=workflow"
        ])
        .arg(&source)
        .status()
        .unwrap()
        .success());
    let tags = |path: &Path| {
        let o = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format_tags:stream_tags",
                "-of",
                "json",
            ])
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8(o.stdout).unwrap()
    };
    let frames = |path: &Path| {
        let o = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(path)
            .args(["-map", "0", "-c", "copy", "-f", "framemd5", "-"])
            .output()
            .unwrap();
        String::from_utf8(o.stdout)
            .unwrap()
            .lines()
            .filter(|l| !l.starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert!(tags(&source).contains("prompt"));
    let dest = out.path().join("clip-clean.mp4");
    let done = export_clean(root.path(), &source, Some(&dest))
        .unwrap()
        .unwrap();
    assert_eq!(done.size, fs::metadata(&dest).unwrap().len());
    let clean = tags(&dest);
    for gone in ["prompt", "workflow", "encoder", "comment"] {
        assert!(!clean.contains(gone), "{clean}");
    }
    assert!(!frames(&source).is_empty());
    assert_eq!(frames(&source), frames(&dest));
    assert_eq!(fs::read_dir(out.path()).unwrap().count(), 1, "no temp left");

    // A broken container reports FFmpeg's reason and leaves nothing behind.
    let broken = root.path().join("broken.mp4");
    fs::write(&broken, b"not a video at all").unwrap();
    let dest = out.path().join("broken-clean.mp4");
    let error = export_clean(root.path(), &broken, Some(&dest)).unwrap_err();
    assert!(error.starts_with("FFmpeg could not remux"), "{error}");
    assert_eq!(fs::read_dir(out.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn export_folder_reached_through_a_symlink_bookmark_works() {
    let (root, out) = dirs();
    let source = root.path().join("a.png");
    fs::write(&source, tagged_png()).unwrap();
    let real = out.path().join("real");
    fs::create_dir(&real).unwrap();
    let bookmark = out.path().join("Videos");
    std::os::unix::fs::symlink(&real, &bookmark).unwrap();
    let done = export_clean(root.path(), &source, Some(&bookmark.join("a-clean.png")))
        .unwrap()
        .unwrap();
    assert_eq!(done.path, bookmark.join("a-clean.png").to_string_lossy());
    assert!(real.join("a-clean.png").is_file());
    assert_eq!(fs::read_dir(&real).unwrap().count(), 1, "no temp left");
    // The resolved folder still refuses replacing the source through the bookmark.
    let inside = root.path().join("in");
    fs::create_dir(&inside).unwrap();
    let src = inside.join("b.png");
    fs::write(&src, tagged_png()).unwrap();
    let link = out.path().join("in-link");
    std::os::unix::fs::symlink(&inside, &link).unwrap();
    assert!(export_clean(root.path(), &src, Some(&link.join("b.png")))
        .unwrap_err()
        .contains("source"));
}
#[test]
fn confirmed_export_replaces_existing_and_source_without_metadata() {
    let (root, out) = dirs();
    let source = root.path().join("in.png");
    fs::write(&source, tagged_png()).unwrap();
    let dest = out.path().join("same-name.png");
    fs::write(&dest, b"previous export").unwrap();
    let old = replace::capture(&dest).unwrap().unwrap();
    export_clean_confirmed(root.path(), &source, Some(&dest), Some(&old)).unwrap();
    assert_eq!(
        png_pixels(&fs::read(&source).unwrap()),
        png_pixels(&fs::read(&dest).unwrap())
    );
    assert!(!png_chunks(&fs::read(&dest).unwrap())
        .iter()
        .any(|s| s == "tEXt"));
    let old = replace::capture(&source).unwrap().unwrap();
    export_clean_confirmed(root.path(), &source, Some(&source), Some(&old)).unwrap();
    assert!(!png_chunks(&fs::read(&source).unwrap())
        .iter()
        .any(|s| s == "tEXt"));
}
#[test]
fn replacement_rejects_changes_after_confirmation_and_cancel_keeps_bytes() {
    let (root, out) = dirs();
    let source = root.path().join("in.png");
    fs::write(&source, tagged_png()).unwrap();
    let dest = out.path().join("out.png");
    fs::write(&dest, b"old").unwrap();
    let old = replace::capture(&dest).unwrap().unwrap();
    fs::write(&dest, b"new concurrent content").unwrap();
    assert!(export_clean_confirmed(root.path(), &source, Some(&dest), Some(&old)).is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"new concurrent content");
    assert!(
        export_clean_confirmed(root.path(), &source, None, Some(&old))
            .unwrap()
            .is_none()
    );
    assert_eq!(fs::read(&dest).unwrap(), b"new concurrent content");
}
#[test]
fn replacement_collision_keeps_new_arrival_and_original_recovery_copy() {
    let (_root, out) = dirs();
    let dest = out.path().join("out.png");
    fs::write(&dest, b"old").unwrap();
    let old = replace::capture(&dest).unwrap().unwrap();
    let parent = Anchor::open(out.path()).unwrap();
    let mut temp = parent.partial("clean.tmp").unwrap();
    temp.write_all(b"clean").unwrap();
    let error = replace::publish(&parent, out.path(), "clean.tmp", "out.png", &old, || {
        fs::write(&dest, b"concurrent arrival").unwrap();
    })
    .unwrap_err();
    assert!(error.contains("recovery"));
    assert_eq!(fs::read(&dest).unwrap(), b"concurrent arrival");
    let backups: Vec<_> = fs::read_dir(out.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".deas-replaced-")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(fs::read(&backups[0]).unwrap(), b"old");
}

#[test]
fn replacement_restores_concurrent_object_moved_before_backup_rename() {
    let (_root, out) = dirs();
    let dest = out.path().join("out.png");
    fs::write(&dest, b"old").unwrap();
    let old = replace::capture(&dest).unwrap().unwrap();
    let parent = Anchor::open(out.path()).unwrap();
    let mut temp = parent.partial("clean.tmp").unwrap();
    temp.write_all(b"clean").unwrap();
    let arrival = out.path().join("arrival.png");
    fs::write(&arrival, b"concurrent replacement").unwrap();
    let error = replace::publish_with_checkpoints(
        &parent,
        out.path(),
        "clean.tmp",
        "out.png",
        &old,
        (
            || {
                fs::rename(&arrival, &dest).unwrap();
            },
            || panic!("changed destination must not reach publication"),
            || {},
        ),
    )
    .unwrap_err();
    assert!(error.contains("changed during replacement"), "{error}");
    assert_eq!(fs::read(&dest).unwrap(), b"concurrent replacement");
    assert_eq!(fs::read(out.path().join("clean.tmp")).unwrap(), b"clean");
    assert_eq!(
        fs::read_dir(out.path()).unwrap().count(),
        2,
        "no hidden arrival"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn replacement_reports_retained_backup_when_cleanup_fails() {
    use std::os::unix::fs::PermissionsExt;
    let (_root, out) = dirs();
    let dest = out.path().join("out.png");
    fs::write(&dest, b"old").unwrap();
    let old = replace::capture(&dest).unwrap().unwrap();
    let parent = Anchor::open(out.path()).unwrap();
    let mut temp = parent.partial("clean.tmp").unwrap();
    temp.write_all(b"clean").unwrap();
    let permissions = fs::metadata(out.path()).unwrap().permissions();
    let result = replace::publish_with_checkpoints(
        &parent,
        out.path(),
        "clean.tmp",
        "out.png",
        &old,
        (
            || {},
            || {},
            || fs::set_permissions(out.path(), fs::Permissions::from_mode(0o500)).unwrap(),
        ),
    );
    fs::set_permissions(out.path(), permissions).unwrap();
    let error = result.unwrap_err();
    assert!(
        error.contains("Export saved") && error.contains("recovery file"),
        "{error}"
    );
    assert_eq!(fs::read(&dest).unwrap(), b"clean");
    let backup = fs::read_dir(out.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".deas-replaced-")
        })
        .unwrap();
    assert!(error.contains(&backup.display().to_string()), "{error}");
    assert_eq!(fs::read(backup).unwrap(), b"old");
}
