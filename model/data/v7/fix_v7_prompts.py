#!/usr/bin/env python3
"""Build data/v7_fixed from data/v7 by swapping only the prod system prompt.

The pre-fix V7 corpus used the 6,053-character production prompt for 45% of
rows. That prompt is 1,589 tokens, so every prod row's assistant target was
truncated away at max_seq_length 1,152 and produced a zero-length loss mask.

This script keeps every user message and assistant label byte-identical and
replaces only that system prompt with the compact training prompt
FLOUNA_PRODUCTION_COMPACT_V1. Non-prod rows are copied unchanged. The original
data/v7 directory is read-only here and is verified unchanged before exit.

    python data/v7/fix_v7_prompts.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE.parent.parent
sys.path.insert(0, str(MODEL))
sys.path.insert(0, str(HERE))

import v7_lib as L  # noqa: E402
import token_preflight_v7 as TP  # noqa: E402

FIXED = HERE.parent / "v7_fixed"
COMPACT_PATH = TP.COMPACT_PROMPT_PATH

SOURCE = {
    "train": (HERE / "train_v7.jsonl",
              "678338cba7af5277e6e39c99ecfdcd3ee63b90be983865da71e61cc1797878bf",
              "train_v7.jsonl"),
    "valid": (HERE / "valid_v7.jsonl",
              "6cf147ed4ae801d38999a8d3d418e443de574f44880983e1c3f9bff32737baee",
              "valid_v7.jsonl"),
    "eval": (HERE / "validation/v7_validation.jsonl",
             "2467d61641064dda43bf829ef9c2c328344ddca0acf65e698248d54d432b8e8a",
             "validation/v7_validation.jsonl"),
}
EXPECTED_PROD = {"train": 1871, "valid": 97, "eval": 221}
EXPECTED_ROWS = {"train": 4147, "valid": 225, "eval": 495}
PROMPT_TS_SHA = "907de19eeccd8a4c89e7dc963830ca321b9a47725e7faa599b0b05b10dfffec6"
HOLDOUT_SHA = "f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a"
MAX_COMPACT_TOKENS = 900


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def rewrite_manifest(entries: list[dict]) -> list[dict]:
    out = []
    for entry in entries:
        fixed = dict(entry)
        if fixed.get("system") == "prod":
            fixed["system"] = "prod_compact"
        out.append(fixed)
    return out


def main() -> int:
    if FIXED.exists():
        raise SystemExit(f"refusing to overwrite existing {FIXED}")

    compact = COMPACT_PATH.read_text(encoding="utf-8").strip()
    tokenizer = TP.load_tokenizer()
    compact_tokens = len(tokenizer.encode(compact))
    if compact_tokens > MAX_COMPACT_TOKENS:
        raise SystemExit(f"compact prompt is {compact_tokens} tokens, "
                         f"limit {MAX_COMPACT_TOKENS}")
    if not compact.startswith("FLOUNA_PRODUCTION_COMPACT_V1"):
        raise SystemExit("compact prompt is missing its version line")

    before = {name: L.sha256(path) for name, (path, _, _) in SOURCE.items()}
    for name, (path, expected, _) in SOURCE.items():
        if before[name] != expected:
            raise SystemExit(f"{name} source hash changed: {before[name]} != {expected}")
    if L.sha256(TP.MODEL.parent / "server/src/modules/chat/llm/prompt.ts") != PROMPT_TS_SHA:
        raise SystemExit("production prompt.ts changed; refusing to build")
    if L.sha256(L.SEALED_HOLDOUT) != HOLDOUT_SHA:
        raise SystemExit("sealed holdout changed; refusing to build")

    prod_prompt = L.SYSTEMS["prod"]
    allowed = {L.SYSTEMS["v6"], L.SYSTEMS["short"], prod_prompt}
    per_split: dict[str, dict] = {}
    fixed_rows: dict[str, list[dict]] = {}
    for name, (path, _, _) in SOURCE.items():
        rows = load_rows(path)
        replaced = unchanged = 0
        for row in rows:
            msgs = row["messages"]
            system = msgs[0]["content"]
            if system not in allowed:
                raise SystemExit(f"{name}: unknown system prompt in row {msgs[1]['content']!r}")
            if system == prod_prompt:
                msgs[0]["content"] = compact
                replaced += 1
            else:
                unchanged += 1
        if len(rows) != EXPECTED_ROWS[name] or replaced != EXPECTED_PROD[name]:
            raise SystemExit(f"{name}: rows {len(rows)}/{EXPECTED_ROWS[name]} "
                             f"prod {replaced}/{EXPECTED_PROD[name]}")
        if unchanged != len(rows) - replaced:
            raise SystemExit(f"{name}: unchanged count mismatch")
        fixed_rows[name] = rows
        per_split[name] = {
            "rows": len(rows),
            "prod_rows_replaced": replaced,
            "rows_unchanged": unchanged,
            "rows_removed": 0,
        }

    write_rows(FIXED / "train_v7.jsonl", fixed_rows["train"])
    write_rows(FIXED / "valid_v7.jsonl", fixed_rows["valid"])
    write_rows(FIXED / "validation/v7_validation.jsonl", fixed_rows["eval"])
    write_rows(FIXED / "training/train.jsonl", fixed_rows["train"])
    write_rows(FIXED / "training/valid.jsonl", fixed_rows["valid"])

    train_manifest = rewrite_manifest(
        json.loads((HERE / "build_manifest.json").read_text(encoding="utf-8")))
    eval_manifest = rewrite_manifest(
        json.loads((HERE / "validation/v7_validation_manifest.json").read_text(encoding="utf-8")))
    (FIXED / "build_manifest.json").write_text(
        json.dumps(train_manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (FIXED / "validation/v7_validation_manifest.json").write_text(
        json.dumps(eval_manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    after = {name: L.sha256(path) for name, (path, _, _) in SOURCE.items()}
    if before != after:
        raise SystemExit("source dataset changed during the build")

    fixed_hashes = {
        "train": L.sha256(FIXED / "train_v7.jsonl"),
        "valid": L.sha256(FIXED / "valid_v7.jsonl"),
        "eval": L.sha256(FIXED / "validation/v7_validation.jsonl"),
        "mlx_train": L.sha256(FIXED / "training/train.jsonl"),
        "mlx_valid": L.sha256(FIXED / "training/valid.jsonl"),
    }

    manifest = {
        "dataset": "v7_fixed",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pre_fix_dataset": str(HERE),
        "reason": "prod system prompt was 1589 tokens; every prod row exceeded "
                  "max_seq_length 1152 and had an empty loss mask",
        "compact_prompt": {
            "path": str(COMPACT_PATH),
            "version": compact.splitlines()[0],
            "sha256": L.sha256(COMPACT_PATH),
            "tokens": compact_tokens,
            "chars": len(compact),
        },
        "production_prompt_ts": {
            "path": "server/src/modules/chat/llm/prompt.ts",
            "sha256": PROMPT_TS_SHA,
            "modified": False,
        },
        "splits": per_split,
        "removals": [],
        "source_hashes_before": before,
        "source_hashes_after": after,
        "fixed_hashes": fixed_hashes,
        "sealed_holdout_sha256": HOLDOUT_SHA,
    }
    (FIXED / "fix_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print("compact prompt:", compact_tokens, "tokens,", len(compact), "chars")
    for name, entry in per_split.items():
        print(f"{name}: {entry['rows']} rows | prod replaced {entry['prod_rows_replaced']} "
              f"| unchanged {entry['rows_unchanged']} | removed {entry['rows_removed']}")
    print("fixed hashes:")
    for name, digest in fixed_hashes.items():
        print(f"  {name}: {digest}")
    print("source unchanged:", before == after)
    print("wrote", FIXED)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
