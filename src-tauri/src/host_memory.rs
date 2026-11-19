//! P-02 host memory admission: estimate what a job will hold in system RAM before starting it.
//!
//! The reported incident (2026-11-15, 362-frame H3 Hi-Res 2K) ended with the operating system
//! killing DEAS's whole process group at a 48.1 GB peak. Measured on 2026-11-19 with the bounded
//! streaming path ON (`docs/VERIFICATION.md#p-02-residency-verdict`): backend RSS 43.04 GiB, of
//! which ~99 % is private anonymous memory - the model files the graph names total 42.54 GiB -
//! and the full float32 RGB batches never appeared. With the bounded path OFF the same job adds
//! the baseline (2.763 GiB) and processed (10.626 GiB) RGB results on top of the weights.
//!
//! So the estimate is: distinct model files named by the compiled graph, plus the pixel batches
//! the selected path will materialize. `DEAS_HOST_MEMORY_ADMISSION=off|warn|block` (default
//! `block`) is the operator override; there is deliberately no Studio control for it, because a
//! refusal that the user can silently disable is not an admission check.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const GIB: u64 = 1 << 30;

/// Floor of headroom kept below "available" before refusing. It scales with the job: the
/// reference host's guard (earlyoom -m 5) kills below ~3 GiB free, so a small job on a busy
/// desktop must still be allowed, while a 44 GiB job needs gigabytes of slack for the decoder
/// workspace and page-cache churn the estimate cannot see.
pub(crate) const MARGIN_MIN_BYTES: u64 = 2 * GIB;

/// Headroom for an estimate: a fixed floor plus a tenth of the estimate itself.
pub(crate) fn margin(need_bytes: u64) -> u64 {
    need_bytes / 10 + MARGIN_MIN_BYTES
}

// Measured extra anonymous RAM for the bounded H3 decode-to-encoder path was ~1.1 GiB
// (43.6 GiB growth against 42.54 GiB of model files); this allowance rounds that up.
const BOUNDED_ALLOWANCE_BYTES: u64 = 2 * GIB;

/// Model extensions that ComfyUI loads into host RAM. Anything else in the graph (paths to
/// images, scripts, presets) is ignored.
const MODEL_SUFFIXES: &[&str] = &[
    ".safetensors",
    ".gguf",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".sft",
    ".onnx",
];

#[derive(Debug, Clone, Default)]
pub(crate) struct Footprint {
    /// Distinct model files resolved in DEAS's model roots, counted once each.
    pub model_bytes: u64,
    pub model_files: usize,
    /// Model names the graph referenced but that were not found in the roots; they are not counted.
    pub unresolved_models: usize,
    /// Full-frame float32 RGB results the selected path materializes (0 when bounded).
    pub pixel_bytes: u64,
    /// True when the bounded decode-to-encoder path was selected for this job.
    pub bounded_decode: bool,
}

impl Footprint {
    pub(crate) fn total_bytes(&self) -> u64 {
        self.model_bytes
            .saturating_add(self.pixel_bytes)
            .saturating_add(if self.bounded_decode {
                BOUNDED_ALLOWANCE_BYTES
            } else {
                0
            })
    }
}

fn gib(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / GIB as f64)
}

/// Walk the compiled graph and collect every string that looks like a model reference.
fn model_names(graph: &Value, out: &mut BTreeSet<String>) {
    match graph {
        Value::String(text) => {
            let lower = text.to_ascii_lowercase();
            if MODEL_SUFFIXES.iter().any(|s| lower.ends_with(s)) && !text.contains('\n') {
                out.insert(text.clone());
            }
        }
        Value::Array(items) => items.iter().for_each(|item| model_names(item, out)),
        Value::Object(map) => map.values().for_each(|item| model_names(item, out)),
        _ => {}
    }
}

/// Name -> (path, size) for files under `root`, used only when `root.join(name)` misses.
/// Bounded on purpose: a model root is a category tree, not the whole disk.
fn index(root: &Path) -> BTreeMap<String, (PathBuf, u64)> {
    let mut found = BTreeMap::new();
    // Depth is per directory, not per pop: a category root has one level per category and then
    // author subfolders, and a global pop counter would silently stop after the first few.
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        if depth > 6 || found.len() >= 4000 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push_back((path, depth + 1));
                continue;
            }
            let Some(size) = entry.metadata().ok().map(|m| m.len()) else {
                continue;
            };
            if path.file_name().and_then(|n| n.to_str()).is_some_and(|name| {
                MODEL_SUFFIXES
                    .iter()
                    .any(|s| name.to_ascii_lowercase().ends_with(s))
            }) {
                found.insert(
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_owned(),
                    (path, size),
                );
            }
        }
    }
    found
}

pub(crate) fn footprint(graph: &Value, intent: &Value, roots: &[PathBuf]) -> Footprint {
    let mut names = BTreeSet::new();
    model_names(graph, &mut names);
    let mut counted: BTreeSet<PathBuf> = BTreeSet::new();
    let mut bytes = 0u64;
    let mut unresolved = 0usize;
    // One shallow listing per root, reused for every name that misses the direct join.
    let mut indexes: BTreeMap<PathBuf, BTreeMap<String, (PathBuf, u64)>> = BTreeMap::new();
    for name in names {
        let mut hit: Option<(PathBuf, u64)> = None;
        for root in roots {
            let direct = root.join(&name);
            if let Ok(meta) = std::fs::metadata(&direct) {
                hit = Some((direct, meta.len()));
                break;
            }
            let file_name = Path::new(&name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_owned();
            let listing = indexes.entry(root.clone()).or_insert_with(|| index(root));
            if let Some(pair) = listing.get(&file_name).cloned() {
                hit = Some(pair);
                break;
            }
        }
        match hit {
            // Count once even if several nodes load the same file (the common H3 case).
            Some((path, size)) => {
                if counted.insert(path) {
                    bytes = bytes.saturating_add(size);
                }
            }
            None => unresolved += 1,
        }
    }
    let bounded = bounded_path(intent);
    Footprint {
        model_bytes: bytes,
        model_files: counted.len(),
        unresolved_models: unresolved,
        pixel_bytes: if bounded {
            0
        } else {
            pixel_batches(intent)
        },
        bounded_decode: bounded,
    }
}

/// The bounded path is the DEAS-owned fused stock-H3 decoder/saver, selected by `streamDecode`
/// (its own validation refuses it outside H3 latent upscale/regenerate).
fn bounded_path(intent: &Value) -> bool {
    intent["streamDecode"] == Value::Bool(true)
}

/// Full-frame float32 RGB results: the baseline decode plus the post-upscale/Hi-Res decode.
/// Matches the incident case exactly: 362 f at 736x928 = 2.763 GiB, at 1440x1824 = 10.626 GiB.
fn pixel_batches(intent: &Value) -> u64 {
    if !crate::jobs_video::is_video(intent) {
        return 0;
    }
    let frames = intent["frames"].as_u64().unwrap_or(0);
    let width = intent["width"].as_u64().unwrap_or(0);
    let height = intent["height"].as_u64().unwrap_or(0);
    if frames == 0 || width == 0 || height == 0 {
        return 0;
    }
    let batch = |w: u64, h: u64| frames.saturating_mul(w).saturating_mul(h).saturating_mul(12);
    let mut total = batch(width, height);
    if intent.get("latentUpscale").is_some() {
        let (up_w, up_h) = crate::jobs_video::latent_upscale_size(intent);
        if up_w > 0 && up_h > 0 {
            total = total.saturating_add(batch(up_w, up_h));
        }
    }
    total
}

/// Free RAM/swap as the operating system reports it right now.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Headroom {
    pub available_bytes: u64,
    pub total_bytes: u64,
    pub swap_free_bytes: u64,
    pub swap_total_bytes: u64,
}

pub(crate) fn headroom() -> Option<Headroom> {
    #[cfg(test)]
    {
        // Unit tests must not depend on how much RAM the developer's desktop happens to be using:
        // a submission that failed only because a browser was open would be a permanent flake.
        // So tests see a fixed mid-range 64 GiB host: every real test fixture (bytes to a few GiB)
        // passes, while a fixture built to 2 TiB (jobs_model_tests' huge_declaration) is refused.
        // The decision boundary itself is tested directly through `admission_with`, which takes
        // headroom as an argument.
        return Some(Headroom {
            available_bytes: 60 * GIB,
            total_bytes: 64 * GIB,
            swap_free_bytes: 8 * GIB,
            swap_total_bytes: 64 * GIB,
        });
    }
    #[cfg(not(test))]
    {
        let (ram, swap) = crate::monitoring::memory();
        let ram = ram?;
        Some(Headroom {
            available_bytes: ram.total.saturating_sub(ram.used),
            total_bytes: ram.total,
            swap_free_bytes: swap.as_ref().map_or(0, |s| s.total.saturating_sub(s.used)),
            swap_total_bytes: swap.as_ref().map_or(0, |s| s.total),
        })
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum Decision {
    Proceed,
    /// Within the estimate but under the margin: start, and say so in Logs.
    Tight(String),
    /// Refuse to start; the OS guard would take the backend (and usually DEAS) mid-run.
    Refused(String),
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Mode {
    Off,
    Warn,
    Block,
}

fn mode() -> Mode {
    match std::env::var("DEAS_HOST_MEMORY_ADMISSION")
        .unwrap_or_default()
        .as_str()
    {
        "off" => Mode::Off,
        "warn" => Mode::Warn,
        _ => Mode::Block,
    }
}

/// Live check: current headroom, configured mode.
pub(crate) fn admission(graph: &Value, intent: &Value, roots: &[PathBuf]) -> Decision {
    admission_with(mode(), headroom(), graph, intent, roots)
}

/// The check itself: headroom and mode are arguments, so the decision boundary is testable on any
/// machine and the production call only supplies the two live inputs.
pub(crate) fn admission_with(
    mode: Mode,
    available: Option<Headroom>,
    graph: &Value,
    intent: &Value,
    roots: &[PathBuf],
) -> Decision {
    if mode == Mode::Off {
        return Decision::Proceed;
    }
    let Some(available) = available else {
        return Decision::Proceed;
    };
    let estimate = footprint(graph, intent, roots);
    if estimate.model_files == 0 && estimate.pixel_bytes == 0 {
        // Nothing was resolved (external backend, unusual graph): never invent a refusal.
        return Decision::Proceed;
    }
    let need = estimate.total_bytes();
    let free = available.available_bytes;
    if need.saturating_add(margin(need)) <= free {
        return Decision::Proceed;
    }
    let path = if estimate.bounded_decode {
        "streaming decode (bounded pixel buffers)".to_owned()
    } else {
        "full-frame decode buffers".to_owned()
    };
    let mut detail = format!(
        "estimated need {} GiB system RAM ({} GiB in {} model files + {} GiB {}), {} GiB available of {} GiB",
        gib(need),
        gib(estimate.model_bytes),
        estimate.model_files,
        gib(estimate.pixel_bytes),
        path,
        gib(free),
        gib(available.total_bytes)
    );
    if estimate.unresolved_models > 0 {
        detail.push_str(&format!(
            ", {} model reference(s) not found in the model folders and not counted",
            estimate.unresolved_models
        ));
    }
    if available.swap_total_bytes > 0 {
        detail.push_str(&format!(
            "; page file/swap {:.1} GiB free of {}",
            gib(available.swap_free_bytes),
            gib(available.swap_total_bytes)
        ));
    }
    if !estimate.bounded_decode && crate::jobs_video::is_video(intent) && crate::jobs_video::h3_stream_candidate(intent) {
        detail.push_str(". Turning on Streaming decode keeps the pixel buffers out of RAM for this job");
    }
    let message = format!("HOST_MEMORY: {detail}");
    if mode == Mode::Warn {
        return Decision::Tight(format!("{message}. Started anyway (DEAS_HOST_MEMORY_ADMISSION=warn); the system may still kill the backend"));
    }
    Decision::Refused(format!(
        "{message}. DEAS did not start this job: at this level the operating system's memory guard kills the backend \
         mid-run, which is how the reported failure looked. Close memory-heavy programs (other GPU apps, browsers, \
         local models), turn on Streaming decode where it is offered, or lower the canvas/duration. \
         DEAS_HOST_MEMORY_ADMISSION=warn starts anyway."
    ))
}

/// One line for central Logs whether the job started or not.
pub(crate) fn log_line(decision: &Decision) -> Option<&str> {
    match decision {
        Decision::Proceed => None,
        Decision::Tight(text) | Decision::Refused(text) => Some(text.as_str()),
    }
}

#[cfg(test)]
#[path = "host_memory_tests.rs"]
mod host_memory_tests;
