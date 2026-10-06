"""Evaluate Flouna intent model accuracy.

Usage:
  python eval.py                          # eval against eval.jsonl using Ollama
  python eval.py --file eval.jsonl        # specify eval file
  python eval.py --rules-only             # test regex fallback only (no LLM)
  python eval.py --model qwen2.5:0.5b     # test base model before fine-tuning

Metrics:
  - domain accuracy (food/ride/shop/combo/greeting/out_of_scope)
  - priority accuracy (price/rating/speed/balanced)
  - budget accuracy (null vs value, value within 10% tolerance)
  - dietary accuracy (veg/nonveg/any)
  - vehicle accuracy (bike/auto/cab/any)
  - overall field-level accuracy
"""
import argparse
import json
import os
import sys
import urllib.request
from collections import defaultdict

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")


def parse_rules(text: str) -> dict:
    """Minimal regex parser matching the Node.js demo fallback."""
    import re
    t = text.lower()

    ride_words = r"\b(ride|cab|taxi|auto|bike|drop|airport|station|uber|ola|rapido|go to|take me|book a|jana)\b"
    food_words = r"\b(food|eat|order|hungry|pizza|biryani|burger|dosa|thali|swiggy|zomato|dinner|lunch|breakfast|chahiye|craving)\b"
    shop_words = r"\b(buy|purchase|laptop|shoes|earbuds|smartwatch|phone|speaker|jeans|shirt|kurta|khareed|shopping)\b"
    greet_words = r"\b(hi|hello|hey|namaste|thanks|thank you|help|start|what can you do)\b"

    has_ride = bool(re.search(ride_words, t))
    has_food = bool(re.search(food_words, t))
    has_shop = bool(re.search(shop_words, t))
    has_greet = bool(re.search(greet_words, t)) and not has_food and not has_ride and not has_shop

    if has_greet:
        return {"domain": "greeting"}
    if has_food and has_ride:
        return {"domain": "combo"}
    if has_shop:
        return {"domain": "shop"}
    if has_ride and not has_food:
        return {"domain": "ride"}
    if has_food:
        return {"domain": "food"}

    if re.search(r"\b(cheapest?|budget|sasta|lowest|save)\b", t):
        priority = "price"
    elif re.search(r"\b(fast|fastest|quick|urgent|asap|jaldi|hurry)\b", t):
        priority = "speed"
    elif re.search(r"\b(best|top|rated|good|quality|accha)\b", t):
        priority = "rating"
    else:
        priority = "balanced"

    return {"domain": "out_of_scope"}


def query_ollama(text: str, model: str, system: str) -> dict | None:
    body = json.dumps({
        "model": model, "system": system, "prompt": text,
        "format": "json", "stream": False,
        "options": {"temperature": 0},
    }).encode()
    try:
        req = urllib.request.Request(OLLAMA_URL, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = json.loads(r.read())["response"]
            return json.loads(raw)
    except Exception as e:
        return None


def compare(expected: dict, actual: dict) -> dict:
    """Compare expected vs actual output, return per-field results."""
    results = {}

    results["domain"] = expected.get("domain") == actual.get("domain")

    for key in ["food", "ride", "shop"]:
        exp_obj = expected.get(key)
        act_obj = actual.get(key)
        if exp_obj is None:
            continue

        if act_obj is None:
            for field in exp_obj:
                results[f"{key}.{field}"] = False
            continue

        for field, exp_val in exp_obj.items():
            act_val = act_obj.get(field)

            if field == "budgetPaise":
                if exp_val is None:
                    results[f"{key}.{field}"] = act_val is None
                elif act_val is None:
                    results[f"{key}.{field}"] = False
                else:
                    tolerance = abs(exp_val) * 0.1 if exp_val else 0
                    results[f"{key}.{field}"] = abs(exp_val - (act_val or 0)) <= tolerance
            elif field == "item":
                results[f"{key}.{field}"] = (
                    str(exp_val).lower().strip() in str(act_val).lower().strip()
                    or str(act_val).lower().strip() in str(exp_val).lower().strip()
                )
            elif field == "drop":
                results[f"{key}.{field}"] = (
                    str(exp_val).lower().strip() in str(act_val).lower().strip()
                    or str(act_val).lower().strip() in str(exp_val).lower().strip()
                )
            else:
                results[f"{key}.{field}"] = exp_val == act_val

    return results


def run_eval(eval_file: str, model: str | None, rules_only: bool):
    with open(eval_file) as f:
        rows = [json.loads(line) for line in f]

    system_prompt = rows[0]["messages"][0]["content"] if rows else ""
    total = len(rows)
    field_correct = defaultdict(int)
    field_total = defaultdict(int)
    errors = []
    parse_failures = 0

    for i, row in enumerate(rows):
        user_text = row["messages"][1]["content"]
        expected = json.loads(row["messages"][2]["content"])

        if rules_only:
            actual = parse_rules(user_text)
        else:
            actual = query_ollama(user_text, model, system_prompt)
            if actual is None:
                parse_failures += 1
                continue

        results = compare(expected, actual)
        for field, correct in results.items():
            field_total[field] += 1
            if correct:
                field_correct[field] += 1
            elif len(errors) < 20:
                parts = field.split(".")
                if len(parts) == 2:
                    exp_val = expected.get(parts[0], {})
                    exp_val = exp_val.get(parts[1]) if isinstance(exp_val, dict) else exp_val
                    act_val = actual.get(parts[0], {})
                    act_val = act_val.get(parts[1]) if isinstance(act_val, dict) else act_val
                else:
                    exp_val = expected.get(field)
                    act_val = actual.get(field)
                errors.append({
                    "input": user_text,
                    "field": field,
                    "expected": str(exp_val),
                    "got": str(act_val),
                })

        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{total}...", file=sys.stderr)

    print(f"\n{'='*60}")
    print(f"Evaluation: {eval_file} ({total} examples)")
    print(f"Mode: {'rules-only' if rules_only else f'Ollama model={model}'}")
    if parse_failures:
        print(f"Parse failures: {parse_failures}/{total}")
    print(f"{'='*60}\n")

    print(f"{'Field':<25} {'Correct':>8} {'Total':>8} {'Accuracy':>10}")
    print(f"{'-'*25} {'-'*8} {'-'*8} {'-'*10}")

    overall_correct = 0
    overall_total = 0
    for field in sorted(field_total.keys()):
        c = field_correct[field]
        t = field_total[field]
        pct = c / t * 100 if t else 0
        print(f"{field:<25} {c:>8} {t:>8} {pct:>9.1f}%")
        overall_correct += c
        overall_total += t

    if overall_total:
        print(f"\n{'OVERALL':<25} {overall_correct:>8} {overall_total:>8} {overall_correct/overall_total*100:>9.1f}%")

    if errors:
        print(f"\nFirst {len(errors)} errors:")
        for e in errors[:10]:
            print(f"  [{e['field']}] \"{e['input'][:60]}\" → expected={e['expected']}, got={e['got']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate Flouna intent model")
    parser.add_argument("--file", default="eval.jsonl", help="Eval dataset file")
    parser.add_argument("--model", default="flouna", help="Ollama model name")
    parser.add_argument("--rules-only", action="store_true", help="Test regex fallback only")
    args = parser.parse_args()

    run_eval(args.file, args.model, args.rules_only)
