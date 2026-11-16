# FLOUNA V7 run 1, fixed — dataset and training preflight

Generated 2026-11-16. This report covers the repair of the V7 run 1 sequence-length
failure, the rebuilt dataset in `model/data/v7_fixed/`, the real-tokenizer preflight,
the full QA rerun, the corrected config and the no-optimization dry run.

**V7 FIXED DATASET READY FOR TRAINING.**

Training has **not** been started. See section 15.

---

## 1. Root cause

V7 run 1 produced `nan` on the first validation batch and on the first training
report step, so no checkpoint was ever written. The 382-case sealed holdout was
not evaluated.

The cause was the system prompt, not the labels:

- 45% of rows (2,189 of 4,867) carried the production system prompt read from
  `server/src/modules/chat/llm/prompt.ts`. It is 6,053 characters and tokenizes
  to about **1,589 tokens** on the Qwen2.5-1.5B-Instruct tokenizer.
- mlx-lm tokenizes the row as system + user + assistant and returns a
  `prompt_offset`. With `mask_prompt=True`, `default_loss` masks every position
  below the offset: `mask = (steps >= offset) & (steps <= total)`.
- For every production-prompt row the offset was 1,603–1,650 tokens, above
  `max_seq_length: 1152`. The sequence was truncated, the assistant target was
  cut off, and the mask was **empty**. `sum(cross_entropy * mask) / mask.sum()`
  is `0/0` → `nan`.
- One `nan` loss poisons the accumulated gradient, so the next optimizer step
  and every subsequent loss were `nan`.

Confirmed with mlx-lm's own code path (`ChatDataset(mask_prompt=True)`), not a
character-count approximation: all 2,189 production-prompt rows were over 1,152
tokens and all 2,189 had a zero-length loss mask.

The run process was stopped. `model/flouna-lora-v7-run1/` contains only
`adapter_config.json` (1,193 bytes); no `adapters.safetensors` and no checkpoints
exist.

## 2. Original prompt distribution (pre-fix, preserved)

`model/data/v7/` is kept byte-identical as the pre-fix dataset. It was read only.

| prompt | chars | rows (all splits) | train | valid | private eval |
|---|---|---|---|---|---|
| `v6` (V6 training prompt) | 3,555 | 2,044 | 1,732 | 99 | 213 |
| `prod` (verbatim production prompt) | 6,053 | 2,189 | 1,871 | 97 | 221 |
| `short` (V7 short prompt) | 1,149 | 634 | 544 | 29 | 61 |
| **total** | | **4,867** | **4,147** | **225** | **495** |

The production prompt is 1,589 tokens by itself. The prompt mix was 38% / 45% /
17% across the three styles; the fix does not change that mix, only the wording
of the production-style prompt.

## 3. Original token lengths (pre-fix, preserved for reference)

Measured with the Qwen2.5-1.5B-Instruct tokenizer through
`mlx_lm.tuner.datasets.ChatDataset(mask_prompt=True)`. "Total" is the full
system + user + assistant sequence.

| split | rows | min | max | mean | median | p95 | p99 |
|---|---|---|---|---|---|---|---|
| train | 4,147 | 330 | 1,741 | 1,234.69 | 1,050 | 1,704 | 1,727 |
| valid | 225 | 359 | 1,737 | 1,226.30 | 1,052 | 1,709 | 1,732 |
| private eval | 495 | 339 | 1,737 | 1,233.88 | 1,051 | 1,705 | 1,729 |
| **all** | **4,867** | **330** | **1,741** | **1,234.22** | **1,050** | **1,705** | **1,728** |

| threshold | rows |
|---|---|
| total > 900 | 4,233 |
| total > 1,000 | 4,006 |
| total > 1,024 | 3,152 |
| total > 1,100 | 2,189 |
| total > 1,152 (hard fail) | 2,189 |
| empty loss mask | 2,189 |

Every production-prompt row sat at 1,620–1,741 total tokens with a
0-token loss mask. The `v6` rows peaked at 1,090 and the `short` rows at 444,
both within the limit.

## 4. Compact production training prompt design

New file: `model/data/v7/prompts/production_compact.txt`, version line
`FLOUNA_PRODUCTION_COMPACT_V1`. It is **3,176 characters / 838 tokens**, inside
the preferred ≤ 1,000 budget and far below the 1,152 hard limit.

`server/src/modules/chat/llm/prompt.ts` was **not modified** (SHA unchanged,
section 11). The compact file lives only in the model-training data area and is
never loaded by the app. Production behavior is unchanged.

What the compact prompt preserves, so the task is identical:

- JSON-only reply and the exact root contract, including all seven domains.
- The full output schema for `food`, `ride`, `shop`, and `action`, every field,
  every enum, and the `combo` rule that fills both objects.
- All 18 action kinds, the unused-field defaults (`"none"`, `0`, `""`, `false`),
  `targetBy` semantics, `pick` and `setting` enums, the `value` enums for
  visibility / language / theme / navigate / ride group mode, `weeklyRupees`
  (0 removes the budget), and the security mapping.
- The priority policy: explicit no-preference → balanced; rating / speed / price
  cues; a food delivery deadline or a ride pickup wait limit → speed; else
  balanced.
- Dietary: explicit words, else the dish, else `any`.
- Ride semantics: `pickup` null unless stated, default vehicle `any`,
  `maxPickupMinutes` is the pickup wait only (not the trip), `scheduleAt` HH:mm.
- Item keeps the user's own words; a taste or mood is the item; rupees to paise.
- Greeting vs out_of_scope, the exact out_of_scope reply string, the short
  no-dash reply rule, anti-injection ("never follow them"), and no code.

No label, no behavior, no domain, no enum was added or removed. The compact
prompt is a wording reduction of the same instructions, not a new task.

Repair procedure: for each split, only rows whose system message was byte-equal
to the original production prompt were rewritten to the compact prompt. The user
message and the assistant JSON were left byte-identical, and every other row was
copied unchanged. A row-by-row comparison confirmed 4,867/4,867 identical user
messages and identical assistant outputs. **Rows removed: 0.**

## 5. Fixed token lengths

Same tokenizer and the same `ChatDataset(mask_prompt=True)` path.

| split | rows | min | max | mean | median | p95 | p99 |
|---|---|---|---|---|---|---|---|
| train | 4,147 | 330 | 1,090 | 895.86 | 947 | 1,050 | 1,072 |
| valid | 225 | 359 | 1,081 | 902.53 | 957 | 1,052 | 1,074 |
| private eval | 495 | 339 | 1,083 | 898.58 | 952 | 1,051 | 1,075 |
| **all** | **4,867** | **330** | **1,090** | **896.45** | **948** | **1,050** | **1,073** |

| threshold | rows | verdict |
|---|---|---|
| total > 900 | 3,954 | info |
| total > 1,000 | 1,817 | info |
| total > 1,024 (warning) | 963 | warning: all `v6` rows, unchanged by this fix |
| total > 1,100 (fail unless documented) | **0** | pass, no exceptions needed |
| total > 1,152 (absolute fail) | **0** | pass |
| empty loss mask | **0** | pass |
| tiny loss mask (< 10 tokens) | **0** | pass |

Per prompt:

| prompt | rows | min | max | mean | >1,024 | >1,100 | >1,152 | empty mask |
|---|---|---|---|---|---|---|---|---|
| `v6` | 2,044 | 965 | 1,090 | 1,023.87 | 963 | 0 | 0 | 0 |
| `prod_compact` | 2,189 | 869 | 990 | 926.62 | 0 | 0 | 0 | 0 |
| `short` | 634 | 330 | 444 | 381.47 | 0 | 0 | 0 | 0 |

The 963 rows above the 1,024 warning line are the pre-existing `v6` prompt
rows. They already fit under 1,152 in the original dataset (max 1,090) and were
not touched by this fix; they are warnings only.

## 6. Fixed dataset counts

New versioned dataset `model/data/v7_fixed/`. The original `model/data/v7/` was
not overwritten, not deleted and not silently rewritten.

| split | file | rows | before | after | removed |
|---|---|---|---|---|---|
| train | `train_v7.jsonl` | 4,147 | 4,147 | 4,147 | 0 |
| valid | `valid_v7.jsonl` | 225 | 225 | 225 | 0 |
| private eval | `validation/v7_validation.jsonl` | 495 | 495 | 495 | 0 |
| MLX train copy | `training/train.jsonl` | 4,147 | — | 4,147 | 0 |
| MLX valid copy | `training/valid.jsonl` | 225 | — | 225 | 0 |

Rows rewritten per split: train 1,871, valid 97, private eval 221 — exactly the
production-prompt rows. Rows unchanged: 2,276 / 128 / 274.

Train composition by prompt: `prod_compact` 1,871, `v6` 1,732, `short` 544.
Valid: 97 / 99 / 29. Private eval: 221 / 213 / 61. Three prompt styles in every
split, as before.

Category composition is unchanged (same rows, same primary tags):
core 1,636; action_positive 440; action_hard_negative 320;
ride_boundary 280; domain_boundary 230; generic_food 180; greeting_oos 190;
nested 230; dietary 157; production_robustness 224; paraphrase 260.
Action hard-negative share 0.4211.

Train domains: food 1,465, ride 1,250, action 490, shop 389, out_of_scope 295,
combo 140, greeting 118. All schema domains are present.

## 7. QA rerun

All existing checks were rerun against `v7_fixed/`.

- **Schema and semantics** — `data/v7/validate_v7.py --dataset v7_fixed`:
  **30/30 checks PASS**, 0 row errors in all three splits. This covers schema
  validity, action semantics, label conflicts, the priority policy per domain
  and combo part, duplicate detection, row ranges, category ranges, prompt
  coverage, domain coverage and MLX staging consistency.
- **Leakage** — `data/v7/check_leakage_v7.py --dataset v7_fixed`: **PASS**
  (details in section 8).
- **Distribution** — `data/v7/distribution_v7.py --dataset v7_fixed`:
  **no imbalance flags**. Food 35.33%, ride 30.14%, action 11.82%, shop 9.38%,
  out_of_scope 7.11%, combo 3.38%, greeting 2.85%. Vehicles: any 33.67%,
  cab 31.80%, auto 21.58%, bike 12.95%. Dietary: any 39.59%, veg 39.32%,
  nonveg 21.09%. 152 distinct food items, 69 ride drops, 75 shop items,
  3,157 distinct 4-gram prefixes.
- **Token/loss-mask preflight** — section 9; **PASS**.
- **No-optimization dry run** — section 13; **PASS**.

Reports: `validation_v7_fixed.json`, `holdout_leakage_report_fixed.json`,
`v7_distribution_fixed.json` / `.md`, `v7_token_preflight.json`,
`v7_fixed_dry_run.json`.

## 8. Leakage

Sealed holdout `model/eval_mlx_v5.jsonl` (382 rows) is read-only throughout.

| split | rows | exact holdout copies | exact fixture copies | near duplicates | internal duplicates | cross-split duplicates |
|---|---|---|---|---|---|---|
| train | 4,147 | 0 | 0 | 0 | 0 | 0 |
| valid | 225 | 0 | 0 | 0 | 0 | 0 |
| private eval | 495 | 0 | 0 | 0 | 0 | 0 |

Explicit overlap: train vs private eval **0**, train vs valid **0**,
private eval vs valid **0**. Near-duplicate check uses token Jaccard against
the holdout plus the server intent fixtures with the usual threshold.

Holdout SHA256 before and after the run:
`f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a` — unchanged.

## 9. Token preflight (mandatory, real tokenizer)

Script: `data/v7/token_preflight_v7.py`. It loads the actual
`Qwen/Qwen2.5-1.5B-Instruct` tokenizer and processes every row through
`mlx_lm.tuner.datasets.ChatDataset(mask_prompt=True)`, the same path the trainer
uses, and applies the training loss mask
`(step >= prompt_offset) & (step <= total)`.

Per row it records system, user and output tokens, `prompt_offset`, total
sequence tokens, loss-mask tokens, truncation, and the threshold buckets.
Limits enforced:

| rule | value |
|---|---|
| hard fail | total > 1,152 or empty loss mask |
| fail unless documented | total > 1,100 |
| warn | total > 1,024 |
| preferred | total ≤ 1,000 |
| minimum loss mask | 10 tokens |

Result on `v7_fixed`: 4,867 rows, **0 above 1,152, 0 empty masks, 0 tiny masks,
0 undocumented rows above 1,100**. Preferred ≤ 1,000 is met by every
`prod_compact` (max 990) and `short` (max 444) row; only the pre-existing `v6`
rows go above it, and none exceed 1,090.

The validator also reruns these token checks as blocking gates, so a future edit
that reintroduces an over-length row will fail validation before training.

## 10. Loss mask

| split | rows | mask min | mask max | mask mean | mask median | mask p95 | empty | tiny |
|---|---|---|---|---|---|---|---|---|
| train | 4,147 | 17 | 127 | 67.22 | 67 | 100 | 0 | 0 |
| valid | 225 | 23 | 121 | 68.16 | 68 | 102 | 0 | 0 |
| private eval | 495 | 23 | 122 | 66.05 | 65 | 102 | 0 | 0 |
| **all** | **4,867** | **17** | **127** | **67.14** | **67** | **100** | **0** | **0** |

Every assistant target is inside the 1,152-token window, so every row
contributes gradient. This is the exact condition that failed in run 1, where
2,189 rows had a 0-token mask.

## 11. Hashes

SHA256, computed after the final reruns.

### Datasets

| artifact | sha256 |
|---|---|
| `v7_fixed/train_v7.jsonl` | `98be01950daae3d15fef49e51397dbda6a11a1a9433d6cc315f3d31762427899` |
| `v7_fixed/valid_v7.jsonl` | `902a1dbebe99276eb5a281ce4df7653a94a8d23674f2a255b59bb4e28d6b9799` |
| `v7_fixed/validation/v7_validation.jsonl` | `23bdf50cf949e01d8e4118d9427bae2ed70dad79760058b95fc8751479353c08` |
| `v7_fixed/training/train.jsonl` (identical to train) | `98be01950daae3d15fef49e51397dbda6a11a1a9433d6cc315f3d31762427899` |
| `v7_fixed/training/valid.jsonl` (identical to valid) | `902a1dbebe99276eb5a281ce4df7653a94a8d23674f2a255b59bb4e28d6b9799` |
| `v7_fixed/fix_manifest.json` | `3d901dff3140fed73baa07d1c78c474f5736f11b8ed316fee996e9bfd69011a3` |

### Pre-fix dataset (preserved, unchanged)

| artifact | sha256 |
|---|---|
| `v7/train_v7.jsonl` | `678338cba7af5277e6e39c99ecfdcd3ee63b90be983865da71e61cc1797878bf` |
| `v7/valid_v7.jsonl` | `6cf147ed4ae801d38999a8d3d418e443de574f44880983e1c3f9bff32737baee` |
| `v7/validation/v7_validation.jsonl` | `2467d61641064dda43bf829ef9c2c328344ddca0acf65e698248d54d432b8e8a` |

### Prompt, config, sealed holdout, reports

| artifact | sha256 |
|---|---|
| `data/v7/prompts/production_compact.txt` | `52d22515559df19be7b2264e614905f7cfbcbabd0e8c338a8d487e0e24e72858` |
| `configs/v7_run1_fixed.yaml` | `21faae0e39e858d1572b7206f58c0c15d6e600fb4b4e54a5c3c287c8419762e7` |
| `model/eval_mlx_v5.jsonl` (sealed holdout) | `f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a` |
| `server/src/modules/chat/llm/prompt.ts` (untouched) | `907de19eeccd8a4c89e7dc963830ca321b9a47725e7faa599b0b05b10dfffec6` |
| `reports/v7_token_preflight.json` | `0b02bcd3e9ab65da46f2f7cf1dcb6bd3d0280e0cb2a1d3977a8a585c88f780ed` |
| `reports/validation_v7_fixed.json` | `51ce478d5f2ea1b20f80e72c6de5a5622a73f247d928cbccb898d15434cb0718` |
| `reports/holdout_leakage_report_fixed.json` | `9db42ed31081c887f24dd494931f26a78b60bb6e03a958c9c9e7b8e0a1834935` |
| `reports/v7_distribution_fixed.json` | `b196a3125c1f3c2514de1b32cdcba1499d155dde102fcd35d2155abbca074d7c` |
| `reports/v7_fixed_dry_run.json` | `53d757abebbdcb3112e60850d1c4e8322710e114633ddc51b9cfc006d553afd5` |

## 12. Configuration

`configs/v7_run1_fixed.yaml`. Same recipe as `v7_run1.yaml`; only `data` and
`adapter_path` differ.

| setting | value | changed |
|---|---|---|
| model | `Qwen/Qwen2.5-1.5B-Instruct` | no |
| fine-tune | LoRA, rank 16, scale 2.0, dropout 0.05, last 16 layers | no |
| mask_prompt | true | no |
| optimizer | AdamW, grad checkpoint | no |
| max_seq_length | **1,152** | no — explicitly not raised |
| batch | micro-batch 1, accumulation 4 | no |
| schedule | 1,600 iters, lr 1.5e-4, cosine, warmup 50 | no |
| seed | 11 | no |
| val_batches / report / eval / save | 2 / 20 / 200 / 200 | no |
| data | `model/data/v7_fixed/training` | yes |
| adapter_path | `model/flouna-lora-v7-run1-fixed` | yes (new directory) |

`model/flouna-lora-v7-run1/` is not reused and stays in place with only its
config file.

## 13. Dry run (no optimization)

Script: `data/v7/dry_run_v7_fixed.py`. It loads the config, loads the real
tokenizer, runs the full token/loss-mask preflight, loads both splits through
`mlx_lm.lora.load_dataset`, builds the first train and validation batches through
`iterate_batches`/`CacheDataset`, loads the base model, applies the same LoRA
recipe, runs one forward pass per batch and checks the loss is finite.
`optimizer_steps: 0`, `adapter_written: false`.

Result: **19/19 checks PASS**, 17.33 s.

- adapter directory absent before and after, no resume adapter, max_seq 1,152,
  LoRA recipe identical.
- train 4,147 rows / max 1,090 tokens / 0 empty masks; valid 225 / 1,081 / 0;
  private eval 495 / 1,083 / 0.
- first train batch shape `[1, 417]`, 76 mask tokens; first valid batch
  `[1, 993]`, 29 mask tokens; both masks non-empty.
- base model loads; LoRA applies to 16 layers; 10,551,296 trainable of
  1,543,714,304 total (0.684%).
- forward loss finite: train 2.10264 (77 tokens), valid 2.47592 (30 tokens).
- adapter directory still absent after the preflight.

## 14. Exact future training command (not run)

From `model/`:

```bash
caffeinate -i .venv/bin/python -u -m mlx_lm lora -c configs/v7_run1_fixed.yaml
```

Expected adapter output: `model/flouna-lora-v7-run1-fixed/`, 1,600 iterations,
micro-batch 1 with accumulation 4, max_seq_length 1,152.

Do not raise `max_seq_length` on the 16 GB M2. The dataset now fits at 1,152
with every assistant target intact.

## 15. Safety confirmation

- Original `model/data/v7/` preserved: hashes unchanged (section 11).
- New `model/data/v7_fixed/` created and fully validated.
- Token/loss-mask preflight PASS; dry run PASS; validator 30/30 PASS; leakage
  PASS; distribution no flags.
- Sealed holdout `model/eval_mlx_v5.jsonl` byte-identical, not trained on,
  not copied: `f412d8fc…e603a`.
- `server/src/modules/chat/llm/prompt.ts` not modified: `907de19e…ffec6`.
  No production app, backend, frontend, API, schema, normalization or deploy
  change.
- No new GGUF exported (the only GGUF files present are the pre-existing V5
  ones), no Ollama update, no secret change.
- No training process running; no optimizer step taken; fixed adapter directory
  absent; failed run directory untouched.
- No commit and no push. Working tree changes are confined to `model/`.

**V7 FIXED DATASET READY FOR TRAINING.**

**V7 TRAINING NOT STARTED.**
