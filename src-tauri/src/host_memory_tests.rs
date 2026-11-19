//! Host memory admission tests. The regression anchor is the measured 2026-11-19 incident case
//! (docs/VERIFICATION.md#p-02-residency-verdict): 42.54 GiB of model files, +43.6 GiB measured
//! growth with streaming ON, and the pixel buffers the non-streaming path adds on top.

use super::*;
use serde_json::json;
use std::path::{Path, PathBuf};

const GIB_F: f64 = 1024.0 * 1024.0 * 1024.0;

fn gib(bytes: u64) -> f64 {
    bytes as f64 / GIB_F
}

/// Sparse files: the apparent size is what the estimator reads, and nothing hits the disk.
/// Sparse files: the apparent size is what the estimator reads, and nothing hits the disk.
fn sparse(dir: &Path, name: &str, len: u64) -> u64 {
    if let Some(parent) = Path::new(name).parent() {
        std::fs::create_dir_all(dir.join(parent)).unwrap();
    }
    let path = dir.join(name);
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(len).unwrap();
    len
}

fn headroom(available_gib: f64) -> Option<Headroom> {
    Some(Headroom {
        available_bytes: (available_gib * GIB_F) as u64,
        total_bytes: (61.7 * GIB_F) as u64,
        swap_free_bytes: (90.0 * GIB_F) as u64,
        swap_total_bytes: (94.8 * GIB_F) as u64,
    })
}

/// The six files the reported H3 Hi-Res 2K job loads, at their exact on-disk byte counts from
/// the reference library (42.54 GiB total, measured 2026-11-19). Graph names are written the way
/// ComfyUI lists them - category-relative - so the resolver must find them under the category
/// folders, which is what the reference layout does.
const INCIDENT_MODELS: [(&str, &str, u64); 6] = [
    (
        "MiniMaxH3/dasiwa_minimax_h3_ref2va_v5xs_pruned_graviton_turbo_int8_row-wise_convrot_runtime_mixed.safetensors",
        "diffusion_models/MiniMaxH3/dasiwa_minimax_h3_ref2va_v5xs_pruned_graviton_turbo_int8_row-wise_convrot_runtime_mixed.safetensors",
        20_967_669_120,
    ),
    (
        "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        15_687_142_551,
    ),
    (
        "MiniMaxH3/minimax_h3_video_vae_fp16.safetensors",
        "vae/MiniMaxH3/minimax_h3_video_vae_fp16.safetensors",
        5_207_808_496,
    ),
    (
        "MiniMaxH3/open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors",
        "loras/MiniMaxH3/open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors",
        2_521_307_384,
    ),
    (
        "minimax_h3_latent_upscale_3d_conv_v1_bf16.safetensors",
        "latent_upscale_models/minimax_h3_latent_upscale_3d_conv_v1_bf16.safetensors",
        690_592_992,
    ),
    (
        "MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors",
        "vae/MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors",
        605_254_808,
    ),
];
const INCIDENT_TOTAL: u64 = 45_679_775_351;

fn incident_graph() -> serde_json::Value {
    json!({
        "1": {"class_type":"CheckpointLoaderSimple","widgets_values":[INCIDENT_MODELS[0].0]},
        "2": {"class_type":"CLIPLoader","inputs":{"clip_name":INCIDENT_MODELS[1].0}},
        "3": {"class_type":"VAELoader","inputs":{"vae_name":INCIDENT_MODELS[2].0}},
        "4": {"class_type":"LoraLoader","inputs":{"lora_name":INCIDENT_MODELS[3].0}},
        "5": {"class_type":"DAESIWAH3LatentUpscale","inputs":{"model":INCIDENT_MODELS[4].0}},
        "6": {"class_type":"VAELoader","inputs":{"vae_name":INCIDENT_MODELS[5].0}},
        // The same text encoder loaded by a second node must not count twice.
        "7": {"class_type":"ConditioningAdvanced","inputs":{"clip":INCIDENT_MODELS[1].0}},
        "8": {"class_type":"SaveVideo","inputs":{"filename_prefix":"acceptance/session"}},
        "9": {"class_type":"LoadImage","inputs":{"image":"reference/acceptance-a.png"}}
    })
}

/// The reported job: 362 frames at 736x928, 3D latent upscale to the 1440x1824 2K target.
fn incident_intent(stream: bool) -> serde_json::Value {
    let mut intent = json!({
        "recipeId": "video-generation", "family": "minimax-h3", "version": 1.0,
        "frames": 362, "frameRate": 24, "width": 736, "height": 928,
        "latentUpscale": {"model": INCIDENT_MODELS[4].0, "scale": 1.9565217391304348,
                          "steps": 4, "denoise": 0.4,
                          "advanced": {"spatialTiling": true}},
        "h3": {"continuity": {"outputMode": "full"}},
        "output": {"container": "MP4"}
    });
    if stream {
        intent["streamDecode"] = json!(true);
    }
    intent
}

#[test]
fn incident_model_footprint_counts_each_file_once() {
    let root = tempfile::tempdir().unwrap();
    for &(_, path, size) in &INCIDENT_MODELS {
        sparse(root.path(), path, size);
    }
    let estimate = footprint(
        &incident_graph(),
        &incident_intent(true),
        &[root.path().into()],
    );
    assert_eq!(
        estimate.model_files, 6,
        "the shared text encoder must count once"
    );
    assert_eq!(
        estimate.model_bytes, INCIDENT_TOTAL,
        "must equal the measured 42.54 GiB graph total"
    );
    assert!((gib(estimate.model_bytes) - 42.54).abs() < 0.01);
    assert_eq!(estimate.unresolved_models, 0);
}

#[test]
fn non_streaming_path_estimates_both_pixel_batches() {
    // 362 frames at 736x928 = 2.763 GiB and at 1440x1824 = 10.626 GiB (float32 RGB), the exact
    // numbers recorded for the reported job.
    let expected = 362u64 * 12 * (736 * 928 + 1440 * 1824);
    let estimate = pixel_batches(&incident_intent(false));
    assert_eq!(estimate, expected);
    assert!(
        (gib(estimate) - 13.39).abs() < 0.02,
        "got {} GiB",
        gib(estimate)
    );
}

#[test]
fn streaming_decode_removes_the_pixel_buffers_from_the_estimate() {
    let stream = incident_intent(true);
    assert!(bounded_path(&stream));
    let root = tempfile::tempdir().unwrap();
    let estimate = footprint(&incident_graph(), &stream, &[root.path().into()]);
    assert_eq!(
        estimate.pixel_bytes, 0,
        "the bounded path does not hold full RGB batches"
    );
    assert!(estimate.bounded_decode);
    let plan = incident_intent(false);
    assert!(!bounded_path(&plan));
    assert!(footprint(&incident_graph(), &plan, &[root.path().into()]).pixel_bytes > 0);
}

#[test]
fn the_measured_case_fits_with_streaming_and_does_not_without() {
    // The session that produced the verdict started with 52.9 GiB available.
    let root = tempfile::tempdir().unwrap();
    for &(_, path, size) in &INCIDENT_MODELS {
        sparse(root.path(), path, size);
    }
    let roots: Vec<PathBuf> = vec![root.path().into()];
    let fit = admission_with(
        Mode::Block,
        headroom(52.9),
        &incident_graph(),
        &incident_intent(true),
        &roots,
    );
    assert_eq!(
        fit,
        Decision::Proceed,
        "42.5 GiB + 2 GiB fits under 52.9 GiB"
    );
    let over = admission_with(
        Mode::Block,
        headroom(52.9),
        &incident_graph(),
        &incident_intent(false),
        &roots,
    );
    assert!(
        matches!(over, Decision::Refused(_)),
        "42.5 + 13.4 GiB must not start in 52.9 GiB: {over:?}"
    );
    // The same streaming job on the busy desktop measured in this session (1.4-2.8 GiB free).
    let tight = admission_with(
        Mode::Block,
        headroom(2.8),
        &incident_graph(),
        &incident_intent(true),
        &roots,
    );
    assert!(
        matches!(tight, Decision::Refused(_)),
        "no headroom left at all: {tight:?}"
    );
}

#[test]
fn refusal_says_what_to_change_and_warn_names_the_override() {
    let root = tempfile::tempdir().unwrap();
    for &(_, path, size) in &INCIDENT_MODELS {
        sparse(root.path(), path, size);
    }
    let roots: Vec<PathBuf> = vec![root.path().into()];
    let refused = admission_with(
        Mode::Block,
        headroom(52.9),
        &incident_graph(),
        &incident_intent(false),
        &roots,
    );
    let Decision::Refused(message) = refused else {
        panic!("expected a refusal");
    };
    assert!(message.starts_with("HOST_MEMORY: "));
    assert!(message.contains("full-frame decode buffers"));
    assert!(
        message.contains("Streaming decode"),
        "advice for this job: {message}"
    );
    assert!(message.contains("DEAS_HOST_MEMORY_ADMISSION=warn"));
    assert!(message.contains("page file"));

    let warned = admission_with(
        Mode::Warn,
        headroom(52.9),
        &incident_graph(),
        &incident_intent(false),
        &roots,
    );
    match warned {
        Decision::Tight(text) => assert!(text.contains("Started anyway")),
        other => panic!("warn mode must start with a note: {other:?}"),
    }
    // A job that cannot use the streaming path must not be told to turn it on.
    let image = json!({"recipeId": "image", "family": "illustrious"});
    let Decision::Refused(text) = admission_with(
        Mode::Block,
        headroom(10.0),
        &incident_graph(),
        &image,
        &roots,
    ) else {
        panic!("42.5 GiB of models must not start in 10 GiB");
    };
    assert!(!text.contains("Turn on Streaming decode"), "{text}");
}

#[test]
fn small_jobs_still_start_on_a_pressured_desktop() {
    // Admission must not become a blanket refusal when the desktop, not the job, holds the RAM:
    // a 40 MiB model on a machine with 3.2 GiB free starts. (The first margin implementation used
    // a flat 4 GiB floor and blocked these.)
    let root = tempfile::tempdir().unwrap();
    for &(_, path, size) in &INCIDENT_MODELS {
        sparse(root.path(), path, size);
    }
    sparse(
        root.path(),
        "diffusion_models/tiny.safetensors",
        40 * 1024 * 1024,
    );
    let graph = json!({"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "tiny.safetensors"}}});
    let decision = admission_with(
        Mode::Block,
        headroom(3.2),
        &graph,
        &json!({"recipeId": "image", "family": "illustrious"}),
        &[root.path().into()],
    );
    assert_eq!(decision, Decision::Proceed, "{decision:?}");
    // While the same host cannot hold a 44 GiB model set.
    let big = admission_with(
        Mode::Block,
        headroom(3.2),
        &incident_graph(),
        &incident_intent(true),
        &[root.path().into()],
    );
    assert!(matches!(big, Decision::Refused(_)), "{big:?}");
}

#[test]
fn off_mode_and_unknown_inputs_never_block() {
    let root = tempfile::tempdir().unwrap();
    for &(_, path, size) in &INCIDENT_MODELS {
        sparse(root.path(), path, size);
    }
    let roots: Vec<PathBuf> = vec![root.path().into()];
    assert_eq!(
        admission_with(
            Mode::Off,
            headroom(0.1),
            &incident_graph(),
            &incident_intent(false),
            &roots
        ),
        Decision::Proceed
    );
    assert_eq!(
        admission_with(
            Mode::Block,
            None,
            &incident_graph(),
            &incident_intent(false),
            &roots
        ),
        Decision::Proceed,
        "no RAM reading (unsupported platform) must not invent a refusal"
    );
    // Unresolvable model names (external backend, moved library) must not invent a model number,
    // but the intent's own pixel buffers are still known - 13.4 GiB does not fit in 0.1 GiB.
    let empty_root = tempfile::tempdir().unwrap();
    let unknown = admission_with(
        Mode::Block,
        headroom(0.1),
        &incident_graph(),
        &incident_intent(false),
        &[empty_root.path().into()],
    );
    match unknown {
        Decision::Refused(message) => {
            assert!(message.contains("0 model files"), "{message}");
            assert!(message.contains("not counted"), "{message}");
        }
        other => panic!("13.4 GiB of known staging in 0.1 GiB free: {other:?}"),
    }
    // Nothing estimable at all (no model files, no full-frame staging): never refuse.
    assert_eq!(
        admission_with(
            Mode::Block,
            headroom(0.1),
            &incident_graph(),
            &json!({"recipeId": "image", "family": "illustrious"}),
            &[empty_root.path().into()]
        ),
        Decision::Proceed
    );
}

#[test]
fn model_names_resolve_with_and_without_their_subfolder() {
    let root = tempfile::tempdir().unwrap();
    sparse(
        root.path(),
        "MiniMaxH3/nested.safetensors",
        (3.0 * GIB_F) as u64,
    );
    sparse(
        root.path(),
        "deep/deeper/bare.safetensors",
        (2.0 * GIB_F) as u64,
    );
    let graph = json!({
        "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"MiniMaxH3/nested.safetensors"}},
        "2": {"class_type":"VAELoader","inputs":{"vae_name":"bare.safetensors"}},
        "3": {"class_type":"Note","inputs":{"value":"see notes.md for the recipe"}},
        "4": {"class_type":"Missing","inputs":{"model":"MiniMaxH3/absent.safetensors"}}
    });
    let estimate = footprint(&graph, &json!({"recipeId": "image"}), &[root.path().into()]);
    assert_eq!(estimate.model_files, 2);
    assert!((gib(estimate.model_bytes) - 5.0).abs() < 0.01);
    assert_eq!(
        estimate.unresolved_models, 1,
        "a missing reference must be reported, not guessed"
    );
    assert_eq!(
        estimate.pixel_bytes, 0,
        "image recipes hold no full-frame RGB batch"
    );
    let Decision::Tight(line) = admission_with(
        Mode::Warn,
        headroom(1.0),
        &graph,
        &json!({}),
        &[root.path().into()],
    ) else {
        panic!("1 GiB free with 5 GiB of models must warn");
    };
    assert!(
        line.contains("not found in the model folders and not counted"),
        "{line}"
    );
}
