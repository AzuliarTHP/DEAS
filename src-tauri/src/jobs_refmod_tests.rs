use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const PROMPT: &str = "5f1c3c39-3a37-4c39-9d0d-2bb0e4d4f8a1";

fn request() -> Value {
    json!({"name":"hero","description":"main cast","conceptType":"identity",
        "media":[{"type":"image","file":"deas-inputs/a.png","slot":0,"description":"face"},
                 {"type":"video","file":"deas-input-clip.mp4","slot":0,"mediaMode":"video_audio","trimStart":1.0,"trimEnd":4.0}],
        "refmods":["old/set"],"vae":"MiniMaxH3/video_vae.safetensors","audioVae":"MiniMaxH3/audio_vae.safetensors"})
}

#[test]
fn compiles_one_export_node_with_the_director_item_contract() {
    let g = compile(&request(), "req-1").unwrap();
    assert_eq!(
        g["V"],
        json!({"class_type":"VAELoader","inputs":{"vae_name":"MiniMaxH3/video_vae.safetensors"}})
    );
    assert_eq!(
        g["AV"]["inputs"]["vae_name"],
        "MiniMaxH3/audio_vae.safetensors"
    );
    let x = &g[OUTPUT];
    assert_eq!(x["class_type"], "DaSiWaH3RefModExport");
    assert_eq!(x["inputs"]["request_id"], "req-1");
    assert_eq!(x["inputs"]["name"], "hero");
    assert_eq!(x["inputs"]["concept_type"], "identity");
    assert_eq!(x["inputs"]["vae"], json!(["V", 0]));
    assert_eq!(x["inputs"]["audio_vae"], json!(["AV", 0]));
    let timeline: Value =
        serde_json::from_str(x["inputs"]["timeline_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        timeline,
        json!({"items":[
            {"id":"m0","type":"image","value":"deas-inputs/a.png","enabled":true,"description":"face"},
            {"id":"m1","type":"video","value":"deas-input-clip.mp4","enabled":true,"description":"","media_mode":"video_audio","trim_start":1.0,"trim_end":4.0}],
            "refmods":[{"name":"old/set"}]})
    );
    assert_eq!(g.as_object().unwrap().len(), 3);
}

#[test]
fn loads_only_the_vaes_the_selection_needs() {
    let mut r = request();
    r["media"] = json!([{"type":"image","file":"deas-inputs/a.png","slot":0}]);
    r.as_object_mut().unwrap().remove("audioVae");
    let g = compile(&r, "x").unwrap();
    assert!(g.get("AV").is_none() && g[OUTPUT]["inputs"].get("audio_vae").is_none());
    r["media"] = json!([{"type":"audio","file":"deas-inputs/v.wav","slot":0}]);
    assert_eq!(
        compile(&r, "x").unwrap_err(),
        "Audio references need the MiniMax H3 audio VAE"
    );
    r["media"] = json!([]);
    r.as_object_mut().unwrap().remove("vae");
    // Saved RefMods only: already encoded, no VAE at all.
    let g = compile(&r, "x").unwrap();
    assert!(g.get("V").is_none() && g.get("AV").is_none());
    r["media"] = json!([{"type":"image","file":"deas-inputs/a.png","slot":0}]);
    assert_eq!(
        compile(&r, "x").unwrap_err(),
        "Video references need the MiniMax H3 video VAE"
    );
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| n.to_string()).collect()
}

/// What a real backend advertises: the H3 pair beside LTX2's VAEs and the taeh3 preview decoder.
fn library() -> Vec<String> {
    names(&[
        "Minimax\\minimax_h3_video_vae_fp16.safetensors",
        "Minimax\\minimax_h3_audio_vae_fp32.safetensors",
        "LTX2/video_vae.safetensors",
        "LTX2/audio_vae.safetensors",
        "taeh3.safetensors",
    ])
}

#[test]
fn reads_the_advertised_vae_names() {
    assert_eq!(
        advertised_vaes(
            &json!({"VAELoader":{"input":{"required":{"vae_name":[["a.safetensors","b/c.safetensors"]]}}}})
        ),
        names(&["a.safetensors", "b/c.safetensors"])
    );
    for not_a_list in [
        json!({}),
        json!({"VAELoader":{}}),
        json!({"VAELoader":{"input":{"required":{"vae_name":["combo"]}}}}),
    ] {
        assert_eq!(advertised_vaes(&not_a_list), Vec::<String>::new());
    }
}

/// Each lane defaults to its own MiniMax H3 file: never another family's VAE, never the `tae*` preview
/// decoder that carries the same `h3` token, and never a file belonging to the other lane.
#[test]
fn each_lane_defaults_to_its_own_h3_vae() {
    let catalog = library();
    assert_eq!(
        pick_h3_vae(&catalog, false).as_deref(),
        Some("Minimax\\minimax_h3_video_vae_fp16.safetensors")
    );
    assert_eq!(
        pick_h3_vae(&catalog, true).as_deref(),
        Some("Minimax\\minimax_h3_audio_vae_fp32.safetensors")
    );
    assert_eq!(
        pick_h3_vae(&names(&["Minimax/h3_audio_vae.safetensors"]), false),
        None
    );
    assert_eq!(
        pick_h3_vae(&names(&["Minimax/h3_video_vae.safetensors"]), true),
        None
    );
    // Inside one lane a `video` name wins, then the shortest name, then A-Z.
    assert_eq!(
        pick_h3_vae(
            &names(&["z/h3_vae.safetensors", "a/h3_video_vae.safetensors"]),
            false
        )
        .as_deref(),
        Some("a/h3_video_vae.safetensors")
    );
    assert_eq!(
        pick_h3_vae(
            &names(&["b/h3_video_vae.safetensors", "a/h3_video_vae_x.safetensors"]),
            false
        )
        .as_deref(),
        Some("b/h3_video_vae.safetensors")
    );
    assert_eq!(
        pick_h3_vae(
            &names(&["b/h3_video_vae.safetensors", "a/h3_video_vae.safetensors"]),
            false
        )
        .as_deref(),
        Some("a/h3_video_vae.safetensors")
    );
}

#[test]
fn nothing_resolves_without_an_h3_vae() {
    for catalog in [
        names(&["LTX2/video_vae.safetensors", "LTX2/audio_vae.safetensors"]),
        names(&["taeh3.safetensors", "vae/Taeh3_Video.safetensors"]),
        names(&["vae/tae_h3_video.safetensors"]),
        vec![],
    ] {
        assert_eq!(pick_h3_vae(&catalog, false), None);
        assert_eq!(pick_h3_vae(&catalog, true), None);
    }
}

/// ComfyUI matches the combo value exactly and compile() reads a portable name, so the advertised form
/// crosses unchanged unless it needs `/` separators.
#[test]
fn keeps_a_form_both_the_backend_and_compile_accept() {
    assert_eq!(
        loadable("Minimax/minimax_h3_video_vae_fp16.safetensors").as_deref(),
        Some("Minimax/minimax_h3_video_vae_fp16.safetensors")
    );
    assert_eq!(
        loadable(r"Minimax\minimax_h3_video_vae_fp16.safetensors").as_deref(),
        Some(r"Minimax\minimax_h3_video_vae_fp16.safetensors")
    );
    assert_eq!(loadable(r"../h3\video_vae.safetensors"), None);
}

/// The Windows `VAELoader` combo lists and matches `Sub\file` exactly (TESTPC probe): the
/// resolver keeps the advertised id and `compile()` forwards it unchanged.
#[test]
fn a_native_windows_vae_id_survives_the_resolver_and_compile() {
    assert_eq!(
        loadable(r"MiniMaxH3\minimax_h3_video_vae_fp16.safetensors").as_deref(),
        Some(r"MiniMaxH3\minimax_h3_video_vae_fp16.safetensors")
    );
    let mut r = request();
    r["vae"] = json!(r"MiniMaxH3\video_vae.safetensors");
    r["audioVae"] = json!(r"MiniMaxH3\audio_vae.safetensors");
    let g = compile(&r, "req-win").unwrap();
    assert_eq!(
        g["V"]["inputs"]["vae_name"],
        r"MiniMaxH3\video_vae.safetensors"
    );
    assert_eq!(
        g["AV"]["inputs"]["vae_name"],
        r"MiniMaxH3\audio_vae.safetensors"
    );
}

/// A backend whose VAELoader combo advertises `list`: it counts the library reads and keeps the queued prompt.
async fn library_backend(
    list: Vec<String>,
) -> (
    String,
    Arc<Mutex<Value>>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let reads = Arc::new(AtomicUsize::new(0));
    let posted = Arc::new(Mutex::new(Value::Null));
    let (counted, saved) = (reads.clone(), posted.clone());
    let combo = json!({"VAELoader":{"input":{"required":{"vae_name":[list]}}}});
    let (base, task) = crate::jobs::tests::server(move |path, body| {
        if path == "GET /comfy/object_info/VAELoader HTTP/1.1" {
            counted.fetch_add(1, Ordering::SeqCst);
            return (200, combo.to_string());
        }
        *saved.lock().unwrap() = body;
        (200, json!({"prompt_id": PROMPT}).to_string())
    })
    .await;
    (base, posted, reads, task)
}

fn queued_prompt(posted: &Arc<Mutex<Value>>) -> Value {
    posted.lock().unwrap()["prompt"].clone()
}

/// Create RefMod needs no hand-picked VAE: the library's own H3 files fill the lanes left blank or empty.
#[tokio::test]
async fn submit_fills_blank_lanes_from_the_advertised_library() {
    let (base, posted, reads, task) = library_backend(library()).await;
    let mut r = request();
    r.as_object_mut().unwrap().remove("vae");
    r["audioVae"] = json!("");
    let id = native_h3_refmod_submit(base, r).await.unwrap();
    assert_eq!(id["promptId"], PROMPT);
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "one library read covers both lanes"
    );
    let graph = queued_prompt(&posted);
    // Advertised names enter the graph exactly as listed: the Windows combo matches `Sub\file` verbatim
    // (TESTPC probe) and compile() accepts both forms via comfy_model_name.
    assert_eq!(
        graph["V"]["inputs"]["vae_name"],
        r"Minimax\minimax_h3_video_vae_fp16.safetensors"
    );
    assert_eq!(
        graph["AV"]["inputs"]["vae_name"],
        r"Minimax\minimax_h3_audio_vae_fp32.safetensors"
    );
    task.abort();
}

/// A hand-picked VAE stays the request's own: with nothing missing the library is not even read.
#[tokio::test]
async fn an_explicit_vae_pair_wins_over_the_library_default() {
    let (base, posted, reads, task) = library_backend(library()).await;
    assert_eq!(
        native_h3_refmod_submit(base, request()).await.unwrap()["promptId"],
        PROMPT
    );
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    let graph = queued_prompt(&posted);
    assert_eq!(
        graph["V"]["inputs"]["vae_name"],
        "MiniMaxH3/video_vae.safetensors"
    );
    assert_eq!(
        graph["AV"]["inputs"]["vae_name"],
        "MiniMaxH3/audio_vae.safetensors"
    );
    task.abort();
}

/// An unresolvable lane is left exactly as it was, so the refusal strings stay byte-identical.
#[tokio::test]
async fn an_unresolved_lane_keeps_the_existing_refusal() {
    let (base, _posted, reads, task) =
        library_backend(names(&["LTX2/video_vae.safetensors", "taeh3.safetensors"])).await;
    let mut r = request();
    r.as_object_mut().unwrap().remove("vae");
    r["audioVae"] = json!("");
    assert_eq!(
        native_h3_refmod_submit(base, r.clone()).await.unwrap_err(),
        "Video references need the MiniMax H3 video VAE"
    );
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "the library is read once for both lanes"
    );
    task.abort();
    // A lost library read behaves the same, in either lane.
    let dead = crate::validate_base_url("http://127.0.0.1:9").unwrap();
    assert_eq!(fill_h3_vaes(&dead, r.clone()).await, r);
    let untouched = fill_h3_vaes(&dead, r).await;
    assert_eq!(
        compile(&untouched, "x").unwrap_err(),
        "Video references need the MiniMax H3 video VAE"
    );
    let mut audio = request();
    audio["media"] = json!([{"type":"audio","file":"deas-inputs/v.wav","slot":0}]);
    audio.as_object_mut().unwrap().remove("audioVae");
    assert_eq!(
        compile(&fill_h3_vaes(&dead, audio).await, "x").unwrap_err(),
        "Audio references need the MiniMax H3 audio VAE"
    );
}

#[test]
fn rejects_unsafe_names_paths_and_empty_selections() {
    for bad in ["../x", "a/b", ".hidden", "trail.", " pad", "a:b", "x%y"] {
        let mut r = request();
        r["name"] = json!(bad);
        assert!(compile(&r, "x").is_err(), "{bad}");
    }
    let mut r = request();
    r["name"] = json!("");
    assert!(
        compile(&r, "x").is_ok(),
        "empty name = node picks a unique one"
    );
    r["conceptType"] = json!("lora");
    assert!(compile(&r, "x").is_err());
    let mut r = request();
    r["media"][0]["file"] = json!("/etc/passwd");
    assert!(
        compile(&r, "x").is_err(),
        "files must be this app's uploads"
    );
    let mut r = request();
    r["media"] = json!([]);
    r["refmods"] = json!([]);
    assert!(compile(&r, "x").is_err());
    let mut r = request();
    r["extra"] = json!(1);
    assert!(compile(&r, "x").is_err());
    let mut r = request();
    r["media"][0]["description"] = json!(7);
    assert!(compile(&r, "x").is_err());
}

#[test]
fn reads_the_saved_result_failures_and_interrupts_from_history() {
    let done = json!({"status":{"completed":true,"messages":[]},"outputs":{"refmod":{"dasiwa_refmod_export":[
        {"name":"hero","members":3,"counts":{"image":1,"video":1,"audio":1},"warnings":["Item 2: H3 frame grid kept 56/60 frames."],"message":"x"}]}}});
    assert_eq!(
        history_state(&done).unwrap(),
        json!({"state":"done","result":{"name":"hero","members":3,"counts":{"image":1,"video":1,"audio":1},"warnings":["Item 2: H3 frame grid kept 56/60 frames."]}})
    );
    let failed = json!({"status":{"status_str":"error","completed":false,"messages":[["execution_error",{"exception_message":"Connect the MiniMax H3 video VAE"}]]},"outputs":{}});
    assert_eq!(
        history_state(&failed).unwrap(),
        json!({"state":"failed","error":"Connect the MiniMax H3 video VAE"})
    );
    let interrupted = json!({"status":{"messages":[["execution_interrupted",{}]]},"outputs":{}});
    assert_eq!(history_state(&interrupted).unwrap()["state"], "cancelled");
    assert!(history_state(&json!({"status":{"completed":false},"outputs":{}})).is_none());
    let empty = json!({"status":{"completed":true},"outputs":{}});
    assert_eq!(history_state(&empty).unwrap()["state"], "failed");
    let forged =
        json!({"outputs":{"refmod":{"dasiwa_refmod_export":[{"name":"../x","members":1}]}}});
    assert_eq!(history_state(&forged).unwrap()["state"], "failed");
}

#[test]
fn queue_state_and_rejection_reason() {
    let id = "5f1c3c39-3a37-4c39-9d0d-2bb0e4d4f8a1";
    let queue = json!({"queue_running":[[1,id,{},{},[]]],"queue_pending":[[2,"other",{},{},[]]]});
    assert_eq!(queued_state(&queue, id), Some("running"));
    assert_eq!(queued_state(&queue, "other"), Some("queued"));
    assert_eq!(queued_state(&queue, "gone"), None);
    assert!(prompt_id(id) && !prompt_id("../../x"));
    let v = json!({"error":{"message":"Prompt outputs failed validation"},"node_errors":{"refmod":{"errors":[{"message":"Value not in list","details":"vae_name: 'x' not in []"}]}}});
    assert_eq!(
        rejection(&v),
        "Prompt outputs failed validation: vae_name: 'x' not in []"
    );
    assert_eq!(
        rejection(&json!({"error":{"message":"invalid prompt"}})),
        "invalid prompt"
    );
}

#[tokio::test]
async fn status_and_cancel_only_answer_for_prompts_this_app_queued() {
    let id = "5f1c3c39-3a37-4c39-9d0d-2bb0e4d4f8a1".to_string();
    let err = native_h3_refmod_status("http://127.0.0.1:9".into(), id)
        .await
        .unwrap_err();
    assert_eq!(err, "Unknown RefMod export");
}

#[test]
fn commands_are_registered_and_permitted() {
    let main = include_str!("main.rs");
    let permission: toml::Value = toml::from_str(include_str!("../permissions/api.toml")).unwrap();
    let jobs = permission["permission"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["identifier"].as_str() == Some("allow-native-diagnostic-jobs"))
        .unwrap();
    for command in [
        "native_h3_refmod_submit",
        "native_h3_refmod_status",
        "native_h3_refmod_cancel",
    ] {
        assert!(main.contains(&format!("deas::{command},")), "{command}");
        assert!(
            jobs["commands"]["allow"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c.as_str() == Some(command)),
            "{command}"
        );
    }
}

/// `cargo test --lib dump_refmod_graph -- --ignored --nocapture` prints the export graph for
/// `tools/validate_video_graphs.py` (node names, inputs and link types against the real checkout).
#[test]
#[ignore]
fn dump_refmod_graph() {
    println!(
        "{}",
        json!({"h3_refmod_export":compile(&request(), "probe").unwrap()})
    );
}

/// Live acceptance against a throwaway backend: `DEAS_REFMOD_PROBE=http://127.0.0.1:8199/ cargo test --lib
/// live_refmod_export -- --ignored --nocapture` with `deas-inputs/probe.png` in its input folder.
#[tokio::test]
#[ignore]
async fn live_refmod_export() {
    let base = std::env::var("DEAS_REFMOD_PROBE").unwrap();
    let request = json!({"name":format!("deas-probe-{}", uuid::Uuid::new_v4().simple()),"description":"probe","conceptType":"identity",
        "media":[{"type":"image","file":"deas-inputs/probe.png","slot":0,"description":"noise"}],"refmods":[],
        "vae":"MiniMaxH3/minimax_h3_video_vae_fp16.safetensors"});
    let id = native_h3_refmod_submit(base.clone(), request)
        .await
        .unwrap()["promptId"]
        .as_str()
        .unwrap()
        .to_owned();
    let started = std::time::Instant::now();
    loop {
        let state = native_h3_refmod_status(base.clone(), id.clone())
            .await
            .unwrap();
        if !["queued", "running"].contains(&state["state"].as_str().unwrap()) {
            println!("{state} after {:.1}s", started.elapsed().as_secs_f64());
            assert_eq!(state["state"], "done");
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
