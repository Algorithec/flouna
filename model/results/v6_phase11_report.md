# FLOUNA V6 — PHASE 11 FINAL EVALUATION

Evaluation only. No training, no dataset edits, no holdout edits, no checkpoint
selection from holdout scores, no GGUF export, no Ollama model, no production
changes. The V6 checkpoint and the sealed holdout were both checksum-verified
before scoring.

## Official V6 Checkpoint

- Path: `flouna-lora-v6-run2/0001600_adapters.safetensors`
- SHA256: `8b1324fc08d2fe2f0e6d403f5463ec492e321f1a26a97827a259feb007a3391e`
- Selection rule: "V6 Phase 11 model = final Run 2 checkpoint (0001600)", fixed before any holdout scoring.
- Why selected: pre-registered end-of-run checkpoint; validation loss was **not** used to pick among checkpoints for this report. No other checkpoint was scored.
- Loading detail: `mlx_lm.load_adapters` needs an adapter *directory*, so the harness loaded `flouna-lora-v6-run2/`, whose `adapters.safetensors` is byte-identical to `0001600_adapters.safetensors` (same SHA256, verified by assertion inside the run script before any case was scored).

## Sealed 382-Case Holdout

All 382 cases were scored, no sampling, no reruns.

| Prompt used | Correct | Accuracy |
|---|---:|---:|
| **V6 training prompt (`--prompt v6`, official)** | **352 / 382** | **92.15%** |
| V5 training prompt (`--prompt own` = prompt embedded in holdout) | 337 / 382 | 88.22% |
| Production prompt (`prompt.ts`, `--prompt prod`) | 325 / 382 | 85.08% |

Official-run detail (V6 checkpoint, V6 prompt):

- Total: 382
- Correct: 352
- Incorrect: 30
- Accuracy: 92.15%
- Exact match (fully right = parse + schema valid + every asserted field): 352/382
- Domain: 374/382 (97.91%)
- Food priority: 189/195 (96.92%)
- Dietary: 189/195 (96.92%)
- Ride: 97/105 (92.38%)
- Nested: 340/370 (91.89%)
- JSON: 382/382 (100%)
- OOS: 18/20 (90.0%)
- False greeting: 0/370 (0%)
- Parse OK: 382/382; latency p50 4.72 s, p95 7.13 s, max 10.88 s (batch 4, 512 max tokens)
- Domain confusion (expected→actual): 172 food→food, 105 ride→ride, 49 shop→shop, 20 combo→combo, 18 oos→oos, 10 greeting→greeting, 3 food→shop, 2 greeting→oos, 2 oos→action, 1 shop→action

## V5 Baseline

Source: `results/v5_run2.json` (not regenerated, not modified).

- Total: 382
- Correct: 344
- Accuracy: 90.05%

## V5 vs V6

Same 382 cases, same scoring definitions, same prompt (the holdout's own V5
prompt). This is the apples-to-apples comparison.

| Metric | V5 | V6 (V5 prompt) | Delta |
|---|---:|---:|---:|
| Overall | 344/382 90.05% | 337/382 88.22% | −1.83 pp |
| Domain | 377/382 98.69% | 376/382 98.43% | −0.26 pp |
| Food priority | 187/195 95.90% | 181/195 92.82% | −3.08 pp |
| Dietary | 187/195 95.90% | 188/195 96.41% | +0.51 pp |
| Ride | 94/105 89.52% | 95/105 90.48% | +0.96 pp |
| Nested | 324/370 87.57% | 322/370 87.03% | −0.54 pp |
| JSON | 381/382 99.74% | 381/382 99.74% | 0.00 pp |
| OOS | 20/20 100.0% | 20/20 100.0% | 0.00 pp |
| False greeting | 0/382 0.0% | 0/382 0.0% | 0.00 pp |

Supplementary — V6 under the prompt it was actually trained with (not
apples-to-apples with V5, shown for completeness):

| Metric | V5 (V5 prompt) | V6 (V6 prompt) | Delta |
|---|---:|---:|---:|
| Overall | 344/382 90.05% | 352/382 92.15% | +2.09 pp |
| Domain | 377/382 98.69% | 374/382 97.91% | −0.78 pp |
| Food priority | 187/195 95.90% | 189/195 96.92% | +1.02 pp |
| Dietary | 187/195 95.90% | 189/195 96.92% | +1.02 pp |
| Ride | 94/105 89.52% | 97/105 92.38% | +2.86 pp |
| Nested | 324/370 87.57% | 340/370 91.89% | +4.32 pp |
| JSON | 381/382 99.74% | 382/382 100.0% | +0.26 pp |
| OOS | 20/20 100.0% | 18/20 90.0% | −10.00 pp |
| False greeting | 0/382 0.0% | 0/370 0.0% | 0.00 pp |

Note: earlier planning notes quoted V5 "Ride 85.6%" and "Nested 89.4%". Those
numbers are not present in any recorded V5 artifact; the artifacts give
89.52% and 87.57% respectively, and those artifact values are used above.

## Action Set

72 cases, V6 prompt.

- Total: 72
- Correct: 57
- Accuracy: 79.17%
- JSON valid: 70/72; domain right: 59/72
- Action positives: 47/50 (94.0%); kind right 49/50 (98%)
- Hard negatives staying non-action: only 10/22 (45.5%)
- V5 on the same set/prompt: 15/72 (20.83%) → **+58.34 pp**
- Under the production prompt: 47/72 (65.28%), positives 38/50 (76%) → the
  production prompt costs 10 cases

Failures (15): 7 domain classification, 4 out-of-scope, 2 other, 2 schema.
Representative:

- action-54…59 (6 cases): greetings ("good morning", "hello") → `action`
  instead of `greeting`. The model over-triggers action on greet-like prompts.
- action-61: out-of-scope ("what's the weather") → `action`.
- action-64: kind `cancel` emitted, not in the action schema.
- action-62: action object missing required keys but carrying `reply`.
- action-17: action request answered as `food`.
- action-24 / action-32: `withMyItems` / `value` slot errors inside an otherwise correct kind.

## Paraphrase Set

103 cases, V6 prompt.

- Total: 103
- Correct: 83
- Accuracy: 80.58%
- JSON valid: 102/103; domain right: 95/103
- V5 on the same set/prompt: 69/103 (66.99%) → **+13.59 pp**

Category breakdown of the 20 failures: priority 7, domain classification 5,
other 3, out-of-scope 2, entity extraction 1, ride 1, schema 1.

Representative: paraphrase-1/8 (`balanced` → `speed`/`rating`), paraphrase-12
("idli" → item "breakfast"), paraphrase-36/40 (ride `balanced` → `speed`),
paraphrase-41 (pickup "my home" dropped), paraphrase-78 (`group.show` →
`navigate`).

## Production Prompt

Prompt source: `prompt.ts`, read through `eval_v5.production_prompt()`. Not modified.

Results (V6 checkpoint, production prompt):

- 382-case holdout: 325/382 = **85.08%** (JSON 377/382, domain 371/382, OOS 17/20, false greeting 0)
- Priority 178/195 (91.28%), nested 313/370 (84.59%), ride 93/105 (88.57%)
- Action set: 47/72 (65.28%) vs 57/72 under the V6 prompt

Action-domain behavior:

- The production prompt advertises an `action` domain that V6 only partly maps.
  Observed: 2 out-of-scope → `action`, 1 shop → `action`.
- Invalid labels leaked through under this prompt: domain `speed` (1 case) and
  action kinds `translate`, `currency.convert`, `cancel` → 5 schema-invalid outputs.
- Nested keys occasionally dropped (`ride.scheduleAt` missing on 1 ride case).

Any regression: yes. Compared with the V6 prompt this is −7.07 pp overall and
−13.87 pp on action; compared with V5 on the same holdout it is −4.97 pp.

Any improvement: none attributable to the production prompt. Its wording
misaligns with the labels V6 was trained on.

No V5 production-prompt holdout baseline exists (`results/v5_final_prod.json`
is the 113-case fixtures set at 92.9%), so no V5-vs-V6 production-prompt delta
is reported.

## Error Analysis

Total V6 errors: 30 (V6 prompt) / 45 (V5 prompt) / 57 (production prompt).

Main failure categories (V6 prompt, 30):

| Category | n | % of failures |
|---|---:|---:|
| ride | 10 | 33.3% |
| domain classification | 6 | 20.0% |
| entity extraction | 6 | 20.0% |
| priority | 4 | 13.3% |
| dietary | 2 | 6.7% |
| out-of-scope | 2 | 6.7% |

Of the 30:

- **7 are source-label contradictions**, verified by reading the sealed case
  text — the text does not support the expected value:
  - holdout-169, -230, -231: expected `ride.pickup` (Secunderabad / Kothapet /
    Charminar) but the text names no pickup.
  - holdout-273, -274, -279, -282: expected `ride.vehicle` cab/auto in combo
    requests that only say "a ride".
- **~7 are ambiguous examples** where the model's answer is defensible:
  holdout-12 ("send dosa ASAP" → dietary veg vs expected any), -64/-145 (item
  "something light"/"sev puri" vs "dinner"/"lunch"), -83/-106/-175/-176
  (`balanced` vs `speed` when ETA/wait language is present).
- **~16 are genuine model errors**, dominated by:
  1. "ceiling" hijacking domain: "get me dinner ceiling of ₹200",
     "Low-cost jeera rice ceiling of ₹500" → `shop` with item "ceiling"
     (holdout-63, -132; also -71).
  2. Generic item fallback: "I WANT MANCHURIAN", "POHA UNDER 400 RUPEES…",
     "chicken 65 under 300…", "something healthy" → item "food"/"lunch" instead
     of the dish (holdout-108, -111, -145, -330, -350).
  3. `ride.vehicle: any` defaulted to `cab` (holdout-167, -223, -225).
  4. Action over-trigger outside the action set (holdout-28 "start a business
     plan", -49 "convert 10 dollars", -263 "Compare wallet options?").
  5. Greeting boundary: "thanks for the help earlier", "thank you so much"
     → `out_of_scope` instead of `greeting` (holdout-35, -41).

Most important remaining failure modes:

1. Prompt-lock: V6 only reaches its best numbers with its own training prompt;
   under the V5 prompt it is 1.83 pp *below* V5, under the production prompt
   5 pp below.
2. Priority semantics (`balanced` vs `speed`/`price`) are unstable — 23 of the
   45 V5-prompt failures, 31 of 57 production-prompt failures.
3. Action over-firing on greetings/out-of-scope (~45% of hard negatives stay
   non-action).
4. Slot-level slips (`withMyItems`, `value`, missing nested keys) rather than
   wholesale hallucinations.

Holdout was not modified because of any of these observations.

## 99% Target

- Achieved: **No**
- Actual (official, V6 prompt): 352/382 = 92.15%
- Gap: 6.85 pp; need 379/382 for 99%, i.e. 27 more correct answers
- Remaining errors: 30 (of which 7 are label contradictions and ~7 ambiguous)

## Integrity

- Holdout checksum verified: **YES** — `f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a`
- V6 checkpoint checksum verified: **YES** — `8b1324fc08d2fe2f0e6d403f5463ec492e321f1a26a97827a259feb007a3391e`
- Holdout modified: **NO**
- Training data modified: **NO** (`/tmp/flouna_v6_data/train.jsonl` `3b8a9911…5d3fde`, `/tmp/flouna_v6_run2/train.jsonl` `41929c46…337684` unchanged)
- Production touched: **NO**
- Website touched: **NO**
- Backend touched: **NO**
- GGUF exported: **NO**
- Ollama created: **NO**

## Evaluation-tooling changes (evaluation only)

Three small fixes, none touching scoring definitions:

1. `eval_v5.py` `aggregate()`: confusion keys sorted via `str()` so an
   unparsable output (`got_domain = None`) no longer crashes the report.
   Counts and scores unchanged.
2. `eval_v6.py` `action_breakdown()`: the callable `pct` was stored in the
   metrics dict and broke `--json` serialization; it is now a string
   `positives_pct`. Counts unchanged.
3. Adapter resolution: `--adapter` receives the run directory (mlx-lm
   requirement); the loaded file is asserted against the pre-registered
   SHA256 before scoring.

## Reproducibility

- V6 checkpoint: `flouna-lora-v6-run2/0001600_adapters.safetensors` (`8b1324fc…3391e`)
- Holdout: `eval_mlx_v5.jsonl` (`f412d8fc…e603a`), 382 cases, mtime Nov 10
- V5 baseline: `results/v5_run2.json`
- Scripts: `eval_v6.py` (runner), `eval_v5.py` (harness), `analyze_phase11.py` (offline classification)
- Config: backend mlx, `Qwen/Qwen2.5-1.5B-Instruct`, batch 4, max 512 tokens, greedy
- Production prompt: `prompt.ts` via `eval_v5.production_prompt()`
- Git branch: `feat/flouna-1.5b-v6-training`; HEAD `10db26a5c86d63ba3d0e0c1a0b4e92b7a6bd2fb0`
- Python 3.12.16; mlx 0.32.4; mlx-lm 0.32.2; safetensors 0.8.0; gguf 0.19.0
- Artifacts: `results/v6_phase11_sealed.json`, `v6_phase11_action.json`,
  `v6_phase11_paraphrase.json`, `v6_phase11_production_prompt.json`,
  `v6_phase11_comparison.json`, `v6_phase11_analysis.json` (+ raw per-prompt
  result and prediction files), logs in `results/logs/v6_phase11_*.log`

## Stop

Phase 11 is complete. Nothing was retrained, exported, deployed, or selected
based on these scores.
