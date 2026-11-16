# V6 Run 1 — completion report

Run 1 trained a fresh LoRA on the audited V6 corpus
(`train_mlx_v6.jsonl`, 11,418 rows) from the base model. It was launched at
11:11:50 IST on 2026-11-15 and exited 0 at 15:49:11 IST.

## Result

| Item | Value |
|---|---|
| Target iterations | 2,400 |
| Completed iterations | 2,400 |
| Final train loss (iters 2381-2400) | 0.034 |
| Final validation loss (iter 2400) | 0.015 |
| Best validation loss | 0.015 at iter 2400 |
| Total duration | 4 h 37 m 21 s (16,641 s) |
| Average iteration time | 6.93 s (includes evals and saves) |
| Observed peak RSS | 731,440 KiB (~714 MiB) |
| Observed peak wired memory | 8.07 GB (504,185 pages, first minutes); steady state 6.4-7.2 GB |
| Swap | 8.6 GB -> 8.3 GB system-wide, no growth attributable to training |
| NaN / Inf | 0 / 0 |
| Crashes | 0 |
| Stalls | 0 |

Data does not yet say which checkpoint is best on the sealed set — that is
Phase 11. By validation loss, iter 2400 is best; iter 1000 (0.028) is
preserved as the previous best.

## Validation progression

| Iter | Val loss | | Iter | Val loss |
|---:|---:|---|---:|---:|
| 1 | 1.220 | | 1400 | 0.039 |
| 200 | 0.085 | | 1600 | 0.031 |
| 400 | 0.089 | | 1800 | 0.054 |
| 600 | 0.035 | | 2000 | 0.036 |
| 800 | 0.057 | | 2200 | 0.032 |
| 1000 | 0.028 | | 2400 | **0.015** |
| 1200 | 0.046 | | | |

Validation loss is measured on 2 batches, so the 0.028-0.057 band through
iter 2200 is sampling noise; the final 0.015 is a genuine drop.

## Training loss progression

20-iteration window averages: 1.176 (20), 0.792 (40), 0.403 (60), 0.262 (80),
0.169 (100), 0.145-0.190 (120-160), 0.089-0.131 (180-340), 0.049-0.091
(360-900), 0.033-0.082 (920-1600), 0.026-0.056 (1620-2380), 0.034 (2400).
The only visible spikes are single-window events (0.190 at 160, 0.101 at 2200)
that recover in the next window.

## Checkpoints

All at 42,229,570 bytes, all 224 LoRA tensors, all in
`flouna-lora-v6-run1/`:

`0000200`, `0000400`, `0000600`, `0000800`, `0001000`, `0001200`,
`0001400`, `0001600`, `0001800`, `0002000`, `0002200`, `0002400`
plus the rolling `adapters.safetensors` (identical to `0002400`).

- Final checkpoint: `flouna-lora-v6-run1/adapters.safetensors`
  sha256 `4059e414c92fc1141a1964b523b80271fda9b2bdc19944b4a15dc3054ee50d4f`
- Best-by-val checkpoint: `flouna-lora-v6-run1/0002400_adapters.safetensors`
  (same sha256); previous best `0001000` sha256
  `21b5f2a6dd43ff3926b7aeb7b0ed7b2cc96ad22e4d4b0bab6538593132f866b7`
- Integrity: both files load through `safetensors.safe_open` with 224 keys
  (e.g. `model.layers.12.mlp.down_proj.lora_a` = [8960, 16]).
- No checkpoint was deleted or overwritten.

## Data and configuration

| Item | Value |
|---|---|
| Training dataset | `/tmp/flouna_v6_data/train.jsonl`, 11,418 rows, sha256 `3b8a991102b1aab0f5ce075b6ad23690773d7a625c5e6104d267da392f5d3fde` |
| Validation dataset | `/tmp/flouna_v6_data/valid.jsonl`, 281 rows, sha256 `58d745feaccdd51de2286a0ea32533372e836cc47b8c8eeeac8241e5843daa84` |
| Config | `configs/v6_run1.yaml`, sha256 `8f4a498b128718b06e76b5701ddbf07c41df5ec8d0387c47f4e81e9e680eef55` |
| Command | `caffeinate -i .venv/bin/python -u -m mlx_lm lora -c configs/v6_run1.yaml` (opened from Terminal.app) |
| Base model | `Qwen/Qwen2.5-1.5B-Instruct` |
| LoRA | rank 16, scale 2.0, dropout 0.05, last 16 layers, mask_prompt, AdamW, grad checkpoint, seed 42 |
| Batch | micro-batch 1, grad accumulation 4, effective 4 |
| Schedule | lr 2e-4, cosine decay to 2400, warmup 60, max_seq_length 1152 |

The dataset sha256 matches the audited `train_mlx_v6.jsonl` in the repo, and
`/tmp/flouna_v6_data` was the only dataset read.

## Repository state

- Branch: `feat/flouna-1.5b-v6-training`
- HEAD: `10db26a5c86d63ba3d0e0c1a0b4e92b7a6bd2fb0`
- Uncommitted: the V6 tooling, data, configs and results under `model/`
  (plus the pre-existing modifications to `model/flouna_schema.py` and
  `model/validate_dataset.py`). No website, backend, production or unrelated
  files changed.

## Resume compatibility for Run 2

`adapter_config.json` is present, the weights load, and Run 2 was started with
`resume_adapter_file` pointing at `flouna-lora-v6-run1/adapters.safetensors`.
The resumed model's first validation loss was 0.043 at iter 1 (vs 1.220 for
the base model at iter 1 in Run 1), confirming the adapter weights were
loaded rather than the base model.
