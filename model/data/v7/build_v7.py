#!/usr/bin/env python3
"""Assemble the V7 dataset, the MLX valid split and the private V7 eval set.

    python data/v7/build_v7.py

Reads train_mlx_v6.jsonl (read-only) and the sealed holdout (read-only).
Writes only under data/v7/ plus train_mlx_v7.jsonl / valid_mlx_v7.jsonl.
"""
from __future__ import annotations

import json
import random
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import v7_lib as L
import v7_generators as G
import validate_dataset as vd

HERE = Path(__file__).resolve().parent
MODEL = HERE.parent.parent
SEED_TRAIN = 7
SEED_VALID = 404
SEED_EVAL = 2026


def build_eval(shared: set[str], holdout: list[str]) -> L.Builder:
    b = L.Builder(forbidden_texts=holdout, label="eval", seen=shared)
    rng = random.Random(SEED_EVAL)
    G.gen_ride_boundaries(b, rng, 75)
    G.gen_domain_boundaries(b, rng, 65)
    G.gen_action_positives(b, rng, 70)
    G.gen_action_hard_negatives(b, rng, 70)
    G.gen_generic_food(b, rng, 25)
    G.gen_greeting_oos(b, rng, 30)
    G.gen_oos_only(b, rng, 20)
    G.gen_nested(b, rng, 35)
    G.gen_dietary(b, rng, 25)
    G.gen_paraphrases(b, rng, 30)
    G.gen_production_robustness(b, rng, 30)
    G.gen_combo(b, rng, 20)
    return b


def build_mlx_valid(shared: set[str], holdout: list[str]) -> L.Builder:
    b = L.Builder(forbidden_texts=holdout, label="valid", seen=shared)
    rng = random.Random(SEED_VALID)
    rng.shuffle(G.DISHES)
    G.gen_new_core(b, rng, 55)
    G.gen_ride_boundaries(b, rng, 35)
    G.gen_domain_boundaries(b, rng, 25)
    G.gen_action_positives(b, rng, 30)
    G.gen_action_hard_negatives(b, rng, 20)
    G.gen_generic_food(b, rng, 15)
    G.gen_greeting_oos(b, rng, 20)
    G.gen_dietary(b, rng, 15)
    G.gen_combo(b, rng, 10)
    return b


def build_train(shared: set[str], holdout: list[str]) -> L.Builder:
    b = L.Builder(forbidden_texts=holdout, label="train", seen=shared)
    rng = random.Random(SEED_TRAIN)
    core_caps = {"food": 520, "ride": 470, "shop": 190, "combo": 80,
                 "action": 50, "greeting": 20, "out_of_scope": 30}
    G.gen_core_from_v6(b, rng, core_caps)
    G.gen_new_core(b, rng, 220)
    G.gen_combo(b, rng, 60)
    G.gen_action_positives(b, rng, 440)
    G.gen_action_hard_negatives(b, rng, 320)
    G.gen_ride_boundaries(b, rng, 280)
    G.gen_domain_boundaries(b, rng, 230)
    G.gen_generic_food(b, rng, 180)
    G.gen_greeting_oos(b, rng, 190)
    G.gen_nested(b, rng, 230)
    G.gen_dietary(b, rng, 160)
    G.gen_production_robustness(b, rng, 260)
    G.gen_paraphrases(b, rng, 260)
    return b


def summarize(b: L.Builder) -> dict:
    domains = Counter(r["output"]["domain"] for r in b.rows)
    primary = Counter(r["primary"] for r in b.rows)
    tags = Counter(t for r in b.rows for t in r["tags"])
    systems = Counter(r["system"] for r in b.rows)
    return {
        "label": b.label,
        "rows": len(b.rows),
        "domains": dict(domains.most_common()),
        "primary": dict(primary.most_common()),
        "tags": dict(tags.most_common()),
        "systems": dict(systems.most_common()),
        "rejected": b.counts["rejected"],
        "rejected_duplicate": b.counts["duplicate"],
        "rejected_leak": b.counts["leak"],
        "rejected_invalid": b.counts["invalid"],
        "reasons": dict(Counter(r["reason"].split(":")[0] for r in b.rejected).most_common(12)),
    }


def write_category_files(b: L.Builder, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    by_primary: dict[str, list[dict]] = {}
    for row in b.rows:
        by_primary.setdefault(row["primary"], []).append(row)
    for name, rows in sorted(by_primary.items()):
        L.write_jsonl(out_dir / f"{name}.jsonl", rows, L.SYSTEMS)


def main() -> int:
    before_holdout = L.sha256(L.SEALED_HOLDOUT)
    holdout_texts = L.load_jsonl_texts(L.SEALED_HOLDOUT)
    shared: set[str] = set()

    eval_b = build_eval(shared, holdout_texts)
    valid_b = build_mlx_valid(shared, holdout_texts)
    train_b = build_train(shared, holdout_texts)

    reports = HERE / "reports"
    reports.mkdir(parents=True, exist_ok=True)

    # private eval set, not the official holdout
    eval_path = HERE / "validation/v7_validation.jsonl"
    eval_rows = [dict(r, system=r["system"]) for r in eval_b.rows]
    L.write_jsonl(eval_path, eval_rows, L.SYSTEMS)
    (HERE / "validation/v7_validation_manifest.json").write_text(
        json.dumps(
            [{"text": r["text"], "domain": r["output"]["domain"], "primary": r["primary"],
              "tags": r["tags"], "system": r["system"]} for r in eval_b.rows],
            indent=2, ensure_ascii=False,
        ) + "\n",
        encoding="utf-8",
    )

    # MLX training layout
    train_path = HERE / "train_v7.jsonl"
    valid_path = HERE / "valid_v7.jsonl"
    L.write_jsonl(train_path, train_b.rows, L.SYSTEMS)
    L.write_jsonl(valid_path, valid_b.rows, L.SYSTEMS)
    # Paths that follow the model/ file convention the V5/V6 runs used.
    L.write_jsonl(MODEL / "train_mlx_v7.jsonl", train_b.rows, L.SYSTEMS)
    L.write_jsonl(MODEL / "valid_mlx_v7.jsonl", valid_b.rows, L.SYSTEMS)
    stage = HERE / "training"
    stage.mkdir(parents=True, exist_ok=True)
    L.write_jsonl(stage / "train.jsonl", train_b.rows, L.SYSTEMS)
    L.write_jsonl(stage / "valid.jsonl", valid_b.rows, L.SYSTEMS)

    write_category_files(train_b, HERE / "generated")
    curated = [r for r in train_b.rows if "curated_v6" in r["tags"]]
    L.write_jsonl(HERE / "cleaned/core_from_v6.jsonl", curated, L.SYSTEMS)

    # manifest for the training split
    (HERE / "build_manifest.json").write_text(
        json.dumps(
            [{"index": i, "text": r["text"], "domain": r["output"]["domain"],
              "primary": r["primary"], "tags": r["tags"], "system": r["system"]}
             for i, r in enumerate(train_b.rows)],
            indent=2, ensure_ascii=False,
        ) + "\n",
        encoding="utf-8",
    )

    after_holdout = L.sha256(L.SEALED_HOLDOUT)
    if before_holdout != after_holdout:
        raise SystemExit("SEALED HOLDOUT CHANGED DURING BUILD")

    build = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seeds": {"train": SEED_TRAIN, "valid": SEED_VALID, "eval": SEED_EVAL},
        "files": {
            "train": {"path": str(train_path.relative_to(HERE)), "sha256": L.sha256(train_path),
                      "rows": len(train_b.rows)},
            "valid": {"path": str(valid_path.relative_to(HERE)), "sha256": L.sha256(valid_path),
                      "rows": len(valid_b.rows)},
            "eval": {"path": str(eval_path.relative_to(HERE)), "sha256": L.sha256(eval_path),
                     "rows": len(eval_b.rows)},
            "sealed_holdout": {"path": str(L.SEALED_HOLDOUT), "sha256": after_holdout, "rows": 382},
        },
        "train": summarize(train_b),
        "valid": summarize(valid_b),
        "eval": summarize(eval_b),
        "rejected_examples": train_b.rejected[:40],
    }
    (reports / "build_report.json").write_text(json.dumps(build, indent=2, ensure_ascii=False) + "\n",
                                               encoding="utf-8")

    for key in ("train", "valid", "eval"):
        s = build[key]
        print(f"{key}: {s['rows']} rows | domains {s['domains']}")
        print(f"  primary {s['primary']}")
        print(f"  systems {s['systems']} rejected {s['rejected']} dup {s['rejected_duplicate']} "
              f"leak {s['rejected_leak']} invalid {s['rejected_invalid']}")
        print(f"  reasons {s['reasons']}")
    print("holdout sha before/after:", before_holdout, after_holdout, before_holdout == after_holdout)
    print("train sha:", build["files"]["train"]["sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
