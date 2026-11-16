#!/usr/bin/env python3
"""Run the 16 manual probes from the task spec and store raw responses.

    python manual_test.py --model Qwen/Qwen2.5-1.5B-Instruct --adapter flouna-lora-v5-run1 \
        --out results/v5_manual_raw.json

Responses are stored exactly as generated; nothing is edited.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import flouna_schema as fs

PROMPTS = [
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


def system_prompt() -> str:
    return json.loads((HERE / "train_mlx_v5.jsonl").read_text().splitlines()[0])["messages"][0]["content"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct")
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--max-tokens", type=int, default=512)
    args = ap.parse_args()

    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(args.model, adapter_path=args.adapter)
    sampler = make_sampler(temp=0.0)
    system = system_prompt()
    rows = []
    for prompt in PROMPTS:
        chat = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
        ids = tokenizer.apply_chat_template(chat, add_generation_prompt=True)
        started = time.perf_counter()
        raw = generate(model, tokenizer, prompt=ids, max_tokens=args.max_tokens,
                       sampler=sampler, verbose=False)
        ms = round((time.perf_counter() - started) * 1000, 1)
        obj, err = fs.parse_json_response(raw)
        rows.append({
            "prompt": prompt,
            "raw": raw,
            "ms": ms,
            "parse_ok": obj is not None,
            "parse_error": err,
            "schema_errors": fs.validate_intent(obj) if isinstance(obj, dict) else ["not an object"],
            "conflicts": fs.label_conflicts(prompt, obj) if isinstance(obj, dict) else [],
        })
        print(f"{prompt}\n  -> {raw.strip()}\n")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
