#!/usr/bin/env python3
"""Phase 11 offline reporting.

Reads eval prediction/JSON artifacts and classifies misses so the failure
breakdown is reproducible. Scoring definitions live in eval_v5.py and are not
re-implemented here: correct/incorrect comes from the `fully_right` flag the
harness already wrote, and per-field mismatches come from
flouna_schema.compare_expected.

Writes only under results/. Never touches the sealed holdout.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import eval_v5 as ev
import flouna_schema as fs

HERE = Path(__file__).resolve().parent
RES = HERE / "results"

FIELD_CLASS = {
    "food.item": "entity extraction",
    "shop.item": "entity extraction",
    "shop.category": "entity extraction",
    "food.priority": "priority",
    "ride.priority": "priority",
    "shop.priority": "priority",
    "food.dietary": "dietary",
    "ride.pickup": "ride",
    "ride.drop": "ride",
    "ride.vehicle": "ride",
    "ride.budgetPaise": "ride",
    "ride.maxPickupMinutes": "ride",
    "ride.scheduleAt": "ride",
    "food.budgetPaise": "constraint",
    "food.maxEtaMinutes": "constraint",
}


def flat(expected: dict) -> dict[str, object]:
    out = {}
    for key, want in expected.items():
        if isinstance(want, dict):
            for sub, sub_want in want.items():
                out[f"{key}.{sub}"] = sub_want
        else:
            out[key] = want
    return out


def nested_missing(expected: dict, actual: dict | None) -> bool:
    """Expected a nested body object but the model returned it flat."""
    if not isinstance(actual, dict):
        return False
    for part in ("food", "ride", "shop"):
        body = expected.get(part)
        if not isinstance(body, dict) or not body:
            continue
        got = actual.get(part)
        if isinstance(got, dict):
            continue
        # flat-key tells: top level carries this body's fields directly
        if any(k in actual for k in body) or any(
            k.startswith(part[:3]) or k.startswith(part) for k in actual if k != part
        ):
            return True
    return False


def classify(expected: dict, actual: dict | None, raw_ok: bool) -> dict:
    want_domain = expected.get("domain")
    got_domain = actual.get("domain") if isinstance(actual, dict) else None
    schema_errors = fs.validate_intent(actual) if isinstance(actual, dict) else ["not an object"]
    mism = [f for f in fs.compare_expected(expected, actual or {}) if not f["ok"]]

    if actual is None or not raw_ok:
        return {"category": "JSON formatting", "detail": "no parsable JSON object", "fields": []}
    if schema_errors:
        return {
            "category": "label/schema mismatch",
            "detail": "; ".join(schema_errors)[:200],
            "fields": [f["field"] for f in mism],
        }
    if want_domain is not None and got_domain != want_domain:
        if got_domain == "greeting" and want_domain != "greeting":
            cat = "greeting confusion"
        elif want_domain == "out_of_scope":
            cat = "out-of-scope"
        elif got_domain is None:
            cat = "domain classification"
        else:
            cat = "domain classification"
        return {"category": cat, "detail": f"domain {want_domain} -> {got_domain}", "fields": [f["field"] for f in mism]}
    if nested_missing(expected, actual):
        return {"category": "nested structure", "detail": "nested body returned flat", "fields": [f["field"] for f in mism]}
    if not mism:
        # fully_right already accounts for this; mismatch here means the harness
        # judged it wrong on something not exposed as a field (e.g. casing of reply)
        return {"category": "other", "detail": "no field mismatch reported by harness", "fields": []}

    cats = []
    for f in mism:
        name = f["field"]
        want, got = f["want"], f["got"]
        if isinstance(want, str) and isinstance(got, str) and want.lower() == got.lower():
            cats.append("casing")
        else:
            cats.append(FIELD_CLASS.get(name, "other"))
    primary = Counter(cats).most_common(1)[0][0]
    detail = "; ".join(f"{f['field']}: {f['want']!r} -> {f['got']!r}" for f in mism)[:300]
    return {"category": primary, "detail": detail, "fields": [f["field"] for f in mism]}


def load_predictions(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def analyse(pred_path: Path, result_path: Path | None, set_name: str) -> dict:
    rows = [r for r in load_predictions(pred_path) if r["set"] == set_name]
    total = len(rows)
    correct = sum(1 for r in rows if r["fully_right"])
    failures = []
    for r in rows:
        if r["fully_right"]:
            continue
        actual = r["actual"]
        info = classify(r["expected"], actual, isinstance(actual, dict))
        failures.append(
            {
                "id": r["id"],
                "expected": r["expected"],
                "actual": actual,
                "category": info["category"],
                "detail": info["detail"],
                "fields": info["fields"],
            }
        )
    cats = Counter(f["category"] for f in failures)
    summary = {
        "set": set_name,
        "total": total,
        "correct": correct,
        "incorrect": total - correct,
        "accuracy": round(100.0 * correct / total, 2) if total else None,
        "categories": {k: {"n": v, "pct_of_failures": round(100.0 * v / max(1, len(failures)), 1)} for k, v in cats.most_common()},
        "failures": failures,
    }
    if result_path and result_path.exists():
        summary["harness"] = json.loads(result_path.read_text(encoding="utf-8")).get(set_name)
        h = summary["harness"] or {}
        summary["harness_checks"] = {
            "json_valid": h.get("json_valid"),
            "domain_right": h.get("domain_right"),
            "parse_ok": h.get("parse_ok"),
            "false_greeting": h.get("false_greeting"),
            "latency": h.get("latency"),
        }
    return summary


def pct(num, den):
    return None if not den else round(100.0 * num / den, 2)


def comparison() -> dict:
    v5 = json.loads((RES / "v5_run2.json").read_text(encoding="utf-8"))["holdout"]
    v6 = json.loads((RES / "v6_phase11_sealed_v5prompt.json").read_text(encoding="utf-8"))["holdout"]

    def field(h, name):
        f = h["fields"][name]
        return {"ok": f["ok"], "total": f["total"], "pct": pct(f["ok"], f["total"])}

    def slice_(h, name):
        s = h["slices"][name]
        return {"ok": s["right"], "total": s["total"], "pct": pct(s["right"], s["total"])}

    def metrics(h):
        return {
            "overall": {"ok": h["right"], "total": h["total"], "pct": pct(h["right"], h["total"])},
            "domain": field(h, "domain"),
            "food_priority": field(h, "food.priority"),
            "dietary": field(h, "food.dietary"),
            "ride": slice_(h, "ride"),
            "nested": slice_(h, "nested"),
            "json": {"ok": h["json_valid"], "total": h["total"], "pct": pct(h["json_valid"], h["total"])},
            "oos": slice_(h, "out_of_scope"),
            "false_greeting": {"n": h["false_greeting"], "total": h["total"], "pct": pct(h["false_greeting"], h["total"])},
        }

    m5, m6 = metrics(v5), metrics(v6)
    table = {}
    for key in m5:
        table[key] = {
            "v5": m5[key],
            "v6": m6[key],
            "delta_pp": round(m6[key]["pct"] - m5[key]["pct"], 2),
        }
    return table


def prompt_runs() -> dict:
    out = {}
    for label, fname in [
        ("v5_prompt", "v6_phase11_sealed_v5prompt.json"),
        ("v6_prompt", "v6_phase11_sealed_v6prompt.json"),
        ("production_prompt", "v6_phase11_sealed_prodprompt.json"),
    ]:
        h = json.loads((RES / fname).read_text(encoding="utf-8"))["holdout"]
        out[label] = {
            "total": h["total"],
            "right": h["right"],
            "pct": pct(h["right"], h["total"]),
            "domain_right": h["domain_right"],
            "json_valid": h["json_valid"],
            "false_greeting": h["false_greeting"],
            "confusion": h["confusion"],
            "slices": h["slices"],
            "fields": h["fields"],
            "latency": h["latency"],
        }
    return out


def side_sets() -> dict:
    v6 = json.loads((RES / "v6_phase11_action_paraphrase.json").read_text(encoding="utf-8"))
    v5 = json.loads((RES / "v5_phase11_action_paraphrase.json").read_text(encoding="utf-8"))
    out = {}
    for name in ("action", "paraphrase"):
        out[name] = {
            "v6": {k: v6[name][k] for k in ("total", "right", "json_valid", "false_greeting", "latency")},
            "v5": {k: v5[name][k] for k in ("total", "right", "json_valid", "false_greeting", "latency")},
            "delta_pp": round(
                pct(v6[name]["right"], v6[name]["total"]) - pct(v5[name]["right"], v5[name]["total"]), 2
            ),
        }
        if name == "action":
            out[name]["v6_action"] = v6[name]["action"]
            out[name]["v5_action"] = v5[name]["action"]
    return out


def metadata() -> dict:
    import hashlib
    import importlib.metadata as md
    import platform
    import subprocess

    def sha(path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def git(*args: str) -> str:
        try:
            return subprocess.run(
                ["git", *args], cwd=HERE, capture_output=True, text=True, check=False
            ).stdout.strip()
        except Exception:
            return "not available"

    def ver(pkg: str) -> str:
        try:
            return md.version(pkg)
        except Exception:
            return "not available"

    return {
        "v6_checkpoint": "flouna-lora-v6-run2/0001600_adapters.safetensors",
        "v6_checkpoint_sha256": sha(HERE / "flouna-lora-v6-run2/0001600_adapters.safetensors"),
        "v6_loaded_via": "flouna-lora-v6-run2 (adapters.safetensors is byte-identical to 0001600)",
        "v6_loaded_sha256": sha(HERE / "flouna-lora-v6-run2/adapters.safetensors"),
        "holdout": "eval_mlx_v5.jsonl",
        "holdout_sha256": sha(HERE / "eval_mlx_v5.jsonl"),
        "v5_baseline": "results/v5_run2.json",
        "eval_script": "eval_v6.py",
        "eval_harness": "eval_v5.py",
        "analysis_script": "analyze_phase11.py",
        "production_prompt": "prompt.ts (read through eval_v5.production_prompt)",
        "eval_config": {"backend": "mlx", "model": "Qwen/Qwen2.5-1.5B-Instruct", "batch_size": 4, "max_tokens": 512},
        "git_branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "git_head": git("rev-parse", "HEAD"),
        "python": platform.python_version(),
        "mlx": ver("mlx"),
        "mlx_lm": ver("mlx-lm"),
        "safetensors": ver("safetensors"),
        "gguf": ver("gguf"),
    }


def main(argv: list[str]) -> int:
    out: dict[str, object] = {}
    jobs = [
        ("sealed_v5prompt", RES / "v6_phase11_sealed_v5prompt.jsonl", RES / "v6_phase11_sealed_v5prompt.json", "holdout"),
        ("sealed_v6prompt", RES / "v6_phase11_sealed_v6prompt.jsonl", RES / "v6_phase11_sealed_v6prompt.json", "holdout"),
        ("sealed_prodprompt", RES / "v6_phase11_sealed_prodprompt.jsonl", RES / "v6_phase11_sealed_prodprompt.json", "holdout"),
        ("action_v6prompt", RES / "v6_phase11_action_paraphrase.jsonl", RES / "v6_phase11_action_paraphrase.json", "action"),
        ("paraphrase_v6prompt", RES / "v6_phase11_action_paraphrase.jsonl", RES / "v6_phase11_action_paraphrase.json", "paraphrase"),
    ]
    for key, pred, res, set_name in jobs:
        if not pred.exists():
            print(f"missing {pred}", file=sys.stderr)
            continue
        out[key] = analyse(pred, res, set_name)
        s = out[key]
        print(f"{key:22} {s['correct']}/{s['total']} = {s['accuracy']}%  failures={s['incorrect']}")
        for c, n in s["categories"].items():
            print(f"    {c:24} {n['n']:>3}  ({n['pct_of_failures']}%)")
    if (RES / "v6_phase11_sealed_v5prompt.json").exists():
        out["comparison_v5_v6"] = comparison()
        out["holdout_by_prompt"] = prompt_runs()
        out["side_sets_v5_v6"] = side_sets()
    out["metadata"] = metadata()
    path = RES / "v6_phase11_analysis.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
