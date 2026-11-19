use super::*;

const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn cdn_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid CivitAI preview URL")?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("image.civitai.com" | "images.civitai.com")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("Invalid CivitAI preview host".into());
    }
    Ok(url)
}

pub(super) struct Cover {
    extension: &'static str,
    bytes: Vec<u8>,
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if bytes.starts_with(b"GIF89a") || bytes.starts_with(b"GIF87a") {
        Some("gif")
    } else if matches!(bytes.get(4..12), Some(b"ftypavif" | b"ftypavis")) {
        Some("avif")
    } else {
        None
    }
}

pub(super) async fn download(url: &str) -> Result<Cover, String> {
    let url = cdn_url(url)?;
    let client = client_for(false, Some(Duration::from_secs(20)))?;
    let mut response = client.get(url).send().await.map_err(|_| network_error())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|len| len > MAX_PREVIEW_BYTES as u64)
    {
        return Err("CivitAI preview is unavailable or too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        if chunk.len() > MAX_PREVIEW_BYTES - bytes.len() {
            return Err("CivitAI preview is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let extension = image_extension(&bytes).ok_or("Unsupported CivitAI preview image")?;
    Ok(Cover { extension, bytes })
}

pub(super) fn publish(source: &Source, cover: Cover) -> Result<(), String> {
    let name = format!("{}.preview.{}", source.name, cover.extension);
    publish_bytes(source, &name, &cover.bytes, false)
}

pub(super) const CUSTOM_COVER_SUFFIX: &str = ".deas-preview.png";

pub(super) fn replace_custom(source: &Source, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 5 * 1024 * 1024 || image_extension(bytes) != Some("png") {
        return Err("Preview must be a PNG up to 5 MiB".into());
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 8 * 1024 * 1024,
    });
    let mut reader = decoder.read_info().map_err(|_| "Invalid PNG preview")?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > 1024
        || info.height > 1024
        || info.animation_control.is_some()
        || info.bit_depth != png::BitDepth::Eight
    {
        return Err("Preview must be an 8-bit still image up to 1024 pixels per side".into());
    }
    let size = reader.output_buffer_size();
    reader
        .next_frame(&mut vec![0; size])
        .map_err(|_| "Invalid PNG preview")?;
    let _commit = CACHE_PUBLICATION
        .lock()
        .map_err(|_| "Cache lock poisoned")?;
    let name = format!("{}{CUSTOM_COVER_SUFFIX}", source.name);
    let existing = source.dir.anchor.absent(&name).is_err();
    if existing {
        source.dir.regular(&name)?;
    }
    publish_bytes(source, &name, bytes, existing)
}

fn publish_bytes(source: &Source, name: &str, bytes: &[u8], existing: bool) -> Result<(), String> {
    let mut temp = OwnedTemp::create(&source.dir)?;
    temp.file.write_all(bytes).map_err(|e| e.to_string())?;
    temp.file.sync_all().map_err(|e| e.to_string())?;
    source.verify()?;
    temp.verify()?;
    source.dir.replace(&temp.name, name, existing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_input_requires_the_cdn_and_recognizable_image_bytes() {
        assert!(cdn_url("https://image.civitai.com/example").is_ok());
        for url in [
            "http://image.civitai.com/x",
            "https://image.civitai.com.evil.test/x",
            "https://user@image.civitai.com/x",
            "https://image.civitai.com:444/x",
        ] {
            assert!(cdn_url(url).is_err());
        }
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\n"), Some("png"));
        assert_eq!(image_extension(b"<svg></svg>"), None);
    }

    #[test]
    fn fetched_cover_is_discovered_and_never_overwrites_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.safetensors");
        std::fs::write(&path, b"model").unwrap();
        let source = Source::open(&path).unwrap();
        let bytes = include_bytes!("../test-data/preview/preview.jpg").to_vec();
        let cover = || Cover {
            extension: "jpg",
            bytes: bytes.clone(),
        };
        publish(&source, cover()).unwrap();
        let image = path.with_file_name("fixture.safetensors.preview.jpg");
        assert_eq!(index::find_local_preview(&path).as_deref(), image.to_str());
        assert!(publish(&source, cover()).is_err());
        assert_eq!(std::fs::read(image).unwrap(), bytes);
    }
}
