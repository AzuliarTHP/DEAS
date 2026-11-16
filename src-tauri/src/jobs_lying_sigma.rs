//! Optional built-in sampler wrapper for the image first pass.
use serde_json::{json, Value};

pub(super) const NODE: &str = "DEAS_LyingSigmaSampler";

pub(super) fn validate(value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else { return Ok(()) };
    let valid = value.as_object().is_some_and(|o| o.len() == 3)
        && ["factor", "startPercent", "endPercent"]
            .iter()
            .all(|k| value[*k].as_f64().is_some_and(f64::is_finite))
        && value["factor"]
            .as_f64()
            .is_some_and(|n| (-0.999..=1.0).contains(&n))
        && value["startPercent"].as_f64().is_some_and(|n| n >= 0.0)
        && value["endPercent"].as_f64().is_some_and(|n| n <= 1.0)
        && value["startPercent"].as_f64() < value["endPercent"].as_f64();
    if valid {
        Ok(())
    } else {
        Err("Invalid lyingSigma: factor -0.999..=1 and 0 <= startPercent < endPercent <= 1 are required".into())
    }
}

/// Preserve the existing custom schedule, or reproduce KSampler's ordinary schedule.
/// Apply last so references, wildcards, masks and model patches keep their exact links.
pub(super) fn apply(graph: &mut Value, value: Option<&Value>) -> Result<(), String> {
    let Some(s) = value.filter(|s| s["factor"].as_f64() != Some(0.0)) else {
        return Ok(());
    };
    if graph["5"]["class_type"] == "KSampler" {
        let i = graph["5"]["inputs"].clone();
        if ["dpm_2", "dpm_2_ancestral", "uni_pc", "uni_pc_bh2"]
            .contains(&i["sampler_name"].as_str().unwrap_or_default())
        {
            return Err("Lying Sigma requires an explicit sigma schedule for this sampler".into());
        }
        let denoise = i["denoise"].as_f64().unwrap_or(1.0);
        if denoise > 0.0 && (i["steps"].as_f64().unwrap() / denoise).floor() > 10000.0 {
            return Err("Lying Sigma derived scheduler steps exceed 10000; increase denoise or reduce steps".into());
        }
        graph["LSN"] = json!({"class_type":"RandomNoise","inputs":{"noise_seed":i["seed"]}});
        graph["LSG"] = json!({"class_type":"CFGGuider","inputs":{"model":i["model"],"positive":i["positive"],"negative":i["negative"],"cfg":i["cfg"]}});
        graph["LSQ"] =
            json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":i["sampler_name"]}});
        graph["LSZ"] = json!({"class_type":"BasicScheduler","inputs":{"model":i["model"],"scheduler":i["scheduler"],"steps":i["steps"],"denoise":i["denoise"]}});
        graph["5"] = json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["LSN",0],"guider":["LSG",0],"sampler":["LSQ",0],"sigmas":["LSZ",0],"latent_image":i["latent_image"]}});
    }
    graph["LS"] = json!({"class_type":NODE,"inputs":{"sampler":graph["5"]["inputs"]["sampler"],"dishonesty_factor":s["factor"],"start_percent":s["startPercent"],"end_percent":s["endPercent"]}});
    graph["5"]["inputs"]["sampler"] = json!(["LS", 0]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lying_sigma_shared_graph_matches_typescript() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/lying-sigma.json")).unwrap();
        assert_eq!(
            super::super::compile(&fixture["intent"]).unwrap(),
            fixture["graph"]
        );
    }
    fn setting(factor: f64) -> Value {
        json!({"factor":factor,"startPercent":0.1,"endPercent":0.9})
    }
    #[test]
    fn lying_sigma_off_is_graph_neutral_and_bounds_are_strict() {
        let plain = super::super::tests::intent();
        let baseline = super::super::compile(&plain).unwrap();
        let mut i = plain.clone();
        i["lyingSigma"] = setting(0.0);
        assert_eq!(super::super::compile(&i).unwrap(), baseline);
        for bad in [
            Value::Null,
            json!(false),
            json!({}),
            json!({"factor":"0","startPercent":0.1,"endPercent":0.9}),
            setting(-1.0),
            setting(1.01),
            json!({"factor":0,"startPercent":0.9,"endPercent":0.1}),
            json!({"factor":0,"startPercent":0.1,"endPercent":0.9,"extra":true}),
        ] {
            i["lyingSigma"] = bad;
            assert!(super::super::compile(&i)
                .unwrap_err()
                .contains("lyingSigma"));
        }
    }
    #[test]
    fn lying_sigma_preserves_effective_image_links_and_refine() {
        let mut i = super::super::tests::intent();
        i["inputImage"] = json!("source.png");
        i["denoise"] = json!(0.6);
        i["refine"] = json!({"width":1024,"height":1024,"denoise":0.3});
        let baseline = super::super::compile(&i).unwrap();
        i["lyingSigma"] = setting(-0.05);
        let g = super::super::compile(&i).unwrap();
        assert_eq!(
            g["LS"]["inputs"],
            json!({"sampler":["LSQ",0],"dishonesty_factor":-0.05,"start_percent":0.1,"end_percent":0.9})
        );
        assert_eq!(g["LSZ"]["inputs"]["denoise"], 0.6);
        assert_eq!(
            g["5"]["inputs"]["latent_image"],
            baseline["5"]["inputs"]["latent_image"]
        );
        assert_eq!(
            g["LSG"]["inputs"]["positive"],
            baseline["5"]["inputs"]["positive"]
        );
        assert_eq!(g["R5"], baseline["R5"]);
        i["sampler"] = json!("dpm_2");
        assert!(super::super::compile(&i)
            .unwrap_err()
            .contains("explicit sigma"));
        i["sampler"] = json!("euler");
        i["denoise"] = json!(0.00001);
        assert!(super::super::compile(&i).unwrap_err().contains("10000"));
    }
    #[test]
    fn lying_sigma_keeps_explicit_schedule_and_sampler() {
        let mut i = super::super::tests::intent();
        i["steps"] = json!(2);
        i["sigmas"] = json!([1.0, 0.5, 0.0]);
        i["sampler"] = json!("dpm_2");
        let baseline = super::super::compile(&i).unwrap();
        i["lyingSigma"] = setting(-0.05);
        let g = super::super::compile(&i).unwrap();
        assert_eq!(g["LS"]["inputs"]["sampler"], json!(["Q", 0]));
        assert_eq!(g["Z"], baseline["Z"]);
        assert_eq!(g["N"], baseline["N"]);
        assert_eq!(
            g["5"]["inputs"]["sigmas"],
            baseline["5"]["inputs"]["sigmas"]
        );
        assert!(g.get("LSZ").is_none());
    }

    #[test]
    fn lying_sigma_anima_inpaint_keeps_lora_and_model_patch_links() {
        let mut i = super::super::tests::intent();
        i["family"] = json!("anima");
        i["diffusion"] = json!({"textEncoder":"qwen.safetensors","clipType":"stable_diffusion","vae":"wan.safetensors","family":"anima"});
        i["inputImage"] = json!("source.png");
        i["inputMask"] = json!("deas-masks/12345678-1234-1234-1234-123456789abc.png");
        i["denoise"] = json!(0.65);
        i["loras"] = json!([{"name":"style.safetensors","strength":0.7}]);
        i["options"] = json!({"attention":"pytorch"});
        let before = super::super::compile(&i).unwrap();
        i["lyingSigma"] = setting(-0.05);
        let after = super::super::compile(&i).unwrap();
        for field in ["model", "positive", "negative"] {
            assert_eq!(after["LSG"]["inputs"][field], before["5"]["inputs"][field]);
        }
        assert_eq!(
            after["5"]["inputs"]["latent_image"],
            before["5"]["inputs"]["latent_image"]
        );
        assert_eq!(after["Y"], before["Y"]);
        assert_eq!(after["LSZ"]["inputs"]["denoise"], 0.65);
    }
}
