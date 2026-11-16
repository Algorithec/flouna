# FLOUNA V7 Run 1 — Training Report

**Status: FAILED — halted during warm-up on deterministic NaN loss. No checkpoint was produced, so there is nothing to validate, select or evaluate. The run was stopped, not restarted.**

---

## 1. Run identity

| Field | Value |
|---|---|
| Config | `model/configs/v7_run1.yaml` |
| Config SHA256 | `b88ac11b34747c8be58139b9a88055d30bd505f669e3400fa9a8f1da021cfde0` |
| Base model | `Qwen/Qwen2.5-1.5B-Instruct` (cached HF snapshot, unchanged) |
| Adapter init | Fresh LoRA — `resume_adapter_file: null`, no V5/V6/V7 weights loaded |
| LoRA | rank 16, scale 2.0, dropout 0.05, last 16 layers, `mask_prompt: true` |
| Optimizer / schedule | AdamW, lr 1.5e-4, cosine decay, warmup 50 |
| Batch / iterations | micro-batch 1, grad accumulation 4, 1,600 iterations |
| `max_seq_length` | 1,152 |
| Seed | 11 |
| Data | `/tmp/flouna_v7_data` |
| Output path | `model/flouna-lora-v7-run1` |
| Runtime | mlx-lm 0.32.2, mlx 0.32.4 |
| Git branch / HEAD | `feat/flouna-1.5b-v6-training` / `10db26a5c86d63ba3d0e0c1a0b4e92b7a6bd2fb0` |
| Launch | 2026-11-16 ≈12:24 IST, `nohup caffeinate -i .venv/bin/python -u -m mlx_lm lora -c configs/v7_run1.yaml`, pid 2020 |
| Halt | 2026-11-16 ≈12:27 IST (≈2 min 11 s after launch), manually terminated after confirming NaN |
| Log | `model/results/logs/v7_run1_train.log` (SHA256 `f942877941564ef5805488576fa3cbf804aa50bab6b9c265ae87789a4b2431a5`) |

The output directory exists but contains only `adapter_config.json` (1,193 bytes, SHA256 `e62a319e949363eb1495b1e87ec19f33291d163c8abd06406504a7cec3549912`). It is the config echo written by mlx-lm at start, not a trained artifact. It has been left in place untouched as evidence.

## 2. Data

No dataset was modified before or during the run. Every hash matches the pre-training snapshot exactly.

| File | Rows | SHA256 |
|---|---|---|
| `data/v7/train_v7.jsonl` | 4,147 | `678338cba7af5277e6e39c99ecfdcd3ee63b90be983865da71e61cc1797878bf` |
| `data/v7/valid_v7.jsonl` | 225 | `6cf147ed4ae801d38999a8d3d418e443de574f44880983e1c3f9bff32737baee` |
| `data/v7/validation/v7_validation.jsonl` (private eval) | 495 | `2467d61641064dda43bf829ef9c2c328344ddca0acf65e698248d54d432b8e8a` |
| `/tmp/flouna_v7_data/train.jsonl` | 4,147 | identical to `train_v7.jsonl` |
| `/tmp/flouna_v7_data/valid.jsonl` | 225 | identical to `valid_v7.jsonl` |
| Sealed holdout `model/eval_mlx_v5.jsonl` | 382 | `f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a` |

The sealed holdout was not opened, modified or evaluated. Its SHA256 and mtime (2026-11-10 15:42:28, 742,135 bytes) are unchanged.

## 3. Training

Observed log, in order:

```
iter   train_loss
     1    val   nan    2.92s
    20      nan ▼        9      0.8k
```

- The step-0 validation loss was already `nan`.
- The first reported training loss (iteration 20) was also `nan`.
- Across 16 emitted truncation warnings, the longest sequences were 1,642–1,713 tokens, all clamped to 1,152.
- The process was halted at roughly iteration 25–30. It never reached iteration 200, so no periodic save occurred.
- Effective throughput was 9 tok/s at iteration 20 — roughly half the V6 batch-1 rate, consistent with spending most compute on prompt tokens that carried no trainable target.
- No meaningful s/iter figure exists for a completed run; ≈4–5 s/iter was observed before the halt.
- Memory was not sampled continuously during this short run; no Metal allocation error, swap warning or stall occurred before the halt. This section is intentionally incomplete because the run failed.

Because mlx-lm has no NaN guard, leaving the process running would have written NaN adapter weights at iteration 200. It was stopped instead.

## 4. Checkpoints

**None.** No `*_adapters.safetensors`, no `adapters.safetensors`, no final `adapter_config.json` update: the output directory contains only the initial config echo listed in section 1.

Consequently:

- No checkpoint could be opened, hashed or shape-checked.
- No tensor count, dtype, NaN/Inf or integrity check is applicable.
- **BEST VALIDATION CHECKPOINT: none.**
- **FINAL CHECKPOINT: none.**
- No checkpoint selection was performed, on the private validation set or anything else.

## 5. Stability

- No crash, Metal error, out-of-memory event, swap exhaustion or stall before the halt.
- The failure is deterministic and mathematical, not a transient runtime fault: rows whose assistant target is fully truncated contribute zero scored tokens, and mlx-lm's loss divides by that zero token count (`ce.sum() / ntoks`), producing NaN loss and NaN gradients.

## 6. Data integrity

- `train_v7.jsonl`, `valid_v7.jsonl`, the private eval set and both `/tmp/flouna_v7_data` copies are byte-identical to the pre-training values recorded above.
- The sealed holdout is byte-identical: same SHA256, same size (742,135 bytes), same mtime as before the run.
- `v7_run1.yaml` is unchanged (same SHA256).
- The base model cache was only read.

## 7. Production safety

- No GGUF export was run.
- No Ollama model was created or updated; no local model was served.
- The production backend, production `prompt.ts`, and the website were not touched.
- No commit and no push. Branch and HEAD are unchanged.
- The failed run left only `results/logs/v7_run1_train.log` and `flouna-lora-v7-run1/adapter_config.json`.

## 8. Failure analysis and recommendation

### Root cause

The V7 corpus mixes three system prompts. The `prod` prompt — the production `prompt.ts` text — is 6,053 characters, which tokenizes to **1,589 tokens**. After the chat template adds the user turn, the prompt offset reaches 1,600–1,650 tokens, well beyond the configured `max_seq_length` of 1,152.

mlx-lm truncates the full sequence to 1,152 tokens and builds the loss mask from the prompt offset. For every `prod` row the mask is empty, so `default_loss` evaluates `ce.sum() / 0`, which is NaN. With accumulation 4, any NaN micro-batch poisons the accumulated gradient and the optimizer update. The step-0 validation loss was NaN for the same reason: 43% of validation rows are `prod` rows and the sampled validation batches included one.

### Scope of affected rows

| Split | `prod` rows | Share | Fully masked at 1,152 |
|---|---|---|---|
| Train (4,147) | 1,871 | 45.1% | 1,871 (all) |
| Valid (225) | 97 | 43.1% | 97 (all) |
| Private eval (495) | 221 | 44.6% | 221 (all) |

The `v6` rows (max prompt offset 986) and `short` rows (max 345) fit comfortably. V6 never hit this because its corpus used only one system prompt of 933 tokens with a maximum offset of 991.

### Why QA did not catch it

The V7 validator checked schema, label semantics, priority policy, leakage, splits and composition, but never tokenized the rows against `max_seq_length`. The pre-training report likewise reported sequence-independent facts. This was a gap in the dataset QA, and it invalidates the assumption that the V7 mix was trainable at 1,152 tokens. The data itself is intact; the incompatibility is between the `prod` prompt rows and the configured sequence length.

### Options (none executed — each needs your approval)

- **A. Drop `prod`-system rows from Run 1 data.** Train 3,307 rows / validate 128 / score 274. Fast, stays inside the 1,152-token limit proven on this machine, but gives up production-prompt exposure in training.
- **B. Raise `max_seq_length` to ≈1,792–1,856.** Keeps the full mix, but violates the documented 16 GB ceiling measured at 1,152 tokens; requires a memory smoke test first and is the highest-risk option on this hardware.
- **C. Replace the production prompt in training data with a compact training-only variant (≈≤1,000 tokens) and regenerate the `prod` rows.** Keeps per-row semantics and the sequence limit, but changes what prompt distribution the adapter sees during training, and requires regenerating and re-validating the corpus.
- **D. Truncate the prompt itself.** Not viable — the prompt is the conditioning context; truncating it changes the task.

Any rerun also needs a decision on whether to reuse `model/flouna-lora-v7-run1` (currently config-only) or use a new output directory, and should add a token-length preflight to the validator before training starts.

### Evaluation status

No checkpoint exists, so no private-validation scoring and no official-holdout evaluation were performed. The 382-case sealed holdout remains untouched. Nothing here says anything about V7 accuracy or about V7 versus V6; training loss would not have been accuracy even if it had been finite.

V7 Run 1 training did not complete. No checkpoints exist. Official evaluation not started.
