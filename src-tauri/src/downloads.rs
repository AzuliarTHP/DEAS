//! Optional staged data downloads. Catalogs never grant execution or credential access.
#[path = "downloads/fs.rs"]
pub(crate) mod fs;
#[path = "downloads_models.rs"]
pub mod models;
#[path = "downloads_providers.rs"]
mod providers;
#[cfg(test)]
#[path = "downloads_tests.rs"]
mod tests;
use crate::auth::AuthState;
use reqwest::{header::HeaderValue, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
const MAX_RESOURCES: usize = 50;
const MAX_FILES: usize = 16;
/// One resource: a single 22–26 GB checkpoint must fit; the aggregate stays separate.
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024 * 1024;
const MAX_JOB_BYTES: u64 = 256 * 1024 * 1024 * 1024;
const MAX_JSON: usize = 2 * 1024 * 1024;
/// Catalog/metadata requests; downloads themselves are bounded by an idle read timeout.
const MAX_HTTP_SECONDS: u64 = 3600;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resource {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub downloadable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// HTTPS image shown beside the resource; never fetched natively.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// ComfyUI model folder name (checkpoints, loras, …) when the source declares a type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Source signals restricted access (non-public availability or paid access).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auth: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nsfw: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Version publication date supplied by the provider (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    /// Model version name; groups the files (quants, formats) of one release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Display-only file variant, e.g. "fp8 · pruned · SafeTensor · ≈13.5 GB"; never used for verification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub origin: String,
    pub scopes: Vec<String>,
    pub anonymous_notice: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub provider_id: String,
    pub scope: String,
    pub locator: String,
    pub kind: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// "image" or "video" generation model; used for filtering only.
    /// Base model family label (e.g. "Wan 2.2", "LTX 2.3"); used for filtering only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Version publication date supplied by the provider (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
    /// Source rejects anonymous downloads (observed 401 when the catalog was generated).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auth: bool,
    /// Adult content; hidden unless the user switched the view to NSFW.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nsfw: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub version: u32,
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub entries: Vec<Entry>,
}
impl Catalog {
    pub fn parse(text: &str) -> Result<Self, String> {
        if text.len() > 1024 * 1024 {
            return Err("Catalog exceeds 1 MiB".into());
        }
        let c: Self = toml::from_str(text).map_err(|_| "Invalid strict data-only TOML schema")?;
        c.validate()?;
        Ok(c)
    }
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.providers.len() > 32 || self.entries.len() > 500 {
            return Err("Catalog version or bounds invalid".into());
        }
        let mut ids = HashSet::new();
        for p in &self.providers {
            safe_id(&p.id)?;
            bounded_text(&p.label, 160)?;
            bounded_text(&p.anonymous_notice, 1000)?;
            if !ids.insert(&p.id) {
                return Err("Duplicate provider ID".into());
            }
            let scopes = match p.kind.as_str() {
                "huggingface" => vec!["user", "repo"],
                "civitai" => vec!["user", "model", "search"],
                "github" => vec!["user", "repo"],
                "http" => vec!["index"],
                "ollama" => vec!["backend"],
                _ => return Err("Unknown compiled provider adapter".into()),
            };
            if p.scopes.is_empty()
                || p.scopes.len() > scopes.len()
                || p.scopes.iter().any(|s| !scopes.contains(&s.as_str()))
                || p.scopes.iter().collect::<HashSet<_>>().len() != p.scopes.len()
            {
                return Err("Invalid adapter scopes".into());
            }
            let u = validate_url(&p.origin, p.kind == "ollama", false)?;
            if u.path() != "/" || p.origin != u.origin().ascii_serialization() {
                return Err("Origin must be an exact canonical origin without slash".into());
            }
            let official = match p.kind.as_str() {
                "huggingface" => Some(("huggingface", "https://huggingface.co")),
                "github" => Some(("github", "https://api.github.com")),
                "civitai" => Some(("civitai", "https://civitai.com")),
                _ => None,
            };
            if let Some((id, origin)) = official {
                if p.id != id || p.origin != origin {
                    return Err("Official adapter ID/origin cannot be overridden".into());
                }
            }
            if official.is_none() && matches!(p.id.as_str(), "huggingface" | "github" | "civitai") {
                return Err("Reserved authentication provider ID".into());
            }
        }
        let mut ids = HashSet::new();
        for e in &self.entries {
            safe_id(&e.id)?;
            bounded_text(&e.label, 240)?;
            bounded_text(&e.locator, 4096)?;
            safe_name(&e.target)?;
            validate_kind(&e.kind)?;
            if let Some(date) = &e.published_at {
                bounded_text(date, 64)?;
            }
            if let Some(base) = &e.base {
                bounded_text(base, 64)?;
            }
            if e.media
                .as_deref()
                .is_some_and(|m| !matches!(m, "image" | "video"))
            {
                return Err("Entry media must be image or video".into());
            }
            validate_metadata(e.sha256.as_deref(), e.license.as_deref(), None)?;
            if let Some(preview) = &e.preview {
                validate_url(preview, false, true)?;
            }
            if !ids.insert(&e.id) || !self.provider(&e.provider_id)?.scopes.contains(&e.scope) {
                return Err("Duplicate entry or unsupported scope".into());
            }
            if self.provider(&e.provider_id)?.kind == "http" {
                same_origin_url(
                    self.provider(&e.provider_id)?,
                    e.locator
                        .strip_prefix("direct:")
                        .or_else(|| e.locator.strip_prefix("index:"))
                        .unwrap_or(&e.locator),
                )?;
            }
        }
        Ok(())
    }
    fn load() -> Result<Self, String> {
        let mut c = Self::parse(include_str!("../downloads/default.toml"))?;
        // Bundled entry-only catalogs reuse the compiled providers and are validated together.
        let extra: Catalog = toml::from_str(include_str!("../downloads/darksidewalker.toml"))
            .map_err(|_| "Invalid bundled catalog")?;
        c.entries.extend(extra.entries);
        c.validate()?;
        Ok(c)
    }
    pub fn provider(&self, id: &str) -> Result<&Provider, String> {
        self.providers
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| "Unknown catalog provider".into())
    }
}
fn bounded_text(s: &str, max: usize) -> Result<(), String> {
    if s.is_empty() || s.len() > max || s.chars().any(char::is_control) {
        Err("Invalid text field".into())
    } else {
        Ok(())
    }
}
fn safe_id(s: &str) -> Result<(), String> {
    if s.is_empty()
        || s.len() > 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err("Invalid stable ID".into())
    } else {
        Ok(())
    }
}
fn safe_name(s: &str) -> Result<(), String> {
    bounded_text(s, 200)?;
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if s == "."
        || s == ".."
        || s.starts_with('.')
        || s.ends_with(['.', ' '])
        || s.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        Err("Unsafe filename or subfolder".into())
    } else {
        Ok(())
    }
}
fn validate_kind(s: &str) -> Result<(), String> {
    if matches!(
        s,
        "file" | "model" | "dataset" | "repo" | "workflow" | "preset"
    ) {
        Ok(())
    } else {
        Err("Unsupported resource kind".into())
    }
}
fn validate_metadata(
    hash: Option<&str>,
    license: Option<&str>,
    size: Option<u64>,
) -> Result<(), String> {
    if hash.is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err("Invalid SHA-256".into());
    }
    if size.is_some_and(|s| s > MAX_FILE_BYTES) {
        return Err("Resource exceeds the 128 GiB limit".into());
    }
    if let Some(s) = license {
        bounded_text(s, 512)?;
    }
    Ok(())
}
fn validate_url(s: &str, local: bool, query: bool) -> Result<Url, String> {
    if s.len() > 8192
        || s.trim() != s
        || s.contains('\\')
        || s.bytes().any(|b| b.is_ascii_control())
        || s.split_once("://")
            .is_some_and(|(_, s)| s.split('/').next().unwrap_or("").contains('@'))
    {
        return Err("Unsafe source URL".into());
    }
    let u = Url::parse(s).map_err(|_| "Invalid URL")?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || (!query && u.query().is_some())
    {
        return Err("Source URL contains credentials, query or fragment".into());
    }
    let host = u.host_str().ok_or("URL requires host")?;
    // Plain HTTP transport exists only in test builds for actual scratch fixtures.
    #[cfg(test)]
    if u.scheme() == "http" && host == "127.0.0.1" {
        return Ok(u);
    }
    if local {
        if !matches!(host, "127.0.0.1" | "localhost" | "[::1]")
            || !matches!(u.scheme(), "http" | "https")
        {
            return Err("Ollama must be explicitly loopback-bound".into());
        }
    } else {
        if u.scheme() != "https" || u.port_or_known_default() != Some(443) {
            return Err("Remote sources require standard HTTPS".into());
        }
        if matches!(host, "localhost" | "[::1]")
            || host.ends_with(".localhost")
            || host.ends_with(".local")
            || host.parse::<std::net::IpAddr>().is_ok()
        {
            return Err("Remote sources require a public DNS hostname".into());
        }
    }
    Ok(u)
}
fn same_origin_url(p: &Provider, s: &str) -> Result<Url, String> {
    let u = validate_url(s, p.kind == "ollama", false)?;
    if u.origin().ascii_serialization() != p.origin {
        return Err("Source must match configured provider origin".into());
    }
    Ok(u)
}
struct PublicDns;
impl reqwest::dns::Resolve for PublicDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((name.as_str(), 443))
                .await?
                .collect();
            if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
                return Err(
                    Box::new(std::io::Error::other("Non-public DNS destination blocked"))
                        as Box<dyn std::error::Error + Send + Sync>,
                );
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}
fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v) => {
            let b = v.octets();
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_multicast()
                && !v.is_broadcast()
                && !v.is_unspecified()
                && b[0] != 0
                && b[0] < 224
                && !(b[0] == 100 && (64..=127).contains(&b[1]))
                && !(b[0] == 198 && (b[1] == 18 || b[1] == 19))
        }
        std::net::IpAddr::V6(v) => {
            let b = v.octets();
            !v.is_loopback()
                && !v.is_unspecified()
                && !v.is_multicast()
                && (b[0] & 0xe0) == 0x20 // global unicast only, not site-local/translation ranges
                && !(b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8)
                && v.to_ipv4_mapped().is_none()
        }
    }
}
fn client_for(local: bool, timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .user_agent("DEAS/0.1 optional-downloads");
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    if !local {
        builder = builder.dns_resolver(Arc::new(PublicDns));
    }
    builder
        .build()
        .map_err(|_| "Cannot construct HTTP client".into())
}
fn network_error() -> String {
    "Network request failed (details withheld to protect credentials)".into()
}
fn credential(
    auth: &AuthState,
    p: &Provider,
    enabled: bool,
) -> Result<Option<HeaderValue>, String> {
    if !enabled {
        return Ok(None);
    }
    let token = auth.credential(&p.id, &p.origin)?;
    let token = token.ok_or("No scoped credential configured")?;
    let mut h = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "Invalid credential header")?;
    h.set_sensitive(true);
    Ok(Some(h))
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowseRequest {
    pub provider_id: String,
    pub scope: String,
    pub locator: String,
    #[serde(default)]
    pub cursor: Option<String>,
    pub authenticated: bool,
    /// Ask the source for adult content too; off by default.
    #[serde(default)]
    pub nsfw: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub resources: Vec<Resource>,
    pub next_cursor: Option<String>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    pub provider_id: String,
    pub resources: Vec<Resource>,
    pub parent_path: String,
    pub folder_name: String,
    pub authenticated: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPlan {
    pub id: String,
    pub target: String,
    pub resources: Vec<Resource>,
    pub total_known_bytes: u64,
    pub unknown_size_count: usize,
    pub warnings: Vec<String>,
    pub can_execute: bool,
}
struct StoredPlan {
    view: DownloadPlan,
    provider: Provider,
    authenticated: bool,
    parent: PathBuf,
    subfolder: String,
    identity: (u64, u64),
    created: Instant,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadJob {
    pub id: String,
    pub label: String,
    pub provider: Provider,
    pub authenticated: bool,
    pub parent_path: String,
    pub folder_name: String,
    pub target: String,
    pub resources: Vec<Resource>,
    /// queued | running | succeeded | failed | cancelled | interrupted
    pub state: String,
    pub completed: usize,
    /// Bytes already on disk for this job, including bytes kept by a resumed partial.
    pub bytes_placed: u64,
    /// Declared total size; 0 when no resource published a size.
    pub total_bytes: u64,
    #[serde(default)]
    pub current_file: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedQueue {
    version: u32,
    jobs: Vec<DownloadJob>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobMarker {
    id: String,
}
/// Written into a newly created destination leaf; proves a later resume may reuse it.
const JOB_MARKER: &str = "deas-download-job.json";
/// Completed/terminal queue entries kept at most this long; bounded persistence file.
const MAX_JOBS: usize = 64;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    pub state: String,
    pub completed: usize,
    pub total: usize,
    pub bytes_downloaded: u64,
    pub error: Option<String>,
    /// Bytes on disk for the current batch (resumed partials included); percentage basis.
    #[serde(default)]
    pub bytes_placed: u64,
    /// Declared total bytes of the current batch.
    #[serde(default)]
    pub total_bytes: u64,
    /// The background download queue; persisted and resumable across restarts.
    #[serde(default)]
    pub jobs: Vec<DownloadJob>,
}
impl Default for DownloadStatus {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            completed: 0,
            total: 0,
            bytes_downloaded: 0,
            error: None,
            bytes_placed: 0,
            total_bytes: 0,
            jobs: Vec::new(),
        }
    }
}
struct Continuation {
    request: BrowseRequest,
    url: Url,
    created: Instant,
}
struct Inner {
    catalog: Result<Catalog, String>,
    known: HashMap<(String, String), (Resource, String)>,
    cursors: HashMap<String, Continuation>,
    plans: HashMap<String, StoredPlan>,
    status: DownloadStatus,
    cancel: Arc<AtomicBool>,
    jobs: Vec<DownloadJob>,
    persist_path: Option<PathBuf>,
    worker: bool,
    last_persist: Instant,
}

/// Shared per-job transport context for one file transfer.
struct TransferRun<'a> {
    provider: &'a Provider,
    client: &'a reqwest::Client,
    header: Option<HeaderValue>,
    cancel: &'a AtomicBool,
    job_id: &'a str,
}

#[derive(Clone)]
pub struct DownloadEngine {
    inner: Arc<Mutex<Inner>>,
}
impl Default for DownloadEngine {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                catalog: Catalog::load(),
                known: HashMap::new(),
                cursors: HashMap::new(),
                plans: HashMap::new(),
                status: DownloadStatus::default(),
                cancel: Arc::new(AtomicBool::new(false)),
                jobs: Vec::new(),
                persist_path: None,
                worker: false,
                last_persist: Instant::now(),
            })),
        }
    }
}
impl DownloadEngine {
    pub fn catalog(&self) -> Result<Catalog, String> {
        self.inner
            .lock()
            .map_err(|_| "Download state unavailable")?
            .catalog
            .clone()
    }
    pub fn import(&self, text: String) -> Result<Catalog, String> {
        if text.len() > 1024 * 1024 {
            return Err("Catalog exceeds 1 MiB".into());
        }
        // Validate after merging so new entries may reference existing providers;
        // provider definitions still cannot overwrite any trusted registration.
        let extra: Catalog =
            toml::from_str(&text).map_err(|_| "Invalid strict data-only TOML schema")?;
        if extra.version != 1 {
            return Err("Unsupported catalog version".into());
        }
        let mut i = self
            .inner
            .lock()
            .map_err(|_| "Download state unavailable")?;
        if i.status.state == "running" {
            return Err("Cannot import while downloading".into());
        }
        let mut c = i.catalog.clone()?;
        c.providers.extend(extra.providers);
        c.entries.extend(extra.entries);
        c.validate()?;
        i.catalog = Ok(c.clone());
        i.known.clear();
        i.plans.clear();
        i.cursors.clear();
        Ok(c)
    }
    pub async fn browse(
        &self,
        mut request: BrowseRequest,
        auth: &AuthState,
    ) -> Result<Listing, String> {
        bounded_text(&request.locator, 4096)?;
        let c = self.catalog()?;
        let p = c.provider(&request.provider_id)?;
        if !p.scopes.contains(&request.scope) {
            return Err("Scope not declared by provider".into());
        }
        let next = if let Some(cursor) = request.cursor.take() {
            let mut i = self
                .inner
                .lock()
                .map_err(|_| "Download state unavailable")?;
            let n = i
                .cursors
                .remove(&cursor)
                .ok_or("Unknown or consumed continuation")?;
            if n.created.elapsed() > Duration::from_secs(600) || n.request != request {
                return Err("Continuation expired or request changed".into());
            }
            Some(n.url)
        } else {
            None
        };
        let h = credential(auth, p, request.authenticated)?;
        let mut page = tokio::time::timeout(
            Duration::from_secs(30),
            providers::list(p, &request, next, h),
        )
        .await
        .map_err(|_| "Browse exceeded 30 seconds")??;
        if p.id == "huggingface"
            && request.scope == "repo"
            && request.locator == "models:MATLOWAI/H3-Dials"
        {
            // The author also publishes videos and documentation in this repo; only offer Dial Rack files.
            const DIALS: &str = "https://huggingface.co/MATLOWAI/H3-Dials/resolve/main/dials/";
            page.resources.retain(|r| {
                r.url
                    .as_deref()
                    .and_then(|url| url.strip_prefix(DIALS))
                    .is_some_and(|path| path.ends_with(".safetensors"))
            });
            for resource in &mut page.resources {
                resource.license = Some("MiniMax H3 Community License Agreement".into());
            }
        }
        if p.kind == "http"
            && page.resources.len() == 1
            && (request.locator.starts_with("direct:") || !request.locator.ends_with(".json"))
        {
            if let Some(entry) = c.entries.iter().find(|e| {
                e.provider_id == p.id && e.scope == request.scope && e.locator == request.locator
            }) {
                page.resources[0].license = entry.license.clone();
                page.resources[0].sha256 = entry.sha256.clone();
                page.resources[0].kind = entry.kind.clone();
            }
        }
        let mut i = self
            .inner
            .lock()
            .map_err(|_| "Download state unavailable")?;
        if i.known.len() + page.resources.len() > 1000 {
            i.known.clear();
        }
        for r in &page.resources {
            validate_resource(p, r)?;
            if r.downloadable {
                let filename = providers::filename(r)?;
                i.known
                    .insert((p.id.clone(), r.id.clone()), (r.clone(), filename));
            }
        }
        let cursor = if let Some(url) = page.next.take() {
            if i.cursors.len() >= 64 {
                i.cursors.clear();
            }
            let id = uuid::Uuid::new_v4().to_string();
            i.cursors.insert(
                id.clone(),
                Continuation {
                    request,
                    url,
                    created: Instant::now(),
                },
            );
            Some(id)
        } else {
            None
        };
        if !p.anonymous_notice.is_empty() {
            page.warnings.push(p.anonymous_notice.clone());
        }
        Ok(Listing {
            resources: page.resources,
            next_cursor: cursor,
            warnings: page.warnings,
        })
    }
    pub fn plan(&self, mut request: PlanRequest) -> Result<DownloadPlan, String> {
        if request.resources.is_empty() || request.resources.len() > MAX_FILES {
            return Err("Select 1–16 files".into());
        }
        let mut parent = PathBuf::from(request.parent_path);
        let target = if request.folder_name.is_empty() {
            parent.clone()
        } else {
            parent.join(&request.folder_name)
        };
        // Only one absent leaf can reuse the anchored, confirmation-only new-folder path.
        if request.folder_name.is_empty()
            && matches!(std::fs::symlink_metadata(&parent), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            let leaf = parent
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("Unsafe destination folder")?;
            safe_name(leaf)?;
            request.folder_name = leaf.to_owned();
            parent = parent
                .parent()
                .ok_or("Missing destination parent")?
                .to_owned();
        }
        let anchor = fs::Anchor::open(&parent)?;
        // Empty folder name stages directly into the existing parent (e.g. ComfyUI/models/loras);
        // files are still created exclusively, so nothing is overwritten.
        if request.folder_name.is_empty() {
            anchor.writable()?;
        } else {
            safe_name(&request.folder_name)?;
            anchor.absent(&request.folder_name)?;
        }
        let mut i = self
            .inner
            .lock()
            .map_err(|_| "Download state unavailable")?;
        if i.status.state == "running" {
            return Err("Download already running".into());
        }
        let provider = i
            .catalog
            .as_ref()
            .map_err(Clone::clone)?
            .provider(&request.provider_id)?
            .clone();
        let mut names = HashSet::new();
        let mut warnings =
            vec!["Staged data only: no execution, extraction or ComfyUI installation".into()];
        let mut total = 0;
        for r in &request.resources {
            validate_resource(&provider, r)?;
            if !r.downloadable || provider.kind == "ollama" {
                return Err("Selected resource is not downloadable".into());
            }
            let (known, name) = i
                .known
                .get(&(provider.id.clone(), r.id.clone()))
                .ok_or("Refresh native browse before planning")?;
            if known != r {
                return Err("Resource identity or metadata changed".into());
            }
            if name.eq_ignore_ascii_case("deas-download-manifest.json")
                || name.eq_ignore_ascii_case(JOB_MARKER)
                || !names.insert(name.to_lowercase())
            {
                return Err(
                    "Selected target filenames collide or use reserved manifest name".into(),
                );
            }
            total += r.size.unwrap_or(0);
            if r.sha256.is_none() {
                warnings.push(format!(
                    "{name}: no SHA-256; integrity not cryptographically verified"
                ));
            }
            if r.license.is_none() {
                warnings.push(format!(
                    "{name}: license not supplied; review upstream terms"
                ));
            }
        }
        if total > MAX_JOB_BYTES {
            return Err("Combined known size exceeds the 256 GiB limit".into());
        }
        let view = DownloadPlan {
            id: uuid::Uuid::new_v4().to_string(),
            target: target.to_string_lossy().into_owned(),
            total_known_bytes: total,
            unknown_size_count: request
                .resources
                .iter()
                .filter(|r| r.size.is_none())
                .count(),
            resources: request.resources,
            warnings,
            can_execute: cfg!(any(target_os = "linux", windows)),
        };
        i.plans
            .retain(|_, p| p.created.elapsed() < Duration::from_secs(600));
        if i.plans.len() >= 8 {
            i.plans.clear();
        }
        i.plans.insert(
            view.id.clone(),
            StoredPlan {
                view: view.clone(),
                provider,
                authenticated: request.authenticated,
                parent,
                subfolder: request.folder_name,
                identity: anchor.identity()?,
                created: Instant::now(),
            },
        );
        Ok(view)
    }
    /// Attach the persistence file of this installation; a queue saved by an earlier
    /// run returns as resumable (a worker interrupted by the app exit becomes "interrupted").
    pub fn attach(&self, dir: &Path) {
        let path = dir.join("download-queue.json");
        let Ok(mut i) = self.inner.lock() else { return };
        i.persist_path = Some(path.clone());
        let loaded = std::fs::read(&path).ok().filter(|text| text.len() <= MAX_JSON).and_then(|text| {
            serde_json::from_str::<PersistedQueue>(&String::from_utf8_lossy(&text)).ok()
        });
        let mut restored = 0usize;
        for mut job in loaded.map(|q| q.jobs).unwrap_or_default() {
            if job.state == "running" {
                job.state = "interrupted".into();
            }
            if !matches!(
                job.state.as_str(),
                "queued" | "interrupted" | "cancelled" | "failed" | "succeeded"
            ) {
                continue;
            }
            if job.state != "succeeded" {
                restored += 1;
            }
            i.jobs.push(job);
        }
        if i.jobs.len() > MAX_JOBS {
            let excess = i.jobs.len() - MAX_JOBS;
            i.jobs.drain(0..excess);
        }
        if restored > 0 {
            crate::logs::push(
                crate::logs::Source::Deas,
                &format!("Downloads: {restored} unfinished queue item(s) restored from a previous session; press Resume in the Library download queue to continue them.",),
            );
        }
    }
    /// Caller holds the lock; the file is small and writes are rare (transitions plus a
    /// throttled snapshot while bytes stream).
    fn persist(i: &mut Inner) {
        i.last_persist = Instant::now();
        let Some(path) = i.persist_path.clone() else { return };
        let Ok(text) = serde_json::to_string(&PersistedQueue {
            version: 1,
            jobs: i.jobs.clone(),
        }) else {
            return;
        };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
    fn status_of(i: &Inner) -> DownloadStatus {
        let mut s = i.status.clone();
        s.jobs = i.jobs.clone();
        s
    }
    pub fn status(&self) -> Result<DownloadStatus, String> {
        let i = self
            .inner
            .lock()
            .map_err(|_| "Download state unavailable")?;
        Ok(Self::status_of(&i))
    }
    pub fn cancel(&self) -> Result<DownloadStatus, String> {
        let i = self
            .inner
            .lock()
            .map_err(|_| "Download state unavailable")?;
        if i.worker {
            i.cancel.store(true, Ordering::SeqCst);
        }
        Ok(Self::status_of(&i))
    }
    /// Convert stored plans into queue jobs, validate their destinations exactly like a
    /// single start did, and let the background worker run them one after another.
    pub fn enqueue(
        &self,
        plan_ids: Vec<String>,
        confirmed: bool,
        auth: &AuthState,
    ) -> Result<DownloadStatus, String> {
        if !confirmed {
            return Err("Explicit confirmation required".into());
        }
        if plan_ids.is_empty() || plan_ids.len() > MAX_FILES {
            return Err("Queue accepts 1-16 plans per action".into());
        }
        let mut i = self
            .inner
            .lock()
            .map_err(|_| "Download state unavailable")?;
        let mut prepared = Vec::new();
        for id in plan_ids {
            let p = i.plans.remove(&id).ok_or("Unknown or consumed plan")?;
            if p.created.elapsed() > Duration::from_secs(600) || !p.view.can_execute {
                return Err("Plan expired or unsupported".into());
            }
            prepared.push(p);
        }
        for p in &prepared {
            let parent = fs::Anchor::open(&p.parent)?;
            if parent.identity() != Ok(p.identity) {
                return Err("Parent changed since planning".into());
            }
            if p.subfolder.is_empty() {
                parent.writable()?;
            } else {
                parent.absent(&p.subfolder)?;
            }
        }
        if i.jobs.len() + prepared.len() > MAX_JOBS {
            i.jobs.retain(|j| {
                !matches!(j.state.as_str(), "succeeded" | "cancelled" | "failed")
            });
            if i.jobs.len() + prepared.len() > MAX_JOBS {
                let excess = i.jobs.len() + prepared.len() - MAX_JOBS;
                i.jobs.drain(0..excess);
            }
        }
        for p in &prepared {
            let label = match p.view.resources.len() {
                1 => p.view.resources[0].label.clone(),
                n => format!(
                    "{} (+{} files)",
                    p.view.resources[0].label.clone(),
                    n - 1
                ),
            };
            i.jobs.push(DownloadJob {
                id: p.view.id.clone(),
                label,
                provider: p.provider.clone(),
                authenticated: p.authenticated,
                parent_path: p.parent.to_string_lossy().into_owned(),
                folder_name: p.subfolder.clone(),
                target: p.view.target.clone(),
                resources: p.view.resources.clone(),
                state: "queued".into(),
                completed: 0,
                bytes_placed: 0,
                total_bytes: p.view.total_known_bytes,
                current_file: None,
                error: None,
            });
        }
        Self::persist(&mut i);
        let files: usize = prepared.iter().map(|p| p.view.resources.len()).sum();
        let bytes: u64 = prepared.iter().map(|p| p.view.total_known_bytes).sum();
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!(
                "Downloads: queued {} folder group(s), {files} file(s), {} known bytes.",
                prepared.len(),
                bytes
            ),
        );
        self.spawn_worker(&mut i, auth.clone())?;
        Ok(Self::status_of(&i))
    }
    pub fn start(
        &self,
        plan_id: String,
        confirmed: bool,
        auth: &AuthState,
    ) -> Result<DownloadStatus, String> {
        self.enqueue(vec![plan_id], confirmed, auth)
    }
    /// Re-queue interrupted, cancelled or failed jobs; kept partial files resume where they stopped.
    pub fn resume(&self, job_ids: Option<Vec<String>>, auth: &AuthState) -> Result<DownloadStatus, String> {
        let mut i = self
            .inner
            .lock()
            .map_err(|_| "Download state unavailable")?;
        let mut resumed = 0usize;
        for j in &mut i.jobs {
            if matches!(
                j.state.as_str(),
                "cancelled" | "failed" | "interrupted"
            ) && job_ids
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|id| id == &j.id))
            {
                j.state = "queued".into();
                j.error = None;
                resumed += 1;
            }
        }
        if resumed == 0 {
            return Ok(Self::status_of(&i));
        }
        Self::persist(&mut i);
        crate::logs::push(
            crate::logs::Source::Deas,
            &format!("Downloads: resuming {resumed} queue item(s); kept partial files continue where they stopped."),
        );
        self.spawn_worker(&mut i, auth.clone())?;
        Ok(Self::status_of(&i))
    }
    /// Drop terminal queue entries (running/queued/interrupted stay).
    pub fn clear_finished(&self) -> Result<DownloadStatus, String> {
        let mut i = self
            .inner
            .lock()
            .map_err(|_| "Download state unavailable")?;
        i.jobs
            .retain(|j| !matches!(j.state.as_str(), "succeeded" | "cancelled" | "failed"));
        Self::persist(&mut i);
        Ok(Self::status_of(&i))
    }
    /// Caller holds the lock. Starts the background worker when idle; the batch counters
    /// aggregate every job currently queued.
    fn spawn_worker(&self, i: &mut Inner, auth: AuthState) -> Result<(), String> {
        if i.worker {
            return Ok(());
        }
        i.status = DownloadStatus {
            state: "running".into(),
            completed: i
                .jobs
                .iter()
                .filter(|j| j.state == "queued")
                .map(|j| j.completed)
                .sum(),
            total: i
                .jobs
                .iter()
                .filter(|j| j.state == "queued")
                .map(|j| j.resources.len())
                .sum(),
            bytes_downloaded: 0,
            error: None,
            bytes_placed: i
                .jobs
                .iter()
                .filter(|j| j.state == "queued")
                .map(|j| j.bytes_placed)
                .sum(),
            total_bytes: i
                .jobs
                .iter()
                .filter(|j| j.state == "queued")
                .map(|j| j.total_bytes)
                .sum(),
            jobs: i.jobs.clone(),
        };
        i.cancel = Arc::new(AtomicBool::new(false));
        let cancel = i.cancel.clone();
        i.worker = true;
        let engine = self.clone();
        let spawned = std::thread::Builder::new()
            .name("deas-download".into())
            .spawn(move || engine.worker_loop(cancel, auth));
        if spawned.is_err() {
            i.worker = false;
            i.status.state = "failed".into();
            i.status.error = Some("Cannot start download worker".into());
            for j in &mut i.jobs {
                if j.state == "queued" {
                    j.state = "interrupted".into();
                }
            }
            return Err("Cannot start download worker".to_string());
        }
        Ok(())
    }
    fn worker_loop(&self, cancel: Arc<AtomicBool>, auth: AuthState) {
        let mut outcome = "succeeded";
        let mut failure: Option<String> = None;
        loop {
            let mut i = match self.inner.lock() {
                Ok(i) => i,
                Err(_) => return,
            };
            if cancel.load(Ordering::SeqCst) {
                outcome = "cancelled";
            }
            let idx = i.jobs.iter().position(|j| j.state == "queued");
            let Some(idx) = idx.filter(|_| outcome != "cancelled") else {
                i.worker = false;
                i.status.state = outcome.into();
                i.status.error = failure.clone();
                Self::persist(&mut i);
                return;
            };
            let mut job = i.jobs[idx].clone();
            job.state = "running".into();
            job.error = None;
            job.current_file = None;
            // bytes_placed already reflects persisted progress (completed files and kept
            // partial bytes); transfer() adds newly streamed bytes and removes truncated ones.
            i.jobs[idx] = job.clone();
            Self::persist(&mut i);
            drop(i);
            let target = match self.prepare_target(&job) {
                Ok(t) => t,
                Err(e) => {
                    outcome = "failed";
                    failure = Some(e.clone());
                    if let Ok(mut i) = self.inner.lock() {
                        if let Some(j) = i.jobs.iter_mut().find(|j| j.id == job.id) {
                            j.state = "failed".into();
                            j.error = Some(e.clone());
                        }
                        Self::persist(&mut i);
                    }
                    crate::logs::push(
                        crate::logs::Source::Deas,
                        &format!("Downloads: {} could not start: {e}", job.label),
                    );
                    continue;
                }
            };
            let header = match credential(&auth, &job.provider, job.authenticated) {
                Ok(h) => h,
                Err(e) => {
                    outcome = "failed";
                    failure = Some(e.clone());
                    if let Ok(mut i) = self.inner.lock() {
                        if let Some(j) = i.jobs.iter_mut().find(|j| j.id == job.id) {
                            j.state = "failed".into();
                            j.error = Some(e.clone());
                        }
                        Self::persist(&mut i);
                    }
                    crate::logs::push(
                        crate::logs::Source::Deas,
                        &format!("Downloads: {} could not start: {e}", job.label),
                    );
                    continue;
                }
            };
            crate::logs::push(
                crate::logs::Source::Deas,
                &format!(
                    "Downloads: {} file(s) to {}",
                    job.resources.len() - job.completed,
                    job.target
                ),
            );
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| "Cannot start network runtime".to_string())
                .and_then(|rt| rt.block_on(self.run_job(&job, &target, header, &cancel)));
            let mut i = match self.inner.lock() {
                Ok(i) => i,
                Err(_) => return,
            };
            if let Some(j) = i.jobs.iter_mut().find(|j| j.id == job.id) {
                match &result {
                    Ok(()) => {
                        j.state = "succeeded".into();
                        j.current_file = None;
                        j.error = None;
                    }
                    Err(msg) => {
                        if cancel.load(Ordering::SeqCst) {
                            j.state = "cancelled".into();
                            outcome = "cancelled";
                        } else {
                            j.state = "failed".into();
                            j.error = Some(msg.clone());
                            outcome = "failed";
                            failure = Some(msg.clone());
                        }
                        j.current_file = None;
                    }
                }
            }
            Self::persist(&mut i);
            drop(i);
            match &result {
                Ok(()) => crate::logs::push(
                    crate::logs::Source::Deas,
                    &format!("Downloads: {} finished.", job.label),
                ),
                Err(_) if cancel.load(Ordering::SeqCst) => crate::logs::push(
                    crate::logs::Source::Deas,
                    &format!("Downloads: {} cancelled; partial files kept for resume.", job.label),
                ),
                Err(msg) => crate::logs::push(
                    crate::logs::Source::Deas,
                    &format!("Downloads: {} failed: {msg}", job.label),
                ),
            }
        }
    }
    /// Anchor the parent, re-check its identity and open or create the destination leaf.
    /// A leaf that already exists is only reused when it carries this job's marker.
    fn prepare_target(&self, job: &DownloadJob) -> Result<fs::Anchor, String> {
        let parent = PathBuf::from(&job.parent_path);
        let anchor = fs::Anchor::open(&parent)?;
        if job.folder_name.is_empty() {
            anchor.writable()?;
            return Ok(anchor);
        }
        match anchor.absent(&job.folder_name) {
            Ok(()) => {
                let target = anchor.create(&job.folder_name)?;
                let marker = serde_json::to_vec(&JobMarker { id: job.id.clone() })
                    .map_err(|_| "Cannot write folder marker".to_string())?;
                std::fs::write(parent.join(&job.folder_name).join(JOB_MARKER), marker)
                    .map_err(|_| "Cannot write folder marker".to_string())?;
                Ok(target)
            }
            Err(e) => {
                let leaf = parent.join(&job.folder_name);
                let owned = std::fs::read(leaf.join(JOB_MARKER))
                    .ok()
                    .and_then(|b| {
                        serde_json::from_str::<JobMarker>(&String::from_utf8_lossy(&b)).ok()
                    })
                    .is_some_and(|m| m.id == job.id);
                if !owned {
                    return Err(e);
                }
                let open = fs::Anchor::open(&leaf)?;
                open.writable()?;
                Ok(open)
            }
        }
    }
    /// One queue job: every remaining resource, then the folder manifest.
    async fn run_job(
        &self,
        job: &DownloadJob,
        target: &fs::Anchor,
        header: Option<HeaderValue>,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let client = client_for(false, None)?;
        for r in &job.resources {
            self.transfer(
                r,
                target,
                &TransferRun {
                    provider: &job.provider,
                    client: &client,
                    header: header.clone(),
                    cancel,
                    job_id: &job.id,
                },
            )
            .await?;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("Download cancelled".into());
        }
        if job.folder_name.is_empty() {
            return Ok(()); // shared model folders get no manifest, add per-file sidecars when provenance is needed
        }
        let name = format!("deas-{}.partial", uuid::Uuid::new_v4());
        let result = (|| {
            let mut file = target.partial(&name)?;
            let manifest = serde_json::json!({"version":1,"providerId":job.provider.id,"sourceOrigin":job.provider.origin,"plan":{"id":job.id,"target":job.target,"resources":job.resources,"totalKnownBytes":job.total_bytes,"unknownSizeCount":job.resources.iter().filter(|r| r.size.is_none()).count(),"warnings":[],"canExecute":true}});
            serde_json::to_writer_pretty(&mut file, &manifest)
                .map_err(|_| "Cannot write staged metadata")?;
            file.sync_all().map_err(|_| "Cannot sync staged metadata")?;
            target.publish(&name, "deas-download-manifest.json")
        })();
        target.remove_partial(&name);
        result?;
        let _ = std::fs::remove_file(
            PathBuf::from(&job.parent_path)
                .join(&job.folder_name)
                .join(JOB_MARKER),
        );
        Ok(())
    }
    /// Small locked progress update for one queue job and the aggregate batch counters.
    fn progress(&self, job_id: &str, placed: i64, transferred: i64) {
        let Ok(mut i) = self.inner.lock() else { return };
        i.status.bytes_downloaded = (i.status.bytes_downloaded as i64 + transferred).max(0) as u64;
        i.status.bytes_placed = (i.status.bytes_placed as i64 + placed).max(0) as u64;
        if let Some(j) = i.jobs.iter_mut().find(|j| j.id == job_id) {
            j.bytes_placed = (j.bytes_placed as i64 + placed).max(0) as u64;
        }
        if i.last_persist.elapsed() > Duration::from_secs(2) {
            Self::persist(&mut i);
        }
    }
    fn touch_job(&self, job_id: &str, current_file: Option<String>) {
        if let Ok(mut i) = self.inner.lock() {
            if let Some(j) = i.jobs.iter_mut().find(|j| j.id == job_id) {
                j.current_file = current_file;
            }
        }
    }
    /// One resource. A persisted partial resumes only when the catalog pins size and hash,
    /// so a changed remote file cannot be appended silently; verification decides the retry.
    async fn transfer(
        &self,
        r: &Resource,
        target: &fs::Anchor,
        run: &TransferRun<'_>,
    ) -> Result<(), String> {
        let provider = run.provider;
        let client = run.client;
        let cancel = run.cancel;
        let job_id = run.job_id;
        let file_name = providers::filename(r)?;
        let name = format!("deas-{file_name}.partial");
        for attempt in 0..2 {
            let resumable = attempt == 0 && r.size.is_some() && r.sha256.is_some();
            let (mut file, mut count) = if resumable {
                match target.resume_partial(&name)? {
                    Some(kept) => kept,
                    None => (target.partial(&name)?, 0),
                }
            } else {
                target.remove_partial(&name);
                (target.partial(&name)?, 0)
            };
            // Bytes kept by a resumed partial are already accounted for in job.bytes_placed
            // (persisted while they streamed); a discarded or truncated partial must remove them.
            let kept = count;
            let mut attempt_placed = 0;
            self.touch_job(job_id, Some(file_name.clone()));
            let mut digest = Sha256::new();
            // shortcut: a resume re-reads the kept bytes (a 25 GB file costs 1–2 min); persist a
            // rolling hash only when resumes get frequent.
            if count > 0 {
                let mut buf = vec![0; 1 << 20];
                loop {
                    let n = std::io::Read::read(&mut file, &mut buf)
                        .map_err(|_| "Cannot read partial")?;
                    if n == 0 {
                        break;
                    }
                    digest.update(&buf[..n]);
                }
            }
            let mut length = None;
            let mut start = count;
            // A kept partial that already holds the whole file (a crash before publish) needs no request.
            if !r.size.is_some_and(|n| n == count) {
                let mut response = fetch(
                    client,
                    provider,
                    r.url.as_deref().ok_or("Missing download URL")?,
                    run.header.clone(),
                    cancel,
                    (count > 0).then_some(count),
                )
                .await?;
                length = response.content_length();
                if length.is_some_and(|n| n.saturating_add(count) > MAX_FILE_BYTES) {
                    return Err("Content-Length exceeds the 128 GiB limit".into());
                }
                if count > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                    // The slice must start where the kept bytes end, or it cannot be appended.
                    let from = response
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|s| s.to_str().ok())
                        .and_then(|s| s.strip_prefix("bytes "))
                        .and_then(|s| s.split('-').next())
                        .and_then(|s| s.parse::<u64>().ok());
                    if from != Some(count) {
                        target.remove_partial(&name);
                        self.progress(job_id, -((kept + attempt_placed) as i64), 0);
                        return Err("Resume range mismatch".into());
                    }
                } else if count > 0 {
                    // 200: the server ignored Range and sent the whole file again.
                    self.progress(job_id, -((kept + attempt_placed) as i64), 0);
                    attempt_placed = 0;
                    file.set_len(0).map_err(|_| "Cannot reset partial")?;
                    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0))
                        .map_err(|_| "Cannot reset partial")?;
                    digest = Sha256::new();
                    count = 0;
                }
                start = count;
                loop {
                    let chunk = cancellable(response.chunk(), cancel, 30)
                        .await?
                        .map_err(|_| network_error())?;
                    let Some(chunk) = chunk else { break };
                    count += chunk.len() as u64;
                    {
                        let i = self
                            .inner
                            .lock()
                            .map_err(|_| "Download state unavailable")?;
                        if i.status.bytes_downloaded.saturating_add(chunk.len() as u64)
                            > MAX_JOB_BYTES
                        {
                            return Err("Job exceeds the 256 GiB limit".into());
                        }
                    }
                    self.progress(job_id, chunk.len() as i64, chunk.len() as i64);
                    attempt_placed += chunk.len() as u64;
                    if r.size.is_some_and(|n| count > n) {
                        return Err("Download exceeds declared size".into());
                    }
                    digest.update(&chunk);
                    std::io::Write::write_all(&mut file, &chunk)
                        .map_err(|_| "Cannot write partial")?;
                }
            }
            if r.size.is_some_and(|n| n != count) || length.is_some_and(|n| start + n != count) {
                target.remove_partial(&name);
                self.progress(job_id, -((kept + attempt_placed) as i64), 0);
                // Only a resumed prefix can fail verification (the remote file changed): retry clean.
                if start > 0 {
                    continue;
                }
                return Err("Download size mismatch".into());
            }
            let actual = format!("{:x}", digest.finalize());
            if r.sha256
                .as_ref()
                .is_some_and(|s| !s.eq_ignore_ascii_case(&actual))
            {
                target.remove_partial(&name);
                self.progress(job_id, -((kept + attempt_placed) as i64), 0);
                if start > 0 {
                    continue;
                }
                return Err("SHA-256 mismatch; partial discarded".into());
            }
            if cancel.load(Ordering::SeqCst) {
                return Err("Download cancelled".into());
            }
            file.sync_all().map_err(|_| "Cannot sync partial")?;
            target.publish(&name, &file_name)?;
            let mut i = self
                .inner
                .lock()
                .map_err(|_| "Download state unavailable")?;
            i.status.completed += 1;
            if let Some(j) = i.jobs.iter_mut().find(|j| j.id == job_id) {
                j.completed += 1;
                j.current_file = None;
            }
            return Ok(());
        }
        Ok(())
    }
}
fn source_url(p: &Provider, s: &str) -> Result<Url, String> {
    let u = validate_url(s, false, p.kind == "civitai")?;
    if p.kind == "civitai"
        && u.query_pairs().any(|(k, v)| {
            !matches!(k.as_ref(), "type" | "format" | "size" | "fp" | "fileId")
                || (k == "fileId" && !v.bytes().all(|b| b.is_ascii_digit()))
                || v.len() > 80
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'-' | b'_'))
        })
    {
        return Err("Unsupported CivitAI file selector query".into());
    }
    Ok(u)
}
fn validate_resource(p: &Provider, r: &Resource) -> Result<(), String> {
    bounded_text(&r.id, 2048)?;
    bounded_text(&r.label, 240)?;
    if let Some(date) = &r.published_at {
        bounded_text(date, 64)?;
    }
    if let Some(version) = &r.version {
        bounded_text(version, 240)?;
    }
    if let Some(variant) = &r.variant {
        bounded_text(variant, 240)?;
    }
    validate_kind(&r.kind)?;
    validate_metadata(
        r.sha256.as_deref(),
        r.license.as_deref(),
        if r.downloadable { r.size } else { None },
    )?;
    if let Some(s) = &r.locator {
        bounded_text(s, 4096)?;
    }
    if let Some(s) = &r.preview {
        validate_url(s, false, true)?;
    }
    if let Some(s) = &r.category {
        safe_name(s)?;
    }
    if r.downloadable {
        if p.kind == "ollama" || r.kind == "repo" {
            return Err("Read-only identity cannot be downloaded".into());
        }
        let u = source_url(p, r.url.as_deref().ok_or("Missing URL")?)?;
        let origin = u.origin().ascii_serialization();
        let allowed = match p.kind.as_str() {
            "github" => origin == p.origin || origin == "https://raw.githubusercontent.com",
            "http" | "huggingface" | "civitai" => origin == p.origin,
            _ => false,
        };
        if !allowed {
            return Err("Resource source outside adapter authority".into());
        }
        safe_name(&providers::filename(r)?)?;
    }
    Ok(())
}
async fn cancellable<F: std::future::Future>(
    future: F,
    cancel: &AtomicBool,
    seconds: u64,
) -> Result<F::Output, String> {
    tokio::pin!(future);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Download cancelled".into());
        }
        tokio::select! {v=&mut future=>return Ok(v),_=tokio::time::sleep_until(deadline)=>return Err("Network operation timed out".into()),_=tokio::time::sleep(Duration::from_millis(100))=>{}}
    }
}
async fn fetch(
    client: &reqwest::Client,
    p: &Provider,
    input: &str,
    header: Option<HeaderValue>,
    cancel: &AtomicBool,
    range: Option<u64>,
) -> Result<reqwest::Response, String> {
    let mut url = source_url(p, input)?;
    let mut authorized = url.origin().ascii_serialization() == p.origin;
    for hop in 0..=5 {
        let mut request = client.get(url.clone());
        if let Some(from) = range {
            request = request.header(reqwest::header::RANGE, format!("bytes={from}-"));
        }
        if p.kind == "github" && url.origin().ascii_serialization() == p.origin {
            request = request.header(reqwest::header::ACCEPT, "application/vnd.github.raw+json");
        }
        if authorized {
            if let Some(h) = &header {
                request = request.header(reqwest::header::AUTHORIZATION, h.clone());
            }
        }
        let response = cancellable(request.send(), cancel, 30)
            .await?
            .map_err(|_| network_error())?;
        if response.status().is_redirection() {
            if hop == 5 {
                return Err("Redirect limit exceeded".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|s| s.to_str().ok())
                .ok_or("Invalid redirect")?;
            let next = validate_url(
                url.join(location).map_err(|_| "Invalid redirect")?.as_str(),
                false,
                true,
            )?;
            // A hop off the originally authorized origin permanently strips credentials,
            // including if the server later redirects back to that origin.
            if next.origin() != url.origin() {
                authorized = false;
            }
            url = next;
            continue;
        }
        if response.status() != reqwest::StatusCode::OK
            && !(range.is_some() && response.status() == reqwest::StatusCode::PARTIAL_CONTENT)
        {
            return Err(format!(
                "Provider returned HTTP {}; check gating, license and rate limits",
                response.status().as_u16()
            ));
        }
        return Ok(response);
    }
    Err("Redirect limit exceeded".into())
}
#[tauri::command]
pub fn native_download_catalog(
    engine: tauri::State<'_, DownloadEngine>,
) -> Result<Catalog, String> {
    engine.catalog()
}
#[tauri::command]
pub fn native_download_import_catalog(
    engine: tauri::State<'_, DownloadEngine>,
    text: String,
) -> Result<Catalog, String> {
    engine.import(text)
}
#[tauri::command]
pub async fn native_download_browse(
    engine: tauri::State<'_, DownloadEngine>,
    auth: tauri::State<'_, AuthState>,
    request: BrowseRequest,
) -> Result<Listing, String> {
    engine.browse(request, &auth).await
}
#[tauri::command]
pub fn native_download_plan(
    engine: tauri::State<'_, DownloadEngine>,
    request: PlanRequest,
) -> Result<DownloadPlan, String> {
    engine.plan(request)
}
#[tauri::command]
pub fn native_download_start(
    engine: tauri::State<'_, DownloadEngine>,
    auth: tauri::State<'_, AuthState>,
    plan_id: String,
    confirmed: bool,
    operations: tauri::State<'_, crate::FolderOperations>,
) -> Result<DownloadStatus, String> {
    let _guard = operations.enter()?;
    engine.start(plan_id, confirmed, &auth)
}
/// Enqueue several planned folder groups as one background queue.
#[tauri::command]
pub fn native_download_start_queue(
    engine: tauri::State<'_, DownloadEngine>,
    auth: tauri::State<'_, AuthState>,
    plan_ids: Vec<String>,
    confirmed: bool,
    operations: tauri::State<'_, crate::FolderOperations>,
) -> Result<DownloadStatus, String> {
    let _guard = operations.enter()?;
    engine.enqueue(plan_ids, confirmed, &auth)
}
/// Resume interrupted, cancelled or failed queue jobs (None resumes every one).
#[tauri::command]
pub fn native_download_resume(
    engine: tauri::State<'_, DownloadEngine>,
    auth: tauri::State<'_, AuthState>,
    job_ids: Option<Vec<String>>,
) -> Result<DownloadStatus, String> {
    engine.resume(job_ids, &auth)
}
/// Forget finished queue entries; running and resumable entries stay listed.
#[tauri::command]
pub fn native_download_clear_queue(
    engine: tauri::State<'_, DownloadEngine>,
) -> Result<DownloadStatus, String> {
    engine.clear_finished()
}
#[tauri::command]
pub fn native_download_status(
    engine: tauri::State<'_, DownloadEngine>,
) -> Result<DownloadStatus, String> {
    engine.status()
}
#[tauri::command]
pub fn native_download_cancel(
    engine: tauri::State<'_, DownloadEngine>,
) -> Result<DownloadStatus, String> {
    engine.cancel()
}
