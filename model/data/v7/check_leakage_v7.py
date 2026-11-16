#!/usr/bin/env python3
"""Phase 12: leakage check of every V7 split against the sealed holdout.

Reads the sealed holdout and fixtures read-only, never writes to them.
Writes data/v7/reports/holdout_leakage_report.json.

    python data/v7/check_leakage_v7.py
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import v7_lib as L
import validate_dataset as vd

HERE = Path(__file__).resolve().parent
REPORTS = HERE / "reports"
SPLITS = {
    "train_v7": HERE / "train_v7.jsonl",
    "valid_v7": HERE / "valid_v7.jsonl",
    "v7_validation": HERE / "validation/v7_validation.jsonl",
}
FIXED_SPLITS = {
    "train_v7_fixed": HERE.parent / "v7_fixed/train_v7.jsonl",
    "valid_v7_fixed": HERE.parent / "v7_fixed/valid_v7.jsonl",
    "v7_validation_fixed": HERE.parent / "v7_fixed/validation/v7_validation.jsonl",
}
EXACT_PASS = 0
NEAR_THRESHOLD = 0.80


def texts_of(path: Path) -> list[str]:
    return L.load_jsonl_texts(path)


def best_match(text: str, gram_sets: list[tuple[str, frozenset]]) -> tuple[float, str]:
    grams = vd.token_grams(text)
    if not grams:
        return 0.0, ""
    best, best_text = 0.0, ""
    for other_text, other in gram_sets:
        if not other:
            continue
        score = len(grams & other) / len(grams | other)
        if score > best:
            best, best_text = score, other_text
            if best == 1.0:
                break
    return best, best_text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", choices=["v7", "v7_fixed"], default="v7")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    splits = FIXED_SPLITS if args.dataset == "v7_fixed" else SPLITS
    default_out = (REPORTS / "holdout_leakage_report_fixed.json"
                   if args.dataset == "v7_fixed" else REPORTS / "holdout_leakage_report.json")
    out_path = Path(args.out) if args.out else default_out

    before = L.sha256(L.SEALED_HOLDOUT)
    holdout = texts_of(L.SEALED_HOLDOUT)
    fixtures = sorted(vd.fixture_texts())
    refs = [(t, vd.token_grams(t)) for t in holdout] + \
           [(t, vd.token_grams(t)) for t in fixtures]
    holdout_norm = {vd.norm_text(t) for t in holdout}
    fixture_norm = {vd.norm_text(t) for t in fixtures}

    report: dict = {
        "phase": 12,
        "dataset": args.dataset,
        "holdout": {
            "path": str(L.SEALED_HOLDOUT),
            "sha256": before,
            "rows": len(holdout),
        },
        "reference_sets": {"fixtures": len(fixtures),
                           "holdout_plus_fixtures": len(refs)},
        "near_threshold": NEAR_THRESHOLD,
        "splits": {},
        "pass": True,
        "criteria": {
            "exact_copies_allowed": EXACT_PASS,
            "near_duplicates_allowed_at_threshold": 0,
            "no_train_eval_text_overlap": True,
        },
    }

    all_seen: dict[str, str] = {}
    split_texts: dict[str, list[str]] = {}
    for name, path in splits.items():
        texts = texts_of(path)
        split_texts[name] = texts
        exact_ref, exact_fixture = [], []
        near = []
        internal_dupes = []
        seen_local: dict[str, str] = {}
        cross_split = []
        for text in texts:
            key = vd.norm_text(text)
            if key in holdout_norm:
                exact_ref.append(text)
            if key in fixture_norm:
                exact_fixture.append(text)
            score, other = best_match(text, refs)
            if score >= NEAR_THRESHOLD:
                near.append({"text": text, "matches": other, "jaccard": round(score, 4)})
            if key in seen_local:
                internal_dupes.append({"text": text, "first": seen_local[key]})
            else:
                seen_local[key] = text
            if key in all_seen and all_seen[key] != name:
                cross_split.append({"text": text, "also_in": all_seen[key]})
        for text in texts:
            all_seen.setdefault(vd.norm_text(text), name)

        try:
            display_path = str(path.relative_to(HERE))
        except ValueError:
            display_path = str(path.relative_to(HERE.parent))
        entry = {
            "path": display_path,
            "rows": len(texts),
            "exact_holdout_copies": len(exact_ref),
            "exact_fixture_copies": len(exact_fixture),
            "near_duplicates": len(near),
            "max_reference_similarity": round(max(
                (m["jaccard"] for m in near), default=0.0), 4),
            "internal_duplicates": len(internal_dupes),
            "cross_split_duplicates": len(cross_split),
            "examples": {
                "exact_holdout": exact_ref[:10],
                "near": near[:10],
                "internal": internal_dupes[:5],
                "cross_split": cross_split[:10],
            },
        }
        report["splits"][name] = entry
        if (entry["exact_holdout_copies"] or entry["near_duplicates"]
                or entry["internal_duplicates"] or entry["cross_split_duplicates"]):
            report["pass"] = False

    # explicit train-vs-private-eval overlap check
    train_key, valid_key, eval_key = list(splits)
    train_norm = {vd.norm_text(t) for t in split_texts[train_key]}
    eval_norm = {vd.norm_text(t) for t in split_texts[eval_key]}
    valid_norm = {vd.norm_text(t) for t in split_texts[valid_key]}
    overlaps = {
        f"{train_key}_vs_{eval_key}": len(train_norm & eval_norm),
        f"{train_key}_vs_{valid_key}": len(train_norm & valid_norm),
        f"{eval_key}_vs_{valid_key}": len(eval_norm & valid_norm),
    }
    report["overlaps"] = overlaps
    if any(overlaps.values()):
        report["pass"] = False

    after = L.sha256(L.SEALED_HOLDOUT)
    report["holdout"]["sha256_after"] = after
    report["holdout"]["unchanged"] = before == after
    if before != after:
        report["pass"] = False

    REPORTS.mkdir(parents=True, exist_ok=True)
    out = out_path
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    for name, entry in report["splits"].items():
        print(f"{name}: {entry['rows']} rows | exact holdout {entry['exact_holdout_copies']} "
              f"fixture {entry['exact_fixture_copies']} | near {entry['near_duplicates']} | "
              f"dupes {entry['internal_duplicates']} cross {entry['cross_split_duplicates']}")
    print("overlaps:", overlaps)
    print("holdout unchanged:", report["holdout"]["unchanged"])
    print("LEAKAGE CHECK:", "PASS" if report["pass"] else "FAIL")
    print("wrote", out)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
