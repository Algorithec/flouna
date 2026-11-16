#!/usr/bin/env python3
"""Validate the FLOUNA JSONL corpora before a training run.

    python validate_dataset.py
    python validate_dataset.py --train train_mlx_v5.jsonl --valid valid_mlx_v5.jsonl --eval eval_mlx_v5.jsonl --json qc.json

Checks every row: chat structure, JSON parses, schema and enums, nesting,
canonical values, and that the label agrees with the sentence (an amount, a
deadline, a wait, a clock time). Then checks duplicates inside and across
splits and overlap with the repo eval fixtures. Exits 1 on any hard failure.
Near duplicates are reported as warnings because deliberate minimal pairs
("cheap pizza" / "pizza") are useful contrast, not leakage.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import flouna_schema as fs

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DEFAULT_TRAIN = HERE / "train_mlx_v5.jsonl"
DEFAULT_VALID = HERE / "valid_mlx_v5.jsonl"
DEFAULT_EVAL = HERE / "eval_mlx_v5.jsonl"
FIXTURES = [
    ROOT / "server/test/fixtures/intent-eval.jsonl",
    ROOT / "server/test/fixtures/intent-eval-holdout.jsonl",
]


def norm_text(text: str) -> str:
    t = text.lower().strip()
    t = re.sub(r"[^a-z0-9\u20b9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def token_grams(text: str, n: int = 4) -> frozenset[tuple[str, ...]]:
    tokens = norm_text(text).split()
    if len(tokens) < n:
        return frozenset((tok,) for tok in tokens)
    return frozenset(tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1))


def near_pairs(rows: list[tuple[str, dict]], threshold: float = 0.9) -> list[tuple[int, int, float]]:
    """Jaccard near duplicates, blocked by shared token 4-grams."""
    grams = [token_grams(text) for text, _ in rows]
    index: dict[tuple[str, ...], list[int]] = defaultdict(list)
    for i, gs in enumerate(grams):
        for gram in gs:
            index[gram].append(i)
    seen: set[tuple[int, int]] = set()
    hits: list[tuple[int, int, float]] = []
    for ids in index.values():
        if len(ids) > 80:
            continue  # a phrase this common is template boilerplate, not a copy
        for a_pos in range(len(ids)):
            for b_pos in range(a_pos + 1, len(ids)):
                a, b = ids[a_pos], ids[b_pos]
                if (a, b) in seen:
                    continue
                seen.add((a, b))
                ga, gb = grams[a], grams[b]
                if not ga or not gb:
                    continue
                score = len(ga & gb) / len(ga | gb)
                if score >= threshold:
                    hits.append((a, b, score))
    return hits


def load_rows(path: Path) -> list[dict]:
    rows = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append({"line": line_no, "row": json.loads(line)})
        except json.JSONDecodeError as exc:
            rows.append({"line": line_no, "error": f"invalid JSON: {exc}"})
    return rows


def validate_file(path: Path) -> dict:
    report = {
        "path": str(path),
        "rows": 0,
        "schema_errors": [],
        "structure_errors": [],
        "conflicts": [],
        "systems": set(),
        "duplicates": [],
        "near_duplicates": 0,
        "domains": Counter(),
        "priorities": Counter(),
        "dietary": Counter(),
        "vehicles": Counter(),
        "categories": Counter(),
        "constraints": Counter(),
        "null_fields": Counter(),
        "action_kinds": Counter(),
        "action_fields": Counter(),
        "injections": 0,
        "texts": [],
    }
    if not path.exists():
        report["structure_errors"].append(f"missing file: {path}")
        return report
    for item in load_rows(path):
        if "error" in item:
            report["structure_errors"].append(f"line {item['line']}: {item['error']}")
            continue
        row = item["row"]
        report["rows"] += 1
        messages = row.get("messages")
        if not isinstance(messages, list) or len(messages) != 3:
            report["structure_errors"].append(f"line {item['line']}: expected 3 messages")
            continue
        roles = [m.get("role") for m in messages if isinstance(m, dict)]
        if roles != ["system", "user", "assistant"]:
            report["structure_errors"].append(f"line {item['line']}: roles {roles}")
            continue
        system, text, answer = (messages[0].get("content"), messages[1].get("content"), messages[2].get("content"))
        if not isinstance(system, str) or not isinstance(text, str) or not isinstance(answer, str):
            report["structure_errors"].append(f"line {item['line']}: non-string message content")
            continue
        report["systems"].add(system)
        report["texts"].append(text)
        try:
            output = json.loads(answer)
        except json.JSONDecodeError as exc:
            report["structure_errors"].append(f"line {item['line']}: assistant JSON invalid: {exc}")
            continue
        errors = fs.validate_intent(output)
        if errors:
            report["schema_errors"].append({"line": item["line"], "text": text, "errors": errors})
            continue
        conflicts = fs.label_conflicts(text, output)
        if conflicts:
            report["conflicts"].append({"line": item["line"], "text": text, "problems": conflicts})
        domain = output["domain"]
        report["domains"][domain] += 1
        if domain == "action":
            body = output["action"]
            report["action_kinds"][body["kind"]] += 1
            for key in ("targetBy", "pick", "setting", "value", "weeklyRupees"):
                if body[key] not in ("", "none", 0):
                    report["action_fields"][key] += 1
            semantics = fs.validate_action_semantics(body)
            if semantics:
                report["schema_errors"].append(
                    {"line": item["line"], "text": text, "errors": ["action semantics: " + e for e in semantics]}
                )
        for part in ("food", "ride", "shop"):
            body = output.get(part)
            if not isinstance(body, dict):
                continue
            report["priorities"][body.get("priority")] += 1
            if part == "food":
                report["dietary"][body.get("dietary")] += 1
            if part == "ride":
                report["vehicles"][body.get("vehicle")] += 1
            if part == "shop":
                report["categories"][body.get("category")] += 1
            for key in ("budgetPaise", "maxEtaMinutes", "maxPickupMinutes", "scheduleAt", "pickup"):
                if key in body and body[key] is None:
                    report["null_fields"][f"{part}.{key}"] += 1
        count = 0
        for part in ("food", "ride", "shop"):
            body = output.get(part)
            if not isinstance(body, dict):
                continue
            if body.get("budgetPaise") is not None:
                count += 1
            if body.get("maxEtaMinutes") is not None or body.get("maxPickupMinutes") is not None:
                count += 1
            if body.get("dietary") in ("veg", "nonveg"):
                count += 1
            if body.get("priority") not in (None, "balanced"):
                count += 1
            if body.get("scheduleAt") is not None:
                count += 1
        report["constraints"][count] += 1
        if "injection" in row:
            report["injections"] += 1

    keys = [norm_text(t) for t in report["texts"]]
    seen: dict[str, int] = {}
    for i, key in enumerate(keys):
        if key in seen:
            report["duplicates"].append((seen[key], i))
        else:
            seen[key] = i
    pairs = near_pairs([(t, {}) for t in report["texts"]])
    report["near_duplicates"] = len(pairs)
    return report


def fixture_texts() -> set[str]:
    seen = set()
    for path in FIXTURES:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if isinstance(row.get("message"), str):
                seen.add(norm_text(row["message"]))
    return seen


def summarize(name: str, report: dict) -> list[str]:
    lines = [f"\n{name}  ({report['rows']} rows)"]
    hard = 0
    if report["structure_errors"]:
        hard += len(report["structure_errors"])
        lines.append(f"  structure errors: {len(report['structure_errors'])}")
        for e in report["structure_errors"][:5]:
            lines.append(f"    {e}")
    if report["schema_errors"]:
        hard += len(report["schema_errors"])
        lines.append(f"  schema errors: {len(report['schema_errors'])}")
        for e in report["schema_errors"][:5]:
            lines.append(f"    line {e['line']}: {e['errors']} | {e['text']}")
    if report["conflicts"]:
        hard += len(report["conflicts"])
        lines.append(f"  text/label conflicts: {len(report['conflicts'])}")
        for e in report["conflicts"][:5]:
            lines.append(f"    line {e['line']}: {e['problems']} | {e['text']}")
    if len(report["systems"]) > 1:
        hard += 1
        lines.append(f"  mixed system prompts: {len(report['systems'])}")
    if report["duplicates"]:
        hard += len(report["duplicates"])
        lines.append(f"  exact duplicate texts: {len(report['duplicates'])}")
    if report["near_duplicates"]:
        lines.append(f"  near duplicates (Jaccard >= 0.90): {report['near_duplicates']} (warning)")
    lines.append(f"  domains: {dict(report['domains'])}")
    lines.append(f"  priorities: {dict(report['priorities'])}")
    lines.append(f"  dietary: {dict(report['dietary'])}")
    lines.append(f"  constraints per row: {dict(sorted(report['constraints'].items()))}")
    lines.append(f"  null fields: {dict(report['null_fields'])}")
    if report["vehicles"]:
        lines.append(f"  vehicles: {dict(report['vehicles'])}")
    if report["categories"]:
        lines.append(f"  categories: {dict(report['categories'])}")
    if report["action_kinds"]:
        lines.append(f"  action kinds: {dict(sorted(report['action_kinds'].items()))}")
        lines.append(f"  action fields used: {dict(report['action_fields'])}")
    lines.append(f"  hard failures: {hard}")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", type=Path, default=DEFAULT_TRAIN)
    parser.add_argument("--valid", type=Path, default=DEFAULT_VALID)
    parser.add_argument("--eval", type=Path, default=DEFAULT_EVAL)
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()

    files = {"train": args.train, "valid": args.valid, "eval": args.eval}
    reports = {name: validate_file(path) for name, path in files.items()}

    out_lines: list[str] = []
    hard_total = 0
    for name, report in reports.items():
        lines = summarize(name, report)
        hard_total += int(lines[-1].rsplit(":", 1)[1])
        out_lines.extend(lines)

    fixture_keys = fixture_texts()
    out_lines.append("\ncross-split checks")
    keysets = {name: {norm_text(t) for t in report["texts"]} for name, report in reports.items()}
    for a, b in (("train", "valid"), ("train", "eval"), ("valid", "eval")):
        overlap = keysets[a] & keysets[b]
        hard_total += len(overlap)
        out_lines.append(f"  exact {a}∩{b}: {len(overlap)}")
        for text in list(overlap)[:5]:
            out_lines.append(f"    {text}")
    for name, keys in keysets.items():
        overlap = keys & fixture_keys
        hard_total += len(overlap)
        out_lines.append(f"  exact {name}∩fixtures: {len(overlap)}")

    out_lines.append(f"\n{'PASS' if hard_total == 0 else 'FAIL'}: {hard_total} hard failure(s)")
    print("\n".join(out_lines))

    if args.json:
        payload = {
            name: {
                **{k: (dict(v) if isinstance(v, Counter) else v) for k, v in report.items() if k != "systems"},
                "systems": len(report["systems"]),
                "duplicates": len(report["duplicates"]),
            }
            for name, report in reports.items()
        }
        payload["fixture_overlap"] = {name: len(keys & fixture_keys) for name, keys in keysets.items()}
        payload["hard_failures"] = hard_total
        args.json.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"wrote {args.json}")
    return 0 if hard_total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
