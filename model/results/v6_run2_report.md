# V6 Run 2 — completion report

Run 2 resumed from `flouna-lora-v6-run1/adapters.safetensors` and trained on
the 727-row targeted curriculum. Launched 15:54:17 IST, exited 0 at 17:57:57
IST on 2026-11-15.

## Result

| Item | Value |
|---|---|
| Target / completed | 1,600 / 1,600 |
| Final train loss (iters 1581-1600) | 0.023 |
| Final validation loss (iter 1600) | 0.035 |
| Best validation loss | 0.020 at iter 400 |
| Duration | 2 h 3 m 40 s (7,420 s) |
| Average iteration time | 4.64 s |
| Observed peak RSS | 785,024 KiB (~767 MiB) |
| Observed peak wired memory | 7.71 GB (483,166 pages) |
| Swap | 8.67 GB system-wide at end, no training-attributable growth |
| NaN / Inf | 0 / 0 |
| Crashes / stalls | 0 / 0 |
| Metal errors | none |

Validation progression: 0.043 (1), 0.054 (200), **0.020** (400), 0.080 (600),
0.023 (800), 0.036 (1000), 0.031 (1200), 0.033 (1400), 0.035 (1600). The
evaluation uses 2 batches, so this series is noisy; the 0.020 at 400 is not
evidence that iter 400 is better than the final model.

## Checkpoints

Nine files in `flouna-lora-v6-run2/`, every one 42,229,570 bytes with 224 LoRA
tensors (`down_proj.lora_a` [8960, 16], `q_proj.lora_b` [16, 1536]):

`0000200` … `0001600` (8 periodic) plus rolling `adapters.safetensors`.

- Latest / final: `adapters.safetensors` = `0001600_adapters.safetensors`
  sha256 `8b1324fc08d2fe2f0e6d403f5463ec492e321f1a26a97827a259feb007a3391e`
- Best-by-val checkpoint: `0000400_adapters.safetensors`
  sha256 `3130035f62fbd21de606f322075d63729a44dc1821785fdbe0434f1ac8e34a64`
- Integrity: PASS for all 9 files (`safetensors.safe_open`, 224 keys each)
- Run 1 untouched: `flouna-lora-v6-run1/adapters.safetensors` still
  `4059e414c92fc1141a1964b523b80271fda9b2bdc19944b4a15dc3054ee50d4f`

**Model-selection rule for Phase 11 (fixed before evaluation):** the V6 model
is the final Run 2 checkpoint (`0001600`). Choosing any other checkpoint after
seeing holdout scores would be tuning against the sealed set, so no
holdout-based checkpoint selection will be done.

## Data and configuration

| Item | Value |
|---|---|
| Run 2 dataset | `/tmp/flouna_v6_run2/train.jsonl`, 727 rows, sha256 `41929c46e8a6aa7becda07ed2c692c9350c49f203895cbdfa0a72046e3337684` |
| Validation | `/tmp/flouna_v6_run2/valid.jsonl`, 281 rows, sha256 `58d745feaccdd51de2286a0ea32533372e836cc47b8c8eeeac8241e5843daa84` |
| Config | `configs/v6_run2.yaml`, sha256 `adaa4db6ca3ec34c6708cd8c9443c12b1c4a98038365db47d51fc38ac0f1342e` |
| Command | `caffeinate -i .venv/bin/python -u -m mlx_lm lora -c configs/v6_run2.yaml` (opened from Terminal.app) |
| Resume | `resume_adapter_file` = run 1 `adapters.safetensors`; first val 0.043 vs 1.220 from base proves the adapter loaded |
| Schedule | lr 8e-5, cosine to 1600, warmup 30, micro-batch 1, accum 4, max_seq_length 1152 |
| Sealed holdout | untouched, `eval_mlx_v5.jsonl` sha256 `f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a`, mtime Nov 10 |

## Repository state

- Branch `feat/flouna-1.5b-v6-training`, HEAD `10db26a5c86d63ba3d0e0c1a0b4e92b7a6bd2fb0`,
  remote `origin https://github.com/Algorithec/flouna.git`
- 19 working-tree entries, all under `model/` (V6 tooling, data, configs,
  results, plus the pre-existing edits to `flouna_schema.py` and
  `validate_dataset.py`). Run 2 wrote only `flouna-lora-v6-run2/` (gitignored)
  and `results/logs/v6_run2_train.log`, plus this report.
- Website, frontend, backend, production Ollama and production config: untouched.
