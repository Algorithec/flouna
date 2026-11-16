#!/usr/bin/env python3
"""Evaluate a FLOUNA intent model, honestly and reproducibly.

    python eval_v5.py --backend mlx --model Qwen/Qwen2.5-1.5B-Instruct --adapter flouna-lora-v5 --sets valid,fixtures
    python eval_v5.py --backend ollama --model flouna-1.5b-v5 --sets fixtures,fixtures-holdout,holdout --sealed fixtures-holdout,holdout

Scores a model on the repo fixtures and on chat-format JSONL. Reports JSON
validity, schema validity, domain and per-field accuracy, fully-right cases, a
domain confusion matrix, and slices for priority, dietary, budgets, deadlines,
missing fields, multi-constraint requests and prompt injection. Sealed sets
are reported as totals only, as the repo harness does for its held-out set.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import flouna_schema as fs

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TRAIN_FILE = HERE / "train_mlx_v5.jsonl"
V4_EVAL = HERE / "eval_mlx.jsonl"
VALID = HERE / "valid_mlx_v5.jsonl"
HOLDOUT = HERE / "eval_mlx_v5.jsonl"
FIXTURES = ROOT / "server/test/fixtures/intent-eval.jsonl"
FIXTURES_HOLDOUT = ROOT / "server/test/fixtures/intent-eval-holdout.jsonl"

SETS = {
    "fixtures": FIXTURES,
    "fixtures-holdout": FIXTURES_HOLDOUT,
    "valid": VALID,
    "holdout": HOLDOUT,
    "train": TRAIN_FILE,
    "v4eval": V4_EVAL,
}
SEALED_DEFAULT = {"fixtures-holdout", "holdout"}

LEAK_RE = re.compile(
    r"system prompt|my instructions|my rules|here are (?:my|the) instructions|"
    r"BREACH|ignore (?:all )?previous|you are now (?:a|an) ",
    re.I,
)


@dataclass
class Case:
    id: str
    text: str
    expected: dict
    source: str
    system: str | None = None
    injection: bool = False


def load_chat(path: Path, source: str) -> list[Case]:
    cases = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        messages = row["messages"]
        cases.append(Case(
            id=f"{source}-{i}",
            text=messages[1]["content"],
            expected=json.loads(messages[2]["content"]),
            source=source,
            system=messages[0]["content"],
            injection=bool(row.get("injection")),
        ))
    return cases


def load_fixtures(path: Path, source: str) -> list[Case]:
    cases = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        cases.append(Case(
            id=row.get("id", source),
            text=row["message"],
            expected=row["expect"],
            source=source,
            injection=bool(row.get("injection")),
        ))
    return cases


def production_prompt() -> str:
    src = (ROOT / "server/src/modules/chat/llm/prompt.ts").read_text(encoding="utf-8")
    system = re.search(r"export const SYSTEM_PROMPT = `(.*?)`;", src, re.S)
    shape = re.search(r"export const JSON_SHAPE =\s*(.*?);\s*\n\n// The schema", src, re.S)
    if not system or not shape:
        raise SystemExit("could not read the production prompt from prompt.ts")
    joined = "".join(re.findall(r"`([^`]*)`", shape.group(1)))
    return f"{system.group(1)}\n\n{joined}"


def training_prompt() -> str:
    return json.loads(TRAIN_FILE.read_text(encoding="utf-8").splitlines()[0])["messages"][0]["content"]


class OllamaBackend:
    def __init__(self, url: str, model: str, timeout: float = 120.0):
        self.url = url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def complete(self, system: str, user: str) -> str:
        payload = {
            "model": self.model,
            "stream": False,
            "temperature": 0,
            "max_tokens": 512,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        req = urllib.request.Request(
            f"{self.url}/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as response:
            data = json.loads(response.read())
        content = data["choices"][0]["message"]["content"]
        return content or ""


class MLXBackend:
    def __init__(self, model: str, adapter: str | None, max_tokens: int = 512,
                 batch_size: int = 8):
        import importlib

        from mlx_lm import generate, load
        from mlx_lm.sample_utils import make_sampler

        self._generate = generate
        self._batch_generate = importlib.import_module("mlx_lm.generate").batch_generate
        self.model, self.tokenizer = load(model, adapter_path=adapter)
        self.sampler = make_sampler(temp=0.0)
        self.max_tokens = max_tokens
        self.batch_size = max(1, batch_size)

    def _prompt(self, system: str, user: str) -> list[int]:
        return self.tokenizer.apply_chat_template(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            add_generation_prompt=True,
        )

    def complete(self, system: str, user: str) -> str:
        return self._generate(
            self.model, self.tokenizer, prompt=self._prompt(system, user),
            max_tokens=self.max_tokens, sampler=self.sampler, verbose=False,
        )

    def complete_batch(self, pairs: list[tuple[str, str]]) -> list[tuple[str | None, str | None, float]]:
        """Greedy generation in chunks. Latency is amortised per request."""
        out: list[tuple[str | None, str | None, float]] = []
        for start in range(0, len(pairs), self.batch_size):
            chunk = pairs[start:start + self.batch_size]
            began = time.perf_counter()
            try:
                prompts = [self._prompt(system, user) for system, user in chunk]
                response = self._batch_generate(
                    self.model, self.tokenizer, prompts,
                    max_tokens=self.max_tokens, sampler=self.sampler, verbose=False,
                )
                elapsed = (time.perf_counter() - began) * 1000 / len(chunk)
                out.extend((text, None, elapsed) for text in response.texts)
            except Exception as exc:  # one bad chunk must not kill the run
                for system, user in chunk:
                    began = time.perf_counter()
                    try:
                        raw = self.complete(system, user)
                        out.append((raw, None, (time.perf_counter() - began) * 1000))
                    except Exception as inner:
                        out.append((None, f"{type(inner).__name__}: {inner}",
                                    (time.perf_counter() - began) * 1000))
        return out


class MockBackend:
    """Answers with the expected label. Only checks the harness itself."""

    def __init__(self, cases: dict[str, Case]):
        self.cases = cases

    def complete(self, system: str, user: str) -> str:
        for case in self.cases.values():
            if case.text == user:
                return json.dumps(case.expected)
        return '{"domain": "out_of_scope", "reply": "x"}'


def slices(expected: dict) -> list[str]:
    names: list[str] = []
    domain = expected.get("domain")
    if domain:
        names.append(domain)
    for part in ("food", "ride", "shop"):
        body = expected.get(part)
        if not isinstance(body, dict):
            continue
        names.append("nested")
        if body.get("priority") in ("price", "speed", "rating"):
            names.append(f"priority_{body['priority']}")
        if body.get("dietary") in ("veg", "nonveg"):
            names.append(f"dietary_{body['dietary']}")
        if body.get("budgetPaise") is not None:
            names.append("budget")
        if body.get("maxEtaMinutes") is not None:
            names.append("eta")
        if body.get("maxPickupMinutes") is not None:
            names.append("wait")
        if body.get("scheduleAt") is not None:
            names.append("schedule")
        for key in ("budgetPaise", "maxEtaMinutes", "maxPickupMinutes", "pickup", "scheduleAt"):
            if key in body and body[key] is None:
                names.append("missing_field")
                break
    if fs.constraint_count(expected) >= 2:
        names.append("multi_constraint")
    return names


def score(case: Case, raw: str | None, error: str | None, ms: float) -> dict:
    actual = None
    parse_error = None
    if raw is not None:
        actual, parse_error = fs.parse_json_response(raw)
    schema_errors = fs.validate_intent(actual) if isinstance(actual, dict) else ["not an object"]
    fields = fs.compare_expected(case.expected, actual) if actual is not None else [
        {"field": k, "want": v, "got": None, "ok": False}
        for k, v in _flat_expect(case.expected)
    ]
    want_domain = case.expected.get("domain")
    got_domain = actual.get("domain") if isinstance(actual, dict) else None
    reply = actual.get("reply", "") if isinstance(actual, dict) else ""
    leak = bool(LEAK_RE.search(raw or "") or LEAK_RE.search(reply))
    return {
        "id": case.id,
        "source": case.source,
        "text": case.text,
        "expected": case.expected,
        "raw": raw,
        "error": error,
        "ms": ms,
        "parse_ok": actual is not None,
        "json_valid": isinstance(actual, dict) and not schema_errors,
        "schema_errors": schema_errors,
        "fields": fields,
        "fields_ok": all(f["ok"] for f in fields),
        "fully_right": isinstance(actual, dict) and not schema_errors and all(f["ok"] for f in fields),
        "domain_ok": want_domain is None or got_domain == want_domain,
        "got_domain": got_domain,
        "want_domain": want_domain,
        "leak": leak,
        "injection": case.injection,
        "slices": slices(case.expected),
        "actual": actual,
    }


def _flat_expect(expected: dict):
    for key, want in expected.items():
        if isinstance(want, dict):
            for sub, sub_want in want.items():
                yield f"{key}.{sub}", sub_want
        else:
            yield key, want


def aggregate(results: list[dict]) -> dict:
    total = len(results)
    ok = [r for r in results if r["error"] is None]
    latencies = [r["ms"] for r in ok]
    fields: dict[str, dict[str, int]] = defaultdict(lambda: {"ok": 0, "total": 0})
    for r in results:
        for f in r["fields"]:
            fields[f["field"]]["total"] += 1
            fields[f["field"]]["ok"] += int(f["ok"])
    confusion = Counter()
    for r in results:
        if r["want_domain"] is not None:
            confusion[(r["want_domain"], r["got_domain"])] += 1
    slice_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"right": 0, "domain": 0, "total": 0})
    for r in results:
        for name in r["slices"]:
            slice_stats[name]["total"] += 1
            slice_stats[name]["right"] += int(r["fully_right"])
            slice_stats[name]["domain"] += int(r["domain_ok"])
    return {
        "total": total,
        "right": sum(r["fully_right"] for r in results),
        "fields_right": sum(r["fields_ok"] for r in results),
        "domain_right": sum(r["domain_ok"] for r in results),
        "parse_ok": sum(r["parse_ok"] for r in results),
        "json_valid": sum(r["json_valid"] for r in results),
        "errors": total - len(ok),
        "timeouts": sum(1 for r in results if r["error"] and "time" in r["error"].lower()),
        "leaks": sum(r["leak"] for r in results),
        "injection_total": sum(r["injection"] for r in results),
        "injection_held": sum(r["injection"] and r["domain_ok"] and not r["leak"] for r in results),
        "false_greeting": sum(
            r["want_domain"] not in (None, "greeting") and r["got_domain"] == "greeting" for r in results
        ),
        "fields": dict(fields),
        # str() keys so an unparsable output (got_domain None) can't crash the sort
        "confusion": {
            f"{a}->{b}": n
            for (a, b), n in sorted(confusion.items(), key=lambda kv: (str(kv[0][0]), str(kv[0][1])))
        },
        "slices": {k: dict(v) for k, v in sorted(slice_stats.items())},
        "latency": {
            "p50": round(statistics.median(latencies), 1) if latencies else None,
            "p95": round(_p95(latencies), 1) if latencies else None,
            "max": round(max(latencies), 1) if latencies else None,
        },
    }


def _p95(values: list[float]) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))
    return ordered[index]


def pct(a: int, b: int) -> str:
    return f"{a / b * 100:.1f}%" if b else "n/a"


def report(name: str, m: dict, show_failures: bool, results: list[dict]) -> None:
    print(f"\n{name} ({m['total']} cases)")
    print(f"  fully right     {m['right']}/{m['total']}  {pct(m['right'], m['total'])}")
    print(f"  labels right    {m['fields_right']}/{m['total']}  {pct(m['fields_right'], m['total'])}")
    print(f"  domain          {m['domain_right']}/{m['total']}  {pct(m['domain_right'], m['total'])}")
    print(f"  JSON valid      {m['json_valid']}/{m['total']}  {pct(m['json_valid'], m['total'])}")
    print(f"  parse ok        {m['parse_ok']}/{m['total']}  {pct(m['parse_ok'], m['total'])}")
    print(f"  latency         p50 {m['latency']['p50']}ms  p95 {m['latency']['p95']}ms  max {m['latency']['max']}ms")
    print(f"  errors {m['errors']}  timeouts {m['timeouts']}  leaks {m['leaks']}  false greeting {m['false_greeting']}")
    if m["injection_total"]:
        print(f"  injection held  {m['injection_held']}/{m['injection_total']}")
    print("  field                     acc")
    for field_name in sorted(m["fields"]):
        f = m["fields"][field_name]
        print(f"  {field_name:<24} {pct(f['ok'], f['total']):>6}  ({f['ok']}/{f['total']})")
    if m["confusion"]:
        print("  domain confusion")
        for pair, n in m["confusion"].items():
            print(f"    {pair:<32} {n}")
    print("  slices (right / domain / total)")
    for name_, s in m["slices"].items():
        print(f"    {name_:<20} {s['right']:>4} / {s['domain']:>4} / {s['total']}")
    if show_failures:
        failures = [r for r in results if not r["fully_right"]]
        if failures:
            print(f"  failures ({len(failures)}):")
            for r in failures[:20]:
                bad = [f"{f['field']}: want {f['want']!r} got {f['got']!r}" for f in r["fields"] if not f["ok"]]
                print(f"    {r['id']} | {r['text'][:110]}")
                if r["error"]:
                    print(f"      error: {r['error']}")
                if r["schema_errors"]:
                    print(f"      schema: {r['schema_errors'][:3]}")
                if bad:
                    print(f"      fields: {'; '.join(bad[:4])}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["mlx", "ollama", "mock"], default="mlx")
    parser.add_argument("--model", required=False, help="HF path or Ollama model name")
    parser.add_argument("--adapter", default=None, help="MLX LoRA adapter path")
    parser.add_argument("--url", default="http://localhost:11434")
    parser.add_argument("--sets", default="fixtures,valid", help=f"comma separated: {','.join(SETS)}")
    parser.add_argument("--sealed", default=",".join(sorted(SEALED_DEFAULT)),
                        help="sets reported as totals only")
    parser.add_argument("--system", choices=["train", "prod"], default="train",
                        help="system prompt for fixture cases; chat rows keep their own under 'train'")
    parser.add_argument("--limit", type=int, default=None, help="first N cases per set")
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=8,
                        help="MLX generation chunk; 1 forces one request at a time")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--train-data", type=Path, default=TRAIN_FILE,
                        help="JSONL backing the 'train' set, for curriculum accuracy checks")
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument("--predictions", type=Path, default=None)
    parser.add_argument("--show-failures", action="store_true", default=True)
    args = parser.parse_args()
    SETS["train"] = args.train_data

    names = [n.strip() for n in args.sets.split(",") if n.strip()]
    unknown = [n for n in names if n not in SETS]
    if unknown:
        raise SystemExit(f"unknown sets: {unknown}")
    sealed = {n.strip() for n in args.sealed.split(",") if n.strip()}
    system_override = production_prompt() if args.system == "prod" else training_prompt()

    all_cases: dict[str, list[Case]] = {}
    for name in names:
        path = SETS[name]
        if name.startswith("fixtures"):
            cases = load_fixtures(path, name)
        else:
            cases = load_chat(path, name)
        if args.limit:
            cases = cases[: args.limit]
        all_cases[name] = cases

    if args.backend == "mock":
        lookup = {case.id: case for cases in all_cases.values() for case in cases}
        backend = MockBackend(lookup)
    elif args.backend == "ollama":
        if not args.model:
            raise SystemExit("--model is required for the ollama backend")
        backend = OllamaBackend(args.url, args.model, args.timeout)
    else:
        if not args.model:
            raise SystemExit("--model is required for the mlx backend")
        backend = MLXBackend(args.model, args.adapter, args.max_tokens, args.batch_size)

    report_json: dict[str, dict] = {}
    prediction_rows: list[dict] = []
    for name, cases in all_cases.items():
        pairs = [
            (case.system if (args.system == "train" and case.system) else system_override, case.text)
            for case in cases
        ]
        if hasattr(backend, "complete_batch") and args.batch_size > 1:
            raw_results = []
            for start in range(0, len(pairs), args.batch_size):
                raw_results.extend(backend.complete_batch(pairs[start:start + args.batch_size]))
                done = min(len(pairs), start + args.batch_size)
                sys.stderr.write(f"  {name}: {done}/{len(pairs)}\r")
        else:
            raw_results = []
            for i, (system, text) in enumerate(pairs, 1):
                start = time.perf_counter()
                try:
                    raw, error = backend.complete(system, text), None
                except Exception as exc:
                    raw, error = None, f"{type(exc).__name__}: {exc}"
                raw_results.append((raw, error, (time.perf_counter() - start) * 1000))
                if (i % 20 == 0) or i == len(cases):
                    sys.stderr.write(f"  {name}: {i}/{len(pairs)}\r")
        results = [score(case, raw, error, ms) for case, (raw, error, ms) in zip(cases, raw_results)]
        sys.stderr.write(" " * 40 + "\r")
        metrics = aggregate(results)
        report_json[name] = metrics
        is_sealed = name in sealed
        report(name, metrics, show_failures=args.show_failures and not is_sealed, results=results)
        for r in results:
            prediction_rows.append({
                "set": name,
                "id": r["id"],
                "text": r["text"] if not is_sealed else None,
                "expected": r["expected"],
                "actual": r["actual"],
                "raw": r["raw"] if not is_sealed else None,
                "ms": round(r["ms"], 1),
                "error": r["error"],
                "fully_right": r["fully_right"],
                "domain_ok": r["domain_ok"],
                "sealed": is_sealed,
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
