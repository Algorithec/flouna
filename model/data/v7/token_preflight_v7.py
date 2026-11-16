#!/usr/bin/env python3
"""Mandatory token-length and loss-mask preflight for the V7 datasets.

Uses the exact path mlx-lm training uses: the Qwen2.5-1.5B-Instruct tokenizer
through ``mlx_lm.tuner.datasets.ChatDataset(mask_prompt=True)``, which yields
the tokenized conversation and the prompt offset that becomes the loss mask.
Length is never approximated from characters.

    python data/v7/token_preflight_v7.py

Fails a split if any row exceeds max_seq_length or has an empty loss mask.
Rows between the warning and hard limits are reported. Rows above the hard
limit (1,100 tokens) are only accepted when they are retained unchanged and
their loss mask is intact; they are listed as documented exceptions.

Writes data/v7/reports/v7_token_preflight.json, containing the fixed dataset
as the primary result and the pre-fix dataset as a read-only reference.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE.parent.parent
sys.path.insert(0, str(MODEL))
sys.path.insert(0, str(HERE))

import v7_lib as L  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402
from mlx_lm.tuner.datasets import ChatDataset  # noqa: E402

MODEL_NAME = "Qwen/Qwen2.5-1.5B-Instruct"
MAX_SEQ = 1152
PREFERRED = 1000
WARN = 1024
HARD = 1100
MIN_MASK = 10

SPLIT_FILES = {
    "train": "train_v7.jsonl",
    "valid": "valid_v7.jsonl",
    "eval": "validation/v7_validation.jsonl",
}
FIXED_ROOT = HERE.parent / "v7_fixed"
COMPACT_PROMPT_PATH = HERE / "prompts/production_compact.txt"


def load_tokenizer() -> AutoTokenizer:
    return AutoTokenizer.from_pretrained(MODEL_NAME)


def compact_prompt() -> str:
    return COMPACT_PROMPT_PATH.read_text(encoding="utf-8").strip()


def fixed_systems() -> dict[str, str]:
    return {"v6": L.SYSTEMS["v6"], "prod_compact": compact_prompt(),
            "short": L.SYSTEMS["short"]}


def prefixed_systems() -> dict[str, str]:
    return {"v6": L.SYSTEMS["v6"], "prod": L.SYSTEMS["prod"], "short": L.SYSTEMS["short"]}


def percentile(values: list[int], p: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = max(0, math.ceil(p / 100 * len(ordered)) - 1)
    return ordered[min(index, len(ordered) - 1)]


def stats(values: list[int]) -> dict:
    if not values:
        return {"rows": 0, "min": 0, "max": 0, "mean": 0.0, "median": 0,
                "p95": 0, "p99": 0}
    return {
        "rows": len(values),
        "min": min(values),
        "max": max(values),
        "mean": round(sum(values) / len(values), 2),
        "median": percentile(values, 50),
        "p95": percentile(values, 95),
        "p99": percentile(values, 99),
    }


def analyse_split(path: Path, tokenizer, systems: dict[str, str]) -> dict:
    data = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]
    dataset = ChatDataset(data, tokenizer, mask_prompt=True)
    rows: list[dict] = []
    unknown = 0
    for row in data:
        msgs = row["messages"]
        system, user, answer = (m["content"] for m in msgs)
        tokens, offset = dataset.process(row)
        total = len(tokens)
        truncated = min(total, MAX_SEQ)
        mask_tokens = max(0, truncated - min(offset, MAX_SEQ))
        kind = next((name for name, text in systems.items() if text == system), "unknown")
        if kind == "unknown":
            unknown += 1
        rows.append({
            "kind": kind,
            "system_tokens": len(tokenizer.encode(system)),
            "user_tokens": len(tokenizer.encode(user)),
            "output_tokens": len(tokenizer.encode(answer)),
            "prompt_offset": offset,
            "sequence_tokens": total,
            "loss_mask_tokens": mask_tokens,
            "truncated": total > MAX_SEQ,
            "over_900": total > 900,
            "over_1000": total > PREFERRED,
            "over_1024": total > WARN,
            "over_1100": total > HARD,
            "over_1152": total > MAX_SEQ,
            "empty_mask": mask_tokens == 0,
            "tiny_mask": mask_tokens < MIN_MASK,
            "user": user,
        })

    totals = [r["sequence_tokens"] for r in rows]
    empty = sum(1 for r in rows if r["empty_mask"])
    tiny = sum(1 for r in rows if r["tiny_mask"])
    failures = [r for r in rows if r["over_1152"] or r["empty_mask"] or r["tiny_mask"]]
    exceptions = [
        {"text": r["user"], "prompt": r["kind"], "sequence_tokens": r["sequence_tokens"],
         "loss_mask_tokens": r["loss_mask_tokens"],
         "reason": "retained unchanged; fits max_seq_length; loss mask intact"}
        for r in rows if r["over_1100"] and not r["over_1152"] and not r["empty_mask"]
    ]
    warnings = [
        {"text": r["user"], "prompt": r["kind"], "sequence_tokens": r["sequence_tokens"],
         "loss_mask_tokens": r["loss_mask_tokens"]}
        for r in rows if r["over_1024"] and not r["over_1100"]
    ]
    by_kind: dict[str, dict] = {}
    for kind in list(systems) + (["unknown"] if unknown else []):
        group = [r for r in rows if r["kind"] == kind]
        if not group:
            continue
        by_kind[kind] = {
            "rows": len(group),
            "sequence_tokens": stats([r["sequence_tokens"] for r in group]),
            "prompt_offset": stats([r["prompt_offset"] for r in group]),
            "output_tokens": stats([r["output_tokens"] for r in group]),
            "loss_mask_tokens": stats([r["loss_mask_tokens"] for r in group]),
            "over_1024": sum(1 for r in group if r["over_1024"]),
            "over_1100": sum(1 for r in group if r["over_1100"]),
            "over_1152": sum(1 for r in group if r["over_1152"]),
            "empty_masks": sum(1 for r in group if r["empty_mask"]),
        }
    longest = sorted(rows, key=lambda r: r["sequence_tokens"], reverse=True)[:5]
    return {
        "path": str(path),
        "pass": not failures and unknown == 0,
        "rows": len(rows),
        "unknown_prompts": unknown,
        "sequence_tokens": stats(totals),
        "prompt_offset": stats([r["prompt_offset"] for r in rows]),
        "output_tokens": stats([r["output_tokens"] for r in rows]),
        "loss_mask_tokens": stats([r["loss_mask_tokens"] for r in rows]),
        "counts": {
            "over_900": sum(1 for r in rows if r["over_900"]),
            "over_1000": sum(1 for r in rows if r["over_1000"]),
            "over_1024": sum(1 for r in rows if r["over_1024"]),
            "over_1100": sum(1 for r in rows if r["over_1100"]),
            "over_1152": sum(1 for r in rows if r["over_1152"]),
            "empty_loss_masks": empty,
            "nonempty_loss_masks": len(rows) - empty,
            "tiny_loss_masks": tiny,
        },
        "by_prompt": by_kind,
        "documented_exceptions": exceptions,
        "warnings": warnings[:20],
        "longest_rows": [
            {"text": r["user"], "prompt": r["kind"],
             "sequence_tokens": r["sequence_tokens"],
             "prompt_offset": r["prompt_offset"],
             "loss_mask_tokens": r["loss_mask_tokens"]}
            for r in longest
        ],
        "_rows": rows,
    }


def prompt_breakdown(rows: list[dict], systems: dict[str, str]) -> dict:
    out: dict[str, dict] = {}
    for kind in systems:
        group = [r for r in rows if r["kind"] == kind]
        if not group:
            continue
        out[kind] = {
            "rows": len(group),
            "sequence_tokens": stats([r["sequence_tokens"] for r in group]),
            "over_1024": sum(1 for r in group if r["over_1024"]),
            "over_1100": sum(1 for r in group if r["over_1100"]),
            "over_1152": sum(1 for r in group if r["over_1152"]),
            "empty_masks": sum(1 for r in group if r["empty_mask"]),
        }
    return out


def analyse_root(root: Path, systems: dict[str, str], tokenizer) -> dict:
    splits = {}
    for name, rel in SPLIT_FILES.items():
        path = root / rel
        if not path.exists():
            raise SystemExit(f"missing split: {path}")
        splits[name] = analyse_split(path, tokenizer, systems)

    all_rows = [row for entry in splits.values() for row in entry.pop("_rows")]
    totals = [r["sequence_tokens"] for r in all_rows]
    combined = {
        "rows": len(all_rows),
        "sequence_tokens": stats(totals),
        "prompt_offset": stats([r["prompt_offset"] for r in all_rows]),
        "output_tokens": stats([r["output_tokens"] for r in all_rows]),
        "loss_mask_tokens": stats([r["loss_mask_tokens"] for r in all_rows]),
        "counts": {
            "over_900": sum(1 for r in all_rows if r["over_900"]),
            "over_1000": sum(1 for r in all_rows if r["over_1000"]),
            "over_1024": sum(1 for r in all_rows if r["over_1024"]),
            "over_1100": sum(1 for r in all_rows if r["over_1100"]),
            "over_1152": sum(1 for r in all_rows if r["over_1152"]),
            "empty_loss_masks": sum(1 for r in all_rows if r["empty_mask"]),
            "nonempty_loss_masks": sum(1 for r in all_rows if not r["empty_mask"]),
            "tiny_loss_masks": sum(1 for r in all_rows if r["tiny_mask"]),
        },
        "by_prompt": prompt_breakdown(all_rows, systems),
    }
    return {
        "root": str(root),
        "rows": combined["rows"],
        "pass": all(s["pass"] for s in splits.values()),
        "splits": splits,
        "totals": combined,
    }


def build_report(tokenizer=None) -> dict:
    tokenizer = tokenizer or load_tokenizer()
    fixed = analyse_root(FIXED_ROOT, fixed_systems(), tokenizer)
    prefixed = analyse_root(HERE, prefixed_systems(), tokenizer)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tokenizer": {
            "name": MODEL_NAME,
            "class": type(tokenizer).__name__,
            "tokenization_path": "mlx_lm.tuner.datasets.ChatDataset(mask_prompt=True)",
        },
        "limits": {
            "max_seq_length": MAX_SEQ,
            "preferred_total": PREFERRED,
            "warn_above": WARN,
            "hard_above": HARD,
            "absolute_fail_above": MAX_SEQ,
            "min_loss_mask_tokens": MIN_MASK,
        },
        "fixed": fixed,
        "pre_fix_reference": prefixed,
        "pass": fixed["pass"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(HERE / "reports/v7_token_preflight.json"))
    args = parser.parse_args()
    report = build_report()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n",
                   encoding="utf-8")

    for label in ("pre_fix_reference", "fixed"):
        data = report[label]
        c = data["totals"]["counts"]
        t = data["totals"]["sequence_tokens"]
        print(f"{label}: {data['rows']} rows | tokens {t['min']}..{t['max']} "
              f"median {t['median']} p99 {t['p99']} | >1024 {c['over_1024']} "
              f">1100 {c['over_1100']} >1152 {c['over_1152']} | "
              f"empty masks {c['empty_loss_masks']} | "
              f"{'PASS' if data['pass'] else 'FAIL'}")
        for split, entry in data["splits"].items():
            print(f"  {split}: {entry['rows']} rows | max {entry['sequence_tokens']['max']} "
                  f"| empty masks {entry['counts']['empty_loss_masks']} "
                  f"| exceptions {len(entry['documented_exceptions'])} "
                  f"| {'PASS' if entry['pass'] else 'FAIL'}")
    print("wrote", out)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
