# FLOUNA AI — V7 dataset engineering and pre-training report

Scope: model data only. No training run, no GGUF export, no Ollama change, no
production/website/frontend/backend change, no commit, no push.

Date: 2026-11-16
Branch: `feat/flouna-1.5b-v6-training` at `10db26a`
Remote: `origin https://github.com/Algorithec/flouna.git` (fetch/push)

## 1. Safety and integrity

| Item | Result |
|---|---|
| Sealed holdout | `model/eval_mlx_v5.jsonl`, 382 rows, 742,135 bytes, mtime Nov 10 15:42 |
| Holdout SHA256 before V7 work | `f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a` |
| Holdout SHA256 at report time | `f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a` |
| Holdout modified / reordered / regenerated | NO |
| Trained on holdout | NO |
| V6 corpus modified | NO (read-only source, copied byte-identically to `data/v7/source/`) |
| V5/V6 adapters, configs, results modified | NO (new V7 files only) |
| V7 training executed | NO (no `model/flouna-lora-v7-run1/`) |
| GGUF exported | NO |
| Production Ollama / secrets / prompt.ts / APIs / DB / ONDC / deploy touched | NO |
| Commit / push | NO |

`build_v7.py` asserts the holdout SHA before and after every build; every build
printed the same hash. `validate_v7.py` and `check_leakage_v7.py` re-assert it.

## 2. Repository state at end (git)

```
$ git status --short model
 M model/eval_v5.py
 M model/flouna_schema.py
 M model/validate_dataset.py
?? model/configs/v7_run1.yaml
?? model/data/                       (entire V7 tree; also V6 audit inputs)
?? model/train_mlx_v7.jsonl
?? model/valid_mlx_v7.jsonl
... (V6-phase files from earlier work remain untracked, unchanged)

$ git diff --stat
 model/eval_v5.py          |   6 +-
 model/flouna_schema.py    | 193 +++++++++++++++++++++++++++++++++++++++++++++-
 model/validate_dataset.py |  16 ++++
 3 files changed, 210 insertions(+), 5 deletions(-)
```

The three modified files were last written 2026-11-15 by the earlier V6 phases
(mtimes 21:20 / 09:57 / 10:03); they were only imported, never edited in the V7
work. V7 added files only:

```
model/configs/v7_run1.yaml
model/data/v7/
  audit_corpus_v7.py  build_v7.py  v7_lib.py  v7_generators.py
  check_leakage_v7.py  validate_v7.py  distribution_v7.py
  dataset_audit_v7.json / .md
  source/train_mlx_v6.jsonl                     (byte copy, sha 3b8a9911…)
  cleaned/core_from_v6.jsonl
  generated/<category>.jsonl
  training/train.jsonl  training/valid.jsonl
  validation/v7_validation.jsonl + manifest
  train_v7.jsonl  valid_v7.jsonl  build_manifest.json
  dataset_audit_v7.json / .md
  reports/build_report.json
  reports/holdout_leakage_report.json
  reports/validation_v7.json
  reports/v7_distribution.json / .md
model/train_mlx_v7.jsonl  model/valid_mlx_v7.jsonl
model/results/v7_pretraining_report.md
```

Config path note: the spec named `model/config/v7_run1.yaml`; this repo keeps
every run config in `model/configs/` (`v4_baseline.yaml` … `v6_run2.yaml`), so
V7 follows the established convention at `model/configs/v7_run1.yaml`.

## 3. Audit of the existing corpus (phases 3–4)

Source: `model/train_mlx_v6.jsonl`, 11,418 rows, 47,518,874 bytes,
SHA256 `3b8a991102b1aab0f5ce075b6ad23690773d7a625c5e6104d267da392f5d3fde`.

Result (`data/v7/dataset_audit_v7.json` / `.md`):

- JSON parse errors 0; schema/action-semantics errors 0; label conflicts 0.
- Exact duplicate texts 0; contradictory text groups 0.
- Near-duplicate pairs: 1 at ≥0.9, 9 at ≥0.8.
- Holdout leakage: 0 exact, 0 near (≥0.8); fixture leakage 0.
- Semantic weak spots (a corpus property, not corruption):
  - 425 rows labelled `balanced` while the text carries a priority cue;
  - 75 rows use a generic item (`food`) instead of the named food;
  - 5 rows labelled `speed` without a speed cue;
  - 1 short acknowledgement ("okay") labelled `out_of_scope`;
  - 1,098 multi-cue rows with no single documented precedence.
- Coverage gaps that explain the V6 failures: 0 rows with "ceiling of ₹X"
  wording, 4 bare generic food entities, only 193 action rows, 40 greeting
  rows, 105 OOS rows, and one system prompt for all 11,418 rows.
- Template redundancy: 1,720 texts sit in templates used more than 40 times.

The source was never modified; `audit_corpus_v7.py` copies it to
`data/v7/source/` and asserts the copy SHA.

## 4. V7 dataset

Built by `data/v7/build_v7.py` (seeds: train 7, valid 404, eval 2026) from the
audited V6 core plus explicit boundary families. Every row is gated by
`v7_lib.Builder`: schema + action semantics, label consistency, priority-policy
consistency, exact-normalised holdout/fixture exclusion, ≥0.8 4-gram Jaccard
exclusion, and duplicate rejection. Rejected rows never enter a split.

| Split | Rows | SHA256 |
|---|---|---|
| `data/v7/train_v7.jsonl` | 4,147 | `678338cba7af5277e6e39c99ecfdcd3ee63b90be983865da71e61cc1797878bf` |
| `data/v7/valid_v7.jsonl` | 225 | `6cf147ed4ae801d38999a8d3d418e443de574f44880983e1c3f9bff32737baee` |
| `data/v7/validation/v7_validation.jsonl` (private eval) | 495 | `2467d61641064dda43bf829ef9c2c328344ddca0acf65e698248d54d432b8e8a` |
| sealed holdout (untouched) | 382 | `f412d8fc…e603a` |

Staged for MLX at `/tmp/flouna_v7_data/{train,valid}.jsonl` with the same SHAs
as `data/v7/training/`. Copies exist at `model/train_mlx_v7.jsonl` and
`model/valid_mlx_v7.jsonl` for repo parity with V5/V6.

### Composition vs the requested targets

| Category | Target | V7 | Note |
|---|---|---|---|
| Core | 1,500–1,800 | 1,636 | audited V6 core + new core, policy-cleaned |
| Action positives | ~500 | 440 | 18/18 action kinds, all target/qty/member/value fields |
| Action hard negatives | ~300 | 320 | 42.1% of action-focused rows (target 40–45%) |
| Ride boundaries | ~300 | 280 | vehicle any/cab/auto/bike, pickup, wait vs trip deadline |
| Domain boundaries | ~250 | 230 | same price phrase across food/ride/shop + OOS hotel/flight/train |
| Generic food | ~200 | 180 | 20 bare dishes, moods, dietary and price variants |
| Greeting / OOS | ~200 | 190 | greeting, thanks, farewell, ack, OOS, greeting+request |
| Nested minimal pairs | ~250 | 230 | one attribute at a time, 32 base pairs |
| Dietary | 150–200 | 157 | veg/nonveg adjectives, dish-implied, explicit statements |
| Production-prompt robustness | ~300 | 224 | ceiling wording, bare entities, vehicle any/cab, prod-prompt core |
| Paraphrases | ~300 | 260 | 7 base intents × surface forms |
| **Total** | 3,500–4,500 | **4,147** | quality > count; no filler rows |

Hard-negative families are balanced deliberately, not left to one template:
discovery-phrased ordering 160, complaint/status 97, greeting-with-order 19,
comparison 29, app-information 15. This was a real bug caught late: the bucket
had filled 100% with discovery rows before the other families ran; per-family
quotas fixed it.

### Distribution (`reports/v7_distribution.json` / `.md`)

- Domains: food 35.3%, ride 30.1%, action 11.8%, shop 9.4%, out_of_scope 7.1%,
  combo 3.4%, greeting 2.9%.
- System prompts: canonical V6 41.8%, production `prompt.ts` 45.1%, short 13.1%.
- Ride vehicles: any 33.7%, cab 31.8%, auto 21.6%, bike 13.0%.
- Food dietary: any 39.6%, veg 39.3%, nonveg 21.1%.
- Priority labels (food/ride/shop/combo parts): balanced 72.1%, speed 14.4%,
  price 8.4%, rating 5.1%. The sealed holdout itself is 47.8% balanced / 30.5%
  speed. V7 expands cue-bearing wording but does **not** resample to the
  holdout mix; matching it would shape training to the evaluation set. This is
  recorded, not hidden, in the distribution report.
- Field coverage: food budget 37.9%, eta 21.0%; ride pickup 20.6%, budget 26.6%,
  wait 7.9%, schedule 5.1%; shop budget 60.4%.
- 152 distinct food items, 69 ride drops, 75 shop items, 3,157 distinct 4-gram
  prefixes; one prefix ("pick me up from") used 42 times. No other template
  exceeds 40.
- Imbalance flags: none (thresholds in `distribution_v7.py`).

Internal near-duplicates in train: 1 pair at 0.8 ("…30 minutes" vs "…45
minutes"); the only ≥0.9 hit is "bye" vs "bye bye", an artifact of the 4-gram
fallback for very short utterances, not a copy.

## 5. Leakage (phase 12)

`reports/holdout_leakage_report.json` — **PASS**:

- train 4,147: 0 exact holdout copies, 0 fixture copies, 0 near duplicates
  (≥0.8 Jaccard), 0 internal duplicates.
- valid 225 and private eval 495: the same zeros.
- train ↔ private eval overlap 0; train ↔ valid 0; eval ↔ valid 0.
- Holdout SHA unchanged before/after.

Rows that exactly matched the holdout or fixtures during generation (25 train,
8 valid, 7 eval attempts) were rejected by the Builder and are absent.

## 6. Validation (phase 13)

`python data/v7/validate_v7.py` → **V7 VALIDATION: PASS** (24/24 checks,
`reports/validation_v7.json`). It re-parses every line, re-validates schema,
action semantics, label conflicts and priority policy, re-checks exact holdout
and fixture copies, cross-split duplicates, row/category ranges, action
hard-negative share, system-prompt coverage, domain coverage, and that
`model/train_mlx_v7.jsonl` / `valid_mlx_v7.jsonl` match the split files.

## 7. Training configuration (phase 16, not executed)

`model/configs/v7_run1.yaml`, SHA256 `b88ac11b34747c8b…`:

- base `Qwen/Qwen2.5-1.5B-Instruct`, fresh LoRA (no V6 adapter resumed)
- rank 16, scale 2.0 (= PEFT alpha 32), dropout 0.05, last 16 layers,
  mask_prompt, AdamW, grad checkpoint, `max_seq_length 1152`
- micro-batch 1 + gradient accumulation 4 (16 GB M2 ceiling)
- 1,600 iterations ≈ 6,400 samples ≈ 1.5 epochs over V7
- LR 1.5e-4 cosine, warmup 50, seed 11
- data `/tmp/flouna_v7_data`, adapter output `model/flouna-lora-v7-run1`
- changes vs V6 are documented in the file: smaller cleaner corpus, three
  prompts, more passes, LR between V6 run 1 and run 2, new seed

Staging command (documented in the YAML, already run, no training):
`cp data/v7/training/{train,valid}.jsonl /tmp/flouna_v7_data/`.

## 8. Remaining ambiguity and honest limits

- The priority policy (no-preference > rating > speed > price > deadline >
  balanced) is a documented convention, not a schema rule. 425 V6 rows and the
  V7 rows built from them keep their `balanced` label when a cue is present
  only because that is the corpus majority; multi-cue sentences remain
  inherently ambiguous.
- Private eval (495) is a separate generated set, not the official 382-case
  holdout. It exercises the same failure families but its absolute accuracy is
  not comparable to sealed numbers.
- Three categories land 10–25% under the "~" targets (production robustness,
  paraphrase, ride/domain/nested/generic). The pools and duplicate filters
  exhausted before the caps; filling them would have required near-duplicate
  templates, which the spec forbids. No category is below its minimum range.
- V7 is validated as data, not as a model. No accuracy claim is made here; the
  first honest measurement will be the sealed evaluation after a training run.

## 9. Status

```
V7 TRAINING NOT STARTED.
GGUF NOT EXPORTED.
Ollama NOT UPDATED.
Production NOT touched.
```
