# FLOUNA 1.5B — V4 baseline (fresh, locally measured)

Measured on 2026-11-14 with `eval_v5.py` (batched MLX inference, greedy
decoding) on the MacBook M2 16 GB. No older report numbers were reused.

## What was evaluated

The original V4 adapter was not committed to this repository, so the V4
baseline was reconstructed from the V4 data and the repo's PEFT recipe:

| Item | Value |
|---|---|
| Base model | `Qwen/Qwen2.5-1.5B-Instruct` |
| Adapter | `model/flouna-lora-v4-baseline` (checkpoint `0000200`) |
| Training data | `model/train_mlx.jsonl` (5,400 rows) |
| System prompt | 402-token compact training prompt |
| LoRA | rank 16, scale 2.0 (= PEFT alpha 32 / r16), dropout 0.05, last 16 layers |
| Optimizer | AdamW, lr 2e-4 cosine, 20-step warmup, batch 4 |
| Steps run | 200 (val loss 0.052); stopped to preserve GPU hours for V5 |
| Config | `model/configs/v4_baseline.yaml` |
| Repro | `.venv/bin/python -m mlx_lm lora -c configs/v4_baseline.yaml` |

The checkpoint is a V4-equivalent local baseline, not the missing production
adapter. All numbers below are this checkpoint's measured output.

## Evaluation sets

| Set | Rows | Notes |
|---|---:|---|
| `fixtures` | 113 | repo tuned intent fixtures (`server/test/fixtures/intent-eval.jsonl`) |
| `fixtures-holdout` | 87 | repo sealed fixtures; totals only |
| `valid` | 281 | V5 generator validation split; never trained on |
| `holdout` | 382 | V5 sealed holdout; never trained on |
| `v4eval` | 540 | original `model/eval_mlx.jsonl` |

Definitions: **fully right** = JSON parses, passes schema validation and every
expected field matches. **labels right** = all expected fields match regardless
of schema errors. **domain** = domain field matches. Fully-right is strict: a
row with one wrong null/default field counts as wrong.

## Overall results

| Set | Fully right | Labels right | Domain | JSON valid | Parse ok |
|---|---:|---:|---:|---:|---:|
| fixtures | 92/113 · **81.4%** | 81.4% | 97.3% | 100.0% | 100.0% |
| fixtures-holdout | 71/87 · **81.6%** | 81.6% | 93.1% | 97.7% | 100.0% |
| valid | 117/281 · **41.6%** | 41.6% | 100.0% | 97.5% | 100.0% |
| holdout | 168/382 · **44.0%** | 44.0% | 97.1% | 98.7% | 100.0% |
| v4eval | 109/540 · **20.2%** | 20.2% | 96.9% | 98.9% | 100.0% |

Latency (batched, p50/p95): fixtures 1127/1490 ms, fixtures-holdout 1069/1668 ms,
valid 1621/1878 ms, holdout 1364/1787 ms, v4eval 3259/3891 ms.
No errors, timeouts or prompt leaks in 1,403 rows.

## Field accuracy

### fixtures (113)

| Field | Accuracy |
|---|---:|
| food.priority | 61.1% (11/18) |
| food.dietary | 66.7% (4/6) |
| food.item | 87.5% (28/32) |
| food.budgetPaise | 90.0% (18/20) |
| ride.pickup | 66.7% (2/3) |
| ride.priority | 81.8% (9/11) |
| ride.vehicle | 100.0% (15/15) |
| shop.* | 100.0% |

### fixtures-holdout (87)

| Field | Accuracy |
|---|---:|
| food.priority | 72.7% (8/11) |
| food.dietary | 60.0% (6/10) |
| ride.priority | 33.3% (1/3) |
| ride.vehicle | 100.0% (16/16) |
| shop.priority | 66.7% (2/3) |

### valid / holdout (food)

| Field | valid | holdout |
|---|---:|---:|
| food.item | 96.1% | 93.3% |
| food.budgetPaise | 96.6% | 96.9% |
| food.maxEtaMinutes | 100.0% | 99.0% |
| food.priority | 63.5% | 70.3% |
| food.dietary | 60.1% | 53.3% |

### valid / holdout (ride and shop)

| Field | valid | holdout |
|---|---:|---:|
| ride.drop | 97.4% | 96.0% |
| ride.pickup | 80.8% | 91.2% |
| ride.vehicle | 83.3% | 86.4% |
| ride.priority | 82.1% | 71.2% |
| ride.maxPickupMinutes | 96.2% | 92.0% |
| ride.scheduleAt | 97.4% | 98.4% |
| shop.priority | — | 44.0% |
| shop.category | — | 90.0% |

## Known-failure status in the baseline

| Known problem | Baseline measurement |
|---|---|
| out_of_scope → greeting | 1 case (`fixtures-holdout`); OOS domain accuracy 85% on holdout, 100% on fixtures |
| `priority:"cheap"` | 0 literal occurrences; priority confusion is the real issue (see below) |
| `priority:"fast"` | 0 literal occurrences |
| `dietary:"non-veg"` | 2 rows emitted `"non veg"` (space), 1 emitted `"vegetarian"`; schema-invalid |
| flat JSON instead of nested | 0 rows in 1,403 |

Additional baseline defects found:

- **Hard-coded `ride.pickup = "MG Road"`** in 283/1,403 predictions. Cause: V4
  ride data used `MG Road` as a pickup in a large share of rows, so the model
  learned it as a default. v4eval `ride.pickup` accuracy is only 19.6%.
- **Veg cues ignored**: `veg → any` in 133 food rows. V4 had only 34 explicit
  veg examples.
- **Priority drift**: `balanced → speed` 37, `speed → balanced` 31,
  `balanced → price` 13, `speed → price` 11, `price → speed` 7.
- **Phantom budget**: "find me a cheap pizza" produced `budgetPaise: 10000`.
  V5 data clears budgets that only came from a cheapness cue.
- **Invalid domain output**: "what is the fastest option" produced
  `"domain":"speed"` and malformed JSON (manual probe).
- **OOS misroutes**: 4 OOS rows → `shop`, 1 → `ride`, 1 → `food`, 1 →
  invalid `admin` domain.

## Confusion (domain, selected cells)

| Set | OOS→greeting | OOS→shop | OOS→out_of_scope | greeting→OOS |
|---|---:|---:|---:|---:|
| fixtures | 0 | 2 | 10 | 1 |
| fixtures-holdout | 1 | 0 | 7 | 1 |
| holdout | 0 | 2 | 17 | 1 |

## Artifacts

- `results/v4_baseline.json` — per-set metrics
- `results/v4_baseline.jsonl` — per-row predictions (raw + parsed)
- `results/logs/v4_baseline_eval.log` — full console report
- `results/v4_manual_raw.json` — 16 raw manual responses
- `results/logs/v4_baseline_train.log` — training log
