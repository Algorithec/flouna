#!/usr/bin/env python3
"""Exercise the local flouna-1.5b-v5 Ollama model and store raw responses.

Covers the 16 manual probes from the task spec plus extra food/priority/dietary/
ride/greeting/OOS/ambiguous/nested/multi-constraint cases. Responses are stored
verbatim; nothing is edited.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import flouna_schema as fs

MODEL = "flouna-1.5b-v5"
ENDPOINT = "http://localhost:11434/api/chat"

SPEC_PROMPTS = [
    "order me a pizza under 300 rupees",
    "find me a cheap pizza",
    "I need food quickly",
    "find me something affordable",
    "show me non-veg biryani",
    "find non vegetarian food",
    "what is the fastest option",
    "I don't want to wait",
    "tell me a joke",
    "who won the cricket match",
    "what is the weather today",
    "explain quantum computing",
    "I want pizza",
    "I want vegetarian pizza under 300",
    "I want chicken biryani delivered quickly",
    "I need a cab to the airport",
]

EXTRA_PROMPTS = [
    # priority
    "cheapest veg biryani",
    "top rated pizza near me",
    "quick delivery of dosa",
    # dietary
    "I eat meat, show me food",
    "show me non vegetarian food under 250",
    # ride
    "pick me up from Banjara Hills in 6 minutes, drop at Hitech City",
    "book a cab to the airport at 7pm",
    # nested combo
    "order dinner and book a cab home",
    # multi-constraint
    "I want veg pizza under 300 within 30 minutes",
    # ambiguous
    "I'm hungry",
    "something spicy",
    # short
    "cab",
    # long
    "I want to order two veg pizzas for my family under 500 rupees and a cab to the airport at 7pm",
    # missing fields
    "I want biryani",
    # greeting
    "hello",
    # out of scope
    "who is the president of France",
]


def chat(prompt: str) -> dict:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0},
    }).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.load(resp)


def main() -> int:
    rows = []
    for prompt in SPEC_PROMPTS + EXTRA_PROMPTS:
        started = time.perf_counter()
        payload = chat(prompt)
        ms = round((time.perf_counter() - started) * 1000, 1)
        raw = payload.get("message", {}).get("content", "")
        obj, err = fs.parse_json_response(raw)
        rows.append({
            "prompt": prompt,
            "raw": raw,
            "ms": ms,
            "parse_ok": obj is not None,
            "parse_error": err,
            "schema_errors": fs.validate_intent(obj) if isinstance(obj, dict) else ["not an object"],
            "conflicts": fs.label_conflicts(prompt, obj) if isinstance(obj, dict) else [],
            "done_reason": payload.get("done_reason"),
            "eval_count": payload.get("eval_count"),
        })
        ok = obj is not None and not rows[-1]["schema_errors"]
        print(f"[{'OK ' if ok else 'MISS'}] {prompt}\n  -> {raw.strip()}\n")

    out = HERE / "results" / "v5_ollama_raw.json"
    out.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    parsed = sum(1 for r in rows if r["parse_ok"])
    valid = sum(1 for r in rows if r["parse_ok"] and not r["schema_errors"])
    print(f"{len(rows)} prompts | json parsed {parsed} | schema valid {valid} | wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
