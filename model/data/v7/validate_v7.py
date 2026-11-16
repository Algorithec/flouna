#!/usr/bin/env python3
"""Phase 13: one-command validation of the V7 dataset.

    python data/v7/validate_v7.py

Prints PASS/FAIL per check and an overall verdict, exits non-zero on FAIL,
and writes data/v7/reports/validation_v7.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import flouna_schema as fs
import v7_lib as L
import validate_dataset as vd
import token_preflight_v7 as TP

HERE = Path(__file__).resolve().parent
MODEL = HERE.parent.parent
REPORTS = HERE / "reports"
FIXED_ROOT = HERE.parent / "v7_fixed"
V6_SOURCE = HERE / "source/train_mlx_v6.jsonl"
V6_SOURCE_SHA = "3b8a991102b1aab0f5ce075b6ad23690773d7a625c5e6104d267da392f5d3fde"
HOLDOUT_SHA = "f412d8fc2d53372ce5e43846f26ad7082f8526be022204f2b3f03efca10e603a"
ORIGINAL_HASHES = {
    "train_v7.jsonl": "678338cba7af5277e6e39c99ecfdcd3ee63b90be983865da71e61cc1797878bf",
    "valid_v7.jsonl": "6cf147ed4ae801d38999a8d3d418e443de574f44880983e1c3f9bff32737baee",
    "validation/v7_validation.jsonl": "2467d61641064dda43bf829ef9c2c328344ddca0acf65e698248d54d432b8e8a",
}

SPLIT_FILES = {
    "train": "train_v7.jsonl",
    "valid": "valid_v7.jsonl",
    "eval": "validation/v7_validation.jsonl",
}

COMPOSITION = {
    "train_rows": (3500, 4500),
    "core": (1500, 1800),
    "action_positive": (400, 600),
    "action_hard_negative": (280, 360),
    "ride_boundary": (250, 340),
    "domain_boundary": (200, 280),
    "generic_food": (150, 220),
    "greeting_oos": (170, 230),
    "nested": (200, 280),
    "dietary": (140, 200),
    "production_robustness": (200, 320),
    "paraphrase": (240, 320),
    "eval_rows": (300, 500),
    "action_hard_negative_share": (0.40, 0.45),
}


def dataset_config(name: str) -> dict:
    if name == "v7_fixed":
        systems = {
            "v6": L.SYSTEMS["v6"],
            "prod_compact": TP.compact_prompt(),
            "short": L.SYSTEMS["short"],
        }
        return {
            "root": FIXED_ROOT,
            "splits": {k: FIXED_ROOT / v for k, v in SPLIT_FILES.items()},
            "systems": systems,
            "manifest": FIXED_ROOT / "build_manifest.json",
            "staging": {
                "train": FIXED_ROOT / "training/train.jsonl",
                "valid": FIXED_ROOT / "training/valid.jsonl",
            },
            "out": REPORTS / "validation_v7_fixed.json",
            "source": None,
            "check_original": True,
        }
    return {
        "root": HERE,
        "splits": {k: HERE / v for k, v in SPLIT_FILES.items()},
        "systems": dict(L.SYSTEMS),
        "manifest": HERE / "build_manifest.json",
        "staging": {
            "train": MODEL / "train_mlx_v7.jsonl",
            "valid": MODEL / "valid_mlx_v7.jsonl",
        },
        "out": REPORTS / "validation_v7.json",
        "source": (V6_SOURCE, V6_SOURCE_SHA),
        "check_original": False,
    }


class Validator:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def check(self, name: str, ok: bool, detail) -> None:
        self.checks.append({"name": name, "pass": bool(ok), "detail": detail})

    def range_check(self, name: str, value: float, bounds: tuple[float, float]) -> None:
        lo, hi = bounds
        self.check(name, lo <= value <= hi,
                   {"value": value, "expected": f"{lo}..{hi}"})

    @property
    def passed(self) -> bool:
        return all(c["pass"] for c in self.checks)


def load_split(path: Path) -> list[tuple[int, dict]]:
    rows = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            rows.append((line_no, json.loads(line)))
    return rows


def system_label(prompt: str, systems: dict[str, str]) -> str:
    for name, text in systems.items():
        if prompt == text:
            return name
    return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", choices=["v7", "v7_fixed"], default="v7")
    args = parser.parse_args()
    cfg = dataset_config(args.dataset)
    if not cfg["root"].exists():
        raise SystemExit(f"dataset root missing: {cfg['root']}")
    v = Validator()
    v.check("sealed holdout sha256 unchanged", L.sha256(L.SEALED_HOLDOUT) == HOLDOUT_SHA,
            L.sha256(L.SEALED_HOLDOUT))
    if cfg["source"]:
        path, expected = cfg["source"]
        v.check("v6 source copy sha256 intact", L.sha256(path) == expected, L.sha256(path))
    if cfg["check_original"]:
        for rel, expected in ORIGINAL_HASHES.items():
            actual = L.sha256(HERE / rel)
            v.check(f"pre-fix dataset preserved: {rel}", actual == expected, actual)

    systems_ok = set(cfg["systems"].values())
    holdout_norm = {vd.norm_text(t) for t in L.load_jsonl_texts(L.SEALED_HOLDOUT)}
    fixture_norm = {vd.norm_text(t) for t in vd.fixture_texts()}

    seen: dict[str, str] = {}
    summary: dict[str, dict] = {}
    for name in cfg["splits"]:
        rows = load_split(cfg["splits"][name])
        errors: list[dict] = []
        domains = Counter()
        primary = Counter()
        systems = Counter()
        for line_no, row in rows:
            msgs = row.get("messages")
            if not isinstance(msgs, list) or len(msgs) != 3 or \
                    [m.get("role") for m in msgs] != ["system", "user", "assistant"]:
                errors.append({"line": line_no, "error": "messages shape"})
                continue
            sys_prompt, user, answer = (m.get("content") for m in msgs)
            if sys_prompt not in systems_ok:
                errors.append({"line": line_no, "error": "unknown system prompt"})
            if not isinstance(user, str) or not user.strip() or len(user) > 300:
                errors.append({"line": line_no, "error": "bad user text"})
                continue
            obj, parse_error = fs.parse_json_response(answer)
            if parse_error or obj is None:
                errors.append({"line": line_no, "error": f"json: {parse_error}"})
                continue
            problems = fs.validate_intent(obj)
            if obj.get("domain") == "action" and isinstance(obj.get("action"), dict):
                problems += fs.validate_action_semantics(obj["action"])
            problems += [c for c in fs.label_conflicts(user, obj) if c != "injected typo"]
            dom = obj.get("domain")
            if dom in ("food", "ride", "shop"):
                expected_priority = L.priority_policy(user, dom)
                if obj[dom].get("priority") != expected_priority:
                    problems.append(f"priority policy: {obj[dom].get('priority')} "
                                    f"!= {expected_priority}")
            if dom == "combo":
                for part in ("food", "ride"):
                    expected_priority = L.priority_policy(user, part)
                    if obj[part].get("priority") != expected_priority:
                        problems.append(f"combo {part} priority policy")
            if problems:
                errors.append({"line": line_no, "error": "; ".join(problems), "text": user})
            key = vd.norm_text(user)
            if key in holdout_norm:
                errors.append({"line": line_no, "error": "holdout exact copy", "text": user})
            if key in fixture_norm:
                errors.append({"line": line_no, "error": "fixture exact copy", "text": user})
            if key in seen:
                errors.append({"line": line_no, "error": f"duplicate of {seen[key]}", "text": user})
            else:
                seen[key] = name
            domains[dom] += 1
            systems[msgs[0]["content"]] += 1

        v.check(f"{name}: rows parsed and valid", not errors,
                {"rows": len(rows), "errors": len(errors), "examples": errors[:15]})
        summary[name] = {
            "rows": len(rows),
            "domains": dict(domains.most_common()),
            "systems": {
                system_label(s, cfg["systems"]): c
                for s, c in systems.items()
            },
            "system_variants": len(systems),
        }

    # the category tag is stored on the user row only in the manifest; rebuild
    # composition from the build manifest so the check reads the same source.
    manifest = json.loads(cfg["manifest"].read_text(encoding="utf-8"))
    primary = Counter(r["primary"] for r in manifest)
    v.range_check("train rows", summary["train"]["rows"], COMPOSITION["train_rows"])
    v.range_check("eval rows", summary["eval"]["rows"], COMPOSITION["eval_rows"])
    for key in ("core", "action_positive", "action_hard_negative", "ride_boundary",
                "domain_boundary", "generic_food", "greeting_oos", "nested", "dietary",
                "production_robustness", "paraphrase"):
        v.range_check(f"category {key}", primary.get(key, 0), COMPOSITION[key])
    neg, pos = primary.get("action_hard_negative", 0), primary.get("action_positive", 0)
    share = neg / (neg + pos) if neg + pos else 0.0
    v.range_check("action hard-negative share", round(share, 4),
                  COMPOSITION["action_hard_negative_share"])
    v.check("train uses all three system prompts", summary["train"]["system_variants"] == 3,
            summary["train"]["systems"])
    v.check("every system prompt has at least 5% of train rows",
            min(summary["train"]["systems"].values()) / summary["train"]["rows"] >= 0.05,
            summary["train"]["systems"])
    v.check("train domains cover every schema domain",
            set(summary["train"]["domains"]) == set(fs.DOMAINS),
            sorted(summary["train"]["domains"]))
    v.check("eval domains cover action, greeting, OOS and the three search domains",
            {"action", "greeting", "out_of_scope", "food", "ride", "shop"}
            <= set(summary["eval"]["domains"]),
            sorted(summary["eval"]["domains"]))
    v.check("MLX staging files match the split files",
            L.sha256(cfg["staging"]["train"]) == L.sha256(cfg["splits"]["train"]) and
            L.sha256(cfg["staging"]["valid"]) == L.sha256(cfg["splits"]["valid"]),
            {"train": L.sha256(cfg["splits"]["train"])[:16]})

    # Mandatory tokenizer + loss-mask stage. Real Qwen tokenizer, same
    # ChatDataset path and offsets mlx-lm uses to build the training mask.
    token = TP.analyse_root(cfg["root"], cfg["systems"], TP.load_tokenizer())
    token_counts = token["totals"]["counts"]
    exceptions = sum(len(s["documented_exceptions"]) for s in token["splits"].values())
    token_max = token["totals"]["sequence_tokens"]["max"]
    v.check("token preflight: no row above max_seq_length 1152",
            token_counts["over_1152"] == 0,
            {"rows_above": token_counts["over_1152"], "max_tokens": token_max})
    v.check("token preflight: no empty loss mask",
            token_counts["empty_loss_masks"] == 0,
            {"empty_masks": token_counts["empty_loss_masks"]})
    v.check("token preflight: no unexpectedly tiny loss mask",
            token_counts["tiny_loss_masks"] == 0,
            {"tiny_masks": token_counts["tiny_loss_masks"]})
    v.check("token preflight: rows above 1100 are documented",
            token_counts["over_1100"] <= exceptions,
            {"over_1100": token_counts["over_1100"], "exceptions": exceptions})

    report = {
        "phase": 13,
        "dataset": args.dataset,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pass": v.passed,
        "checks": v.checks,
        "summary": summary,
        "composition": dict(primary.most_common()),
        "action_hard_negative_share": round(share, 4),
        "counts": {c["name"]: c["pass"] for c in v.checks},
        "token_preflight": {
            "rows": token["rows"],
            "max_sequence_tokens": token_max,
            "counts": token_counts,
            "splits": {
                name: {"rows": entry["rows"],
                       "sequence_tokens": entry["sequence_tokens"],
                       "counts": entry["counts"]}
                for name, entry in token["splits"].items()
            },
        },
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = cfg["out"]
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    for c in v.checks:
        print(("PASS " if c["pass"] else "FAIL ") + c["name"], "->", c["detail"])
    print("V7 VALIDATION:", "PASS" if v.passed else "FAIL")
    print("wrote", out)
    return 0 if v.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
