#!/usr/bin/env python3
"""Evaluate a FLOUNA V6 model on the fixed, unchanged benchmarks.

    python eval_v6.py --adapter flouna-lora-v6-run2 --sets holdout,fixtures,valid,action --prompt v6
    python eval_v6.py --adapter flouna-lora-v6-run2 --sets holdout --prompt own

Scoring, slices and reporting are imported from eval_v5.py so V4/V5/V6 numbers
stay comparable. What this wrapper adds:

  --prompt own   use the system prompt embedded in each chat row (the exact
                 input V5 was scored on; V6 has never trained on it)
  --prompt v5    read the V5 training prompt from train_mlx_v5.jsonl
  --prompt v6    read the V6 training prompt from train_mlx_v6.jsonl (default)
  --prompt prod  use the production system prompt from prompt.ts
  --prompt file  use --system-file (a .jsonl row or a plain text file)

The 382-case holdout is never modified and remains sealed: it is reported as
totals plus the per-slice counters in eval_v5.report. The action set is a
sealed action benchmark that no training run has seen; it is reported with a
positives / hard-negatives breakdown because the production contract needs
both.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

import eval_v5 as ev

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

SETS = {
    "fixtures": ev.FIXTURES,
    "fixtures-holdout": ev.FIXTURES_HOLDOUT,
    "valid": HERE / "valid_mlx_v6.jsonl",
    "holdout": HERE / "eval_mlx_v5.jsonl",
    "action": HERE / "eval_action_v6.jsonl",
    "paraphrase": HERE / "eval_paraphrase_v6.jsonl",
    "train": HERE / "train_mlx_v6.jsonl",
}
SEALED = {"fixtures-holdout", "holdout"}


def prompt_from_chat_file(path: Path) -> str:
    first = next(line for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
    return json.loads(first)["messages"][0]["content"]


def read_prompt(mode: str, system_file: Path | None) -> str:
    if mode == "v5":
        return prompt_from_chat_file(HERE / "train_mlx_v5.jsonl")
    if mode == "v6":
        return prompt_from_chat_file(HERE / "train_mlx_v6.jsonl")
    if mode == "prod":
        return ev.production_prompt()
    if mode == "file":
        if system_file is None:
            raise SystemExit("--system-file is required with --prompt file")
        if system_file.suffix == ".jsonl":
            return prompt_from_chat_file(system_file)
        return system_file.read_text(encoding="utf-8")
    raise SystemExit(f"unknown prompt mode: {mode}")


def action_breakdown(results: list[dict]) -> dict:
    positives = [r for r in results if r["expected"].get("domain") == "action"]
    negatives = [r for r in results if r["expected"].get("domain") != "action"]
    kinds: dict[str, dict[str, int]] = {}
    for r in positives:
        kind = r["expected"]["action"]["kind"]
        entry = kinds.setdefault(kind, {"right": 0, "total": 0})
        entry["total"] += 1
        entry["right"] += int(r["fully_right"])
    def pct(a: int, b: int) -> str:
        return f"{a / b * 100:.1f}%" if b else "n/a"

    positives_right = sum(r["fully_right"] for r in positives)
    return {
        "positives": len(positives),
        "positives_right": positives_right,
        "positives_kind_ok": sum(
            isinstance(r["actual"], dict)
            and isinstance(r["actual"].get("action"), dict)
            and r["actual"]["action"].get("kind") == r["expected"]["action"]["kind"]
            for r in positives
        ),
        "negatives": len(negatives),
        "negatives_not_action": sum(r["got_domain"] != "action" for r in negatives),
        "negatives_right": sum(r["fully_right"] for r in negatives),
        "kinds": kinds,
        # string, not the callable: the dict is written to --json
        "positives_pct": pct(positives_right, len(positives)),
    }


def behavioural_slices(results: list[dict]) -> dict:
    """Domain-level rates the final report asks for explicitly."""
    want_counts = Counter(r["want_domain"] for r in results)
    got = Counter(r["got_domain"] for r in results)
    oos_rows = [r for r in results if r["want_domain"] == "out_of_scope"]
    greeting_rows = [r for r in results if r["want_domain"] == "greeting"]
    non_greeting = [r for r in results if r["want_domain"] not in (None, "greeting")]
    return {
        "domains_expected": dict(want_counts),
        "domains_actual": dict(got),
        "oors": len(oos_rows),
        "oos_right": sum(r["fully_right"] for r in oos_rows),
        "oos_as_action": sum(r["got_domain"] == "action" for r in oos_rows),
        "false_greeting": sum(r["got_domain"] == "greeting" for r in non_greeting),
        "non_greeting": len(non_greeting),
        "json_valid": sum(r["json_valid"] for r in results),
        "total": len(results),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["mlx", "ollama", "mock"], default="mlx")
    parser.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
    parser.add_argument("--adapter", default=None)
    parser.add_argument("--url", default="http://localhost:11434")
    parser.add_argument("--sets", default="holdout,fixtures,fixtures-holdout,valid,action")
    parser.add_argument("--prompt", choices=["own", "v5", "v6", "prod", "file"], default="v6")
    parser.add_argument("--system-file", type=Path, default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--train-data", type=Path, default=None,
                        help="override the 'train' set path (e.g. a sampled subset)")
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument("--predictions", type=Path, default=None)
    parser.add_argument("--show-failures", action="store_true")
    args = parser.parse_args()
    if args.train_data is not None:
        SETS["train"] = args.train_data

    names = [n.strip() for n in args.sets.split(",") if n.strip()]
    unknown = [n for n in names if n not in SETS]
    if unknown:
        raise SystemExit(f"unknown sets: {unknown}")

    override = None if args.prompt == "own" else read_prompt(args.prompt, args.system_file)
    all_cases: dict[str, list[ev.Case]] = {}
    for name in names:
        path = SETS[name]
        cases = ev.load_fixtures(path, name) if name.startswith("fixtures") else ev.load_chat(path, name)
        if args.limit:
            cases = cases[: args.limit]
        all_cases[name] = cases

    if args.backend == "mock":
        backend = ev.MockBackend({c.id: c for cases in all_cases.values() for c in cases})
    elif args.backend == "ollama":
        backend = ev.OllamaBackend(args.url, args.model, args.timeout)
    else:
        backend = ev.MLXBackend(args.model, args.adapter, args.max_tokens, args.batch_size)

    report_json: dict[str, dict] = {}
    prediction_rows: list[dict] = []
    for name, cases in all_cases.items():
        pairs = []
        for case in cases:
            if override is not None:
                system = override
            else:
                system = case.system or prompt_from_chat_file(HERE / "train_mlx_v6.jsonl")
            pairs.append((system, case.text))
        raw_results = []
        if hasattr(backend, "complete_batch") and args.batch_size > 1:
            for start in range(0, len(pairs), args.batch_size):
                raw_results.extend(backend.complete_batch(pairs[start:start + args.batch_size]))
                done = min(len(pairs), start + args.batch_size)
                sys.stderr.write(f"  {name}: {done}/{len(pairs)}\r")
        else:
            for i, (system, text) in enumerate(pairs, 1):
                started = time.perf_counter()
                try:
                    raw, error = backend.complete(system, text), None
                except Exception as exc:
                    raw, error = None, f"{type(exc).__name__}: {exc}"
                raw_results.append((raw, error, (time.perf_counter() - started) * 1000))
                if (i % 20 == 0) or i == len(pairs):
                    sys.stderr.write(f"  {name}: {i}/{len(pairs)}\r")
        results = [ev.score(case, raw, error, ms) for case, (raw, error, ms) in zip(cases, raw_results)]
        sys.stderr.write(" " * 40 + "\r")
        metrics = ev.aggregate(results)
        metrics["behaviour"] = behavioural_slices(results)
        if name == "action":
            metrics["action"] = action_breakdown(results)
        report_json[name] = metrics
        sealed = name in SEALED
        ev.report(name, metrics, show_failures=args.show_failures and not sealed, results=results)
        if name == "action":
            a = metrics["action"]
            print(f"  action positives {a['positives_right']}/{a['positives']} "
                  f"({a['positives_pct']})  "
                  f"kind ok {a['positives_kind_ok']}/{a['positives']}")
            print(f"  hard negatives  stay non-action {a['negatives_not_action']}/{a['negatives']}  "
                  f"fully right {a['negatives_right']}/{a['negatives']}")
            for kind, st in sorted(a["kinds"].items()):
                print(f"    {kind:<22} {st['right']}/{st['total']}")
        for r in results:
            prediction_rows.append({
                "set": name,
                "id": r["id"],
                "text": r["text"] if not sealed else None,
                "expected": r["expected"],
                "actual": r["actual"],
                "raw": r["raw"] if not sealed else None,
                "error": r["error"],
                "fully_right": r["fully_right"],
                "domain_ok": r["domain_ok"],
                "sealed": sealed,
            })

    if args.json:
        args.json.write_text(json.dumps(report_json, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nwrote {args.json}")
    if args.predictions:
        args.predictions.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in prediction_rows) + "\n",
            encoding="utf-8",
        )
        print(f"wrote {args.predictions}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
