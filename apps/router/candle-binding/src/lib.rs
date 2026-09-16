//! CPU inference for Brick's six-label ModernBERT checkpoint.
mod model;
use anyhow::{bail, Context, Result};
use candle_core::{DType, Device, Tensor};
use candle_nn::{LayerNorm, Linear, Module, VarBuilder};
use model::{Config, ModernBert};
use std::{
    ffi::{c_char, CStr},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};
const LABELS: [&str; 6] = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "planning_agentic",
    "creative_synthesis",
];
static MODEL: Mutex<Option<(PathBuf, Classifier)>> = Mutex::new(None);
struct Classifier {
    model: ModernBert,
    tokenizer: Tokenizer,
    head: (Linear, LayerNorm),
    classifier: Linear,
}
impl Classifier {
    fn load(path: &Path) -> Result<Self> {
        let mut raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join("config.json"))?)?;
        for (i, label) in LABELS.iter().enumerate() {
            if raw["id2label"][i.to_string()].as_str() != Some(label) {
                bail!("checkpoint label order differs from Brick");
            }
        }
        if raw["id2label"].as_object().map(|v| v.len()) != Some(6) {
            bail!("checkpoint must have six labels");
        }
        // Preserve baseline normalization; changing the model math is a separate correction.
        if raw.get("global_rope_theta").is_none() {
            raw["global_rope_theta"] = raw["rope_parameters"]["full_attention"]["rope_theta"]
                .as_f64()
                .or_else(|| raw["rope_parameters"]["sliding_attention"]["rope_theta"].as_f64())
                .unwrap_or(160000.0)
                .into();
        }
        if raw.get("local_rope_theta").is_none() {
            raw["local_rope_theta"] = raw["global_rope_theta"].clone();
        }
        let cfg: Config = serde_json::from_value(raw)?;
        if cfg.num_attention_heads == 0
            || cfg.hidden_size == 0
            || cfg.hidden_size % cfg.num_attention_heads != 0
            || cfg.global_attn_every_n_layers == 0
        {
            bail!("invalid model dimensions");
        }
        let mut tokenizer =
            Tokenizer::from_file(path.join("tokenizer.json")).map_err(anyhow::Error::msg)?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: 512,
                ..Default::default()
            }))
            .map_err(anyhow::Error::msg)?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            pad_id: cfg.pad_token_id,
            pad_token: "[PAD]".into(),
            ..Default::default()
        }));
        let device = Device::Cpu;
        // Installed assets remain immutable while the model maps them.
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(
                &[path.join("model.safetensors")],
                DType::F32,
                &device,
            )?
        };
        let model = ModernBert::load(vb.clone(), &cfg)?;
        let h = vb.pp("head");
        let head = (
            Linear::new(
                h.get((cfg.hidden_size, cfg.hidden_size), "dense.weight")?,
                None,
            ),
            LayerNorm::new(
                h.get((cfg.hidden_size,), "norm.weight")?,
                Tensor::zeros((cfg.hidden_size,), DType::F32, &device)?,
                1e-12,
            ),
        );
        let cvb = vb.pp("classifier");
        let classifier = Linear::new(
            cvb.get((6, cfg.hidden_size), "weight")?,
            Some(cvb.get((6,), "bias")?),
        );
        Ok(Self {
            model,
            tokenizer,
            head,
            classifier,
        })
    }
    fn classify(&self, text: &str) -> Result<[f32; 6]> {
        let encodings = self
            .tokenizer
            .encode_batch(vec![text], true)
            .map_err(anyhow::Error::msg)?;
        let e = &encodings[0];
        let ids = Tensor::new(e.get_ids(), &Device::Cpu)?.unsqueeze(0)?;
        let mask = Tensor::new(e.get_attention_mask(), &Device::Cpu)?.unsqueeze(0)?;
        let output = self.model.forward(&ids, &mask)?;
        let sum = output
            .broadcast_mul(&mask.unsqueeze(2)?.to_dtype(DType::F32)?)?
            .sum(1)?;
        let mut pooled = sum.broadcast_div(&mask.sum_keepdim(1)?.to_dtype(DType::F32)?)?;
        let (dense, norm) = &self.head;
        pooled = norm.forward(&dense.forward(&pooled)?.gelu()?)?;
        let probs =
            candle_nn::ops::softmax(&self.classifier.forward(&pooled)?, candle_core::D::Minus1)?
                .squeeze(0)?
                .to_vec1::<f32>()?;
        let values: [f32; 6] = probs
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid output shape"))?;
        if values.iter().any(|v| !v.is_finite()) {
            bail!("non-finite output");
        }
        Ok(values)
    }
}
fn boundary(error: *mut c_char, capacity: usize, f: impl FnOnce() -> Result<()>) -> i32 {
    let message = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(Ok(())) => return 0,
        Ok(Err(e)) => e.to_string(),
        Err(_) => "ModernBERT panicked".into(),
    };
    if !error.is_null() && capacity > 0 {
        let b = message.as_bytes();
        let n = b.len().min(capacity - 1);
        unsafe {
            std::ptr::copy_nonoverlapping(b.as_ptr(), error.cast(), n);
            *error.add(n) = 0;
        }
    }
    -1
}
/// Load one immutable CPU checkpoint per process.
/// # Safety
/// `path` must be NUL-terminated; `error` must hold `capacity` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn brick_model_load(
    path: *const c_char,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    boundary(error, capacity, || {
        if path.is_null() {
            bail!("missing model path");
        }
        let path = Path::new(CStr::from_ptr(path).to_str()?)
            .canonicalize()
            .context("model directory unavailable")?;
        let mut state = MODEL
            .lock()
            .map_err(|_| anyhow::anyhow!("model lock poisoned"))?;
        if let Some((current, _)) = &*state {
            if current != &path {
                bail!("another checkpoint is loaded");
            }
            return Ok(());
        }
        *state = Some((path.clone(), Classifier::load(&path)?));
        Ok(())
    })
}
/// Return six values in checkpoint order, or leave the output unchanged on error.
/// # Safety
/// `text` must be NUL-terminated, `output` must hold six floats and `error` must
/// hold `capacity` writable bytes. Buffers must not alias.
#[no_mangle]
pub unsafe extern "C" fn brick_classify(
    text: *const c_char,
    output: *mut f32,
    error: *mut c_char,
    capacity: usize,
) -> i32 {
    boundary(error, capacity, || {
        if text.is_null() || output.is_null() {
            bail!("missing input or output");
        }
        let text = CStr::from_ptr(text).to_str()?;
        let state = MODEL
            .lock()
            .map_err(|_| anyhow::anyhow!("model lock poisoned"))?;
        let (_, model) = state.as_ref().context("model not loaded")?;
        let values = model.classify(text)?;
        std::ptr::copy_nonoverlapping(values.as_ptr(), output, 6);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffi_errors_preserve_output_and_buffer_bounds() {
        let mut output = [-1.0f32; 6];
        let mut error = [42i8; 8];
        unsafe {
            assert_eq!(
                brick_classify(std::ptr::null(), output.as_mut_ptr(), error.as_mut_ptr(), 4),
                -1
            );
            assert_eq!(
                brick_model_load(std::ptr::null(), std::ptr::null_mut(), 0),
                -1
            );
        }
        assert_eq!(output, [-1.0; 6]);
        assert_eq!(error[3], 0);
        assert_eq!(&error[4..], &[42; 4]);
    }

    #[test]
    fn panics_cannot_cross_the_c_abi_boundary() {
        let mut error = [0i8; 64];
        assert_eq!(
            boundary(error.as_mut_ptr(), error.len(), || panic!(
                "controlled failure"
            )),
            -1
        );
        let message = unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap();
        assert_eq!(message, "ModernBERT panicked");
    }
}
