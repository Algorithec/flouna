#!/usr/bin/env python3
"""Build a weighted training mix for V5 run 2 from the validated V5 corpus.

Run 1 trains on the corpus as-is. If evaluation shows that a minority behaviour
is still under-learned (out_of_scope, greetings, explicit dietary, canonical
price/speed priority), run 2 uses this mix: the same unique examples, with the
weak slices repeated in the sampling distribution. No new synthetic rows are
created, and the canonical train/valid/holdout files are not modified.

    python build_v5_mix.py --out /tmp/flouna_v5_mix
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRICE_CUES = ("cheap", "affordable", "budget", "inexpensive", "low cost", "lowest price",
              "save money", "sasta", "takkuva")
SPEED_CUES = ("fast", "quick", "asap", "jaldi", "urgent", "don't want to wait",
              "dont want to wait", "minimum wait", "quick delivery", "fastest")

WEIGHTS = {
    "out_of_scope": 6,
    "greeting": 4,
    "nonveg": 2,
    "price": 2,
    "speed": 2,
    "combo": 2,
}


def weight(text: str, out: dict) -> int:
    domain = out.get("domain")
    w = 1
    if domain == "out_of_scope":
        return WEIGHTS["out_of_scope"]
    if domain == "greeting":
        return WEIGHTS["greeting"]
    if domain == "combo":
        w = max(w, WEIGHTS["combo"])
    part = out.get("food") or out.get("ride") or out.get("shop") or {}
    if (out.get("food") or {}).get("dietary") == "nonveg":
        w = max(w, WEIGHTS["nonveg"])
    priority = part.get("priority")
    low = text.lower()
    if priority == "price" and any(c in low for c in PRICE_CUES):
        w = max(w, WEIGHTS["price"])
    if priority == "speed" and any(c in low for c in SPEED_CUES):
        w = max(w, WEIGHTS["speed"])
    return w


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=Path, default=HERE / "train_mlx_v5.jsonl")
    ap.add_argument("--valid", type=Path, default=HERE / "valid_mlx_v5.jsonl")
    ap.add_argument("--out", type=Path, default=Path("/tmp/flouna_v5_mix"))
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rows = [json.loads(line) for line in args.train.read_text(encoding="utf-8").splitlines() if line.strip()]
    weighted: list[dict] = []
    for row in rows:
        text = row["messages"][1]["content"]
        out = json.loads(row["messages"][2]["content"])
        weighted.extend([row] * weight(text, out))
    random.Random(args.seed).shuffle(weighted)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "train.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in weighted) + "\n", encoding="utf-8")
    (args.out / "valid.jsonl").write_text(args.valid.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"unique {len(rows)} -> mix {len(weighted)} rows; valid {len(args.valid.read_text().splitlines())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
