#!/usr/bin/env python3
"""Build the V5 run-2 targeted curriculum.

Run 1 (400 steps on the unweighted V5 corpus) fixed the five known failures but
still misses:
  - greeting/meta paraphrases (5 of 12 held-out greetings became out_of_scope)
  - dish-implied dietary (veg dishes such as jalebi/coffee/margherita -> any)
  - Hindi/Telugu speed and rating cues
  - delivery-deadline-only requests (holdout labels those priority speed)
  - some shop priority and named-pickup cases

This script does not touch train_mlx_v5.jsonl, the valid split or the holdout.
It appends hand-written, non-duplicate examples for those slices and assembles
one duplicate-free curriculum (~865 rows). 400 steps at batch 4 is ~1.9 passes,
so every targeted row gets several gradient updates without oversampling copies.

    python build_v5_run2.py --out /tmp/flouna_v5_run2
"""
from __future__ import annotations

import argparse
import json
import random
import re
from collections import defaultdict
from pathlib import Path

from gen_data_v5 import TRAIN_SYSTEM

HERE = Path(__file__).resolve().parent
OOS_REPLY = "I can help you order food, book rides, or shop. What would you like?"


def food(item, dietary="any", priority="balanced", budget=None, eta=None):
    return {"item": item, "budgetPaise": budget, "maxEtaMinutes": eta,
            "dietary": dietary, "priority": priority}


def ride(drop, pickup=None, vehicle="any", budget=None, wait=None,
         priority="balanced", schedule=None):
    return {"pickup": pickup, "drop": drop, "vehicle": vehicle, "budgetPaise": budget,
            "maxPickupMinutes": wait, "priority": priority, "scheduleAt": schedule}


def shop(item, category="any", priority="balanced", budget=None):
    return {"item": item, "budgetPaise": budget, "category": category, "priority": priority}


def out(domain, reply, **parts):
    row = {"domain": domain, "reply": reply}
    row.update(parts)
    return row


GREETING_REPLIES = [
    "Hi! I can help you order food, book rides, or shop.",
    "Hello! Tell me what you need and I will find it.",
    "Hey there! Food, a ride, or shopping, what can I do?",
    "Hi, good to see you. What are you looking for today?",
    "Hello! I am here to help with food, rides, and shopping.",
]

GREETINGS = [
    "hey flouna, how are you doing", "good morning", "good night",
    "thanks for your help", "thank you, appreciate it", "tell me about flouna",
    "how does flouna work", "what does this app do", "what can you help me with",
    "can you help me with something", "are you human", "are you an ai",
    "what are you", "do you have a name", "pleased to meet you",
    "hello, just saying hi", "hey there, how is it going", "morning", "evening",
    "hi flouna", "hello again", "thanks a ton", "that was helpful, thanks",
    "good to know, thank you", "this is great", "the app looks nice",
    "how do i use flouna", "what features do you have", "who made flouna",
    "what is the app used for", "do you work in hindi", "can you speak telugu",
    "are you there", "you still there", "ok thanks", "great, thanks", "bye",
    "see you", "good luck",
]

OOS_TEXTS = [
    "below 300", "around 200 rupees", "what is 2 plus 2", "define photosynthesis",
    "who wrote hamlet", "what is the score of the match", "tell me a story",
    "play some music", "set an alarm for 7", "book a movie ticket",
    "what time is it", "how tall is mount everest", "how do i cook pasta",
    "write an email for me", "what is python programming", "ok", "hmm",
    "maybe later", "what is the capital of australia",
    "who is the prime minister of india", "explain black holes",
    "translate good morning to french",
]

VEG_DISHES = [
    "fresh jalebi", "i want hot jalebi", "order jalebi for dessert",
    "pav bhaji", "extra butter pav bhaji", "pav bhaji for dinner",
    "margherita pizza", "large margherita", "margherita with extra cheese",
    "filter coffee", "cold coffee", "hot coffee in the morning",
    "chocolate milkshake", "mango milkshake", "a cold milkshake",
    "gulab jamun", "warm gulab jamun", "gulab jamun for dessert",
    "khandvi", "fresh khandvi", "a khandvi plate", "paneer tikka",
    "paneer tikka platter", "veg biryani", "veg biryani for dinner",
    "dal fry", "dal fry with rice", "green salad", "a fresh salad",
    "thepla", "thepla with curd", "poha", "hot poha", "idli", "idli sambar",
    "masala dosa", "crispy masala dosa", "chole bhature", "rajma chawal",
    "veg burger", "veg momos", "aloo tikki", "veg sandwich",
    "paneer butter masala", "veg thali",
]

NONVEG_DISHES = [
    "butter chicken", "butter chicken with naan", "chicken biryani",
    "chicken biryani for dinner", "mutton rogan josh", "mutton rogan josh plate",
    "fish curry", "fish curry with rice", "egg roll", "egg roll from the stall",
    "prawn curry", "chicken noodles", "tandoori chicken", "chicken shawarma",
    "chicken shawarma roll", "chicken tikka", "keema", "chicken momos",
    "chicken burger", "grilled fish", "mutton curry", "chicken lollipop",
]

SPEED_FOODS = [
    ("fatafat momos chahiye", "momos", "any"),
    ("turant chai", "chai", "veg"),
    ("jaldi jalebi chahiye", "jalebi", "veg"),
    ("tondaraga dosa kavali", "dosa", "veg"),
    ("jhatpat poha chahiye", "poha", "veg"),
    ("quick biryani please", "biryani", "any"),
    ("i need my food fast", "food", "any"),
    ("fastest chai delivery", "chai", "veg"),
    ("deliver pizza quickly", "pizza", "any"),
    ("urgent coffee", "coffee", "veg"),
    ("get me lunch asap", "lunch", "any"),
    ("quick shake", "milkshake", "veg"),
    ("jaldi wala burger", "burger", "any"),
    ("asap burger", "burger", "any"),
    ("fast delivery of samosa", "samosa", "veg"),
    ("need dosa urgently", "dosa", "veg"),
    ("chicken biryani jaldi", "biryani", "nonveg"),
    ("quick paneer tikka", "paneer tikka", "veg"),
    ("fatafat chai", "chai", "veg"),
    ("turant thali", "thali", "veg"),
    ("i am hungry, get food quickly", "food", "any"),
    ("quick lunch delivery", "lunch", "any"),
]

RATING_FOODS = [
    ("best biryani", "biryani", "any"),
    ("top rated pizza", "pizza", "any"),
    ("manchi dosa kavali", "dosa", "veg"),
    ("highest rated butter chicken", "butter chicken", "nonveg"),
    ("popular momo place", "momos", "any"),
    ("best filter coffee", "coffee", "veg"),
    ("top rated pav bhaji", "pav bhaji", "veg"),
    ("manchi biryani kavali", "biryani", "any"),
    ("best gulab jamun", "gulab jamun", "veg"),
    ("highest rated veg thali", "thali", "veg"),
    ("popular chicken shawarma", "shawarma", "nonveg"),
    ("best masala dosa", "dosa", "veg"),
]

PRICE_FOODS = [
    ("sasta lunch", "lunch", "any"),
    ("takkuva biryani", "biryani", "any"),
    ("cheap veg thali", "thali", "veg"),
    ("affordable dosa", "dosa", "veg"),
    ("low cost dinner", "dinner", "any"),
    ("save money on dinner", "dinner", "any"),
    ("budget friendly breakfast", "breakfast", "any"),
    ("cheapest coffee", "coffee", "veg"),
    ("inexpensive paneer tikka", "paneer tikka", "veg"),
    ("sasta chicken biryani", "biryani", "nonveg"),
    ("cheap momos", "momos", "any"),
    ("don't want to spend much on food", "food", "any"),
]

ETA_FOODS = [
    ("deliver my burger within 25 minutes", "burger", "any"),
    ("pizza in 30 minutes or less", "pizza", "any"),
    ("coffee no later than 20 minutes", "coffee", "veg"),
    ("get me dal fry inside 40 minutes", "dal fry", "veg"),
    ("shawarma in 15 minutes", "shawarma", "nonveg"),
    ("momos in 30 minutes", "momos", "any"),
    ("noodles within 45 minutes", "noodles", "any"),
    ("salad delivered in 20 minutes", "salad", "veg"),
    ("biryani within 35 minutes", "biryani", "any"),
    ("gulab jamun in 25 minutes", "gulab jamun", "veg"),
    ("order chai, need it in 10 minutes", "chai", "veg"),
    ("paneer tikka within 30 mins", "paneer tikka", "veg"),
    ("butter chicken in 50 minutes", "butter chicken", "nonveg"),
    ("pav bhaji delivered in 20 mins", "pav bhaji", "veg"),
    ("milkshake within 15 minutes", "milkshake", "veg"),
    ("egg roll in 25 minutes", "egg roll", "nonveg"),
    ("dosa delivered in 30 mins", "dosa", "veg"),
    ("chicken noodles in 40 minutes", "chicken noodles", "nonveg"),
    ("sandwich inside 20 minutes", "sandwich", "any"),
    ("jalebi within 30 minutes", "jalebi", "veg"),
]

SHOPS = [
    ("gaming laptop under 70000", "laptop", "electronics", "balanced", 7000000),
    ("running shoes under 3000", "running shoes", "fashion", "balanced", 300000),
    ("best bluetooth speaker", "bluetooth speaker", "electronics", "rating", None),
    ("cheapest washing machine", "washing machine", "appliances", "price", None),
    ("buy a wallet", "wallet", "fashion", "balanced", None),
    ("quick delivery of a phone charger", "phone charger", "electronics", "speed", None),
    ("top rated jeans", "jeans", "fashion", "rating", None),
    ("home decor under 2000", "home decor", "home", "balanced", 200000),
    ("buy a mixer grinder", "mixer grinder", "appliances", "balanced", None),
    ("cheapest refrigerator", "refrigerator", "appliances", "price", None),
    ("best running shoes", "running shoes", "fashion", "rating", None),
    ("kids shoes under 1500", "kids shoes", "fashion", "balanced", 150000),
    ("earbuds under 2000", "earbuds", "electronics", "balanced", 200000),
    ("fast delivery face wash", "face wash", "any", "speed", None),
    ("buy a chair under 5000", "chair", "home", "balanced", 500000),
    ("top rated headphones", "headphones", "electronics", "rating", None),
    ("affordable headphones", "headphones", "electronics", "price", None),
    ("quick delivery of a power bank", "power bank", "electronics", "speed", None),
]

RIDES = [
    ("pick me up from Banjara Hills in 6 minutes, drop at Hitech City",
     "Hitech City", "Banjara Hills", "any", None, 6, "balanced", None),
    ("auto from Kothapet to Abids at 9pm",
     "Abids", "Kothapet", "auto", None, None, "balanced", "21:00"),
    ("cab from the market to the airport",
     "the airport", "the market", "cab", None, None, "balanced", None),
    ("bike from Somajiguda to Uppal",
     "Uppal", "Somajiguda", "bike", None, None, "balanced", None),
    ("pickup within 5 minutes from Nizampet to Gachibowli",
     "Gachibowli", "Nizampet", "any", None, 5, "balanced", None),
    ("need a cab from Electronic City to the mall",
     "the mall", "Electronic City", "cab", None, None, "balanced", None),
    ("auto from home to Lingampally, don't want to wait more than 4 minutes",
     "Lingampally", "home", "auto", None, 4, "balanced", None),
    ("cheapest cab to Secunderabad",
     "Secunderabad", None, "cab", None, None, "price", None),
    ("fastest auto to Charminar",
     "Charminar", None, "auto", None, None, "speed", None),
    ("best rated cab to Jubilee Hills",
     "Jubilee Hills", None, "cab", None, None, "rating", None),
    ("bike to the railway station under 100",
     "the railway station", None, "bike", 10000, None, "balanced", None),
    ("cab to the office at 8:30am",
     "the office", None, "cab", None, None, "balanced", "08:30"),
    ("pickup from Abids in 5 minutes for a 7pm stadium drop",
     "the stadium", "Abids", "any", None, 5, "balanced", "19:00"),
    ("auto to Dilsukhnagar on a budget",
     "Dilsukhnagar", None, "auto", None, None, "price", None),
    ("any ride to the hospital, pickup in 10 minutes",
     "the hospital", None, "any", None, 10, "balanced", None),
    ("cab from the hotel to the station, pickup within 8 minutes",
     "the station", "the hotel", "cab", None, 8, "balanced", None),
    ("sasta auto to the market",
     "the market", None, "auto", None, None, "price", None),
    ("fast cab to the airport",
     "the airport", None, "cab", None, None, "speed", None),
]

MOODS = [
    ("something healthy for lunch", "healthy"),
    ("a light dinner", "light"),
    ("something spicy", "spicy"),
    ("something sweet", "sweet"),
    ("comfort food", "comfort food"),
    ("a filling breakfast", "filling"),
    ("cheesy snack", "cheesy"),
    ("something light and healthy", "light"),
    ("craving dessert", "dessert"),
    ("hungry, want something tasty", "tasty"),
]


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", text.lower())).strip()


def rows_from(extras, seen):
    rows = []
    for text, output in extras:
        key = norm(text)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"messages": [
            {"role": "system", "content": TRAIN_SYSTEM},
            {"role": "user", "content": text},
            {"role": "assistant", "content": json.dumps(output, ensure_ascii=False)},
        ]})
    return rows


def extras():
    items = []
    for i, text in enumerate(GREETINGS):
        items.append((text, out("greeting", GREETING_REPLIES[i % len(GREETING_REPLIES)])))
    for text in OOS_TEXTS:
        items.append((text, out("out_of_scope", OOS_REPLY)))
    for text in VEG_DISHES:
        items.append((text, out("food", "Let me find that for you.", food=food(text, "veg"))))
    for text in NONVEG_DISHES:
        items.append((text, out("food", "Let me pull up some options.", food=food(text, "nonveg"))))
    for text, item, diet in SPEED_FOODS:
        items.append((text, out("food", "On it, finding the quickest option.", food=food(item, diet, "speed"))))
    for text, item, diet in RATING_FOODS:
        items.append((text, out("food", "Let me find the top rated option.", food=food(item, diet, "rating"))))
    for text, item, diet in PRICE_FOODS:
        items.append((text, out("food", "Let me compare the lowest prices.", food=food(item, diet, "price"))))
    for text, item, diet in ETA_FOODS:
        eta = int(re.search(r"(\d+)\s*(?:minutes|mins)", text).group(1))
        items.append((text, out("food", "I will keep the delivery time in mind.",
                                food=food(item, diet, "speed", eta=eta))))
    for text, item, category, priority, budget in SHOPS:
        items.append((text, out("shop", "Let me look that up.", shop=shop(item, category, priority, budget))))
    for text, drop, pickup, vehicle, budget, wait, priority, schedule in RIDES:
        items.append((text, out("ride", "On it, comparing ride options.", ride=ride(
            drop, pickup, vehicle, budget, wait, priority, schedule))))
    for text, item in MOODS:
        items.append((text, out("food", "Let me find something for you.", food=food(item))))
    return items


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("/tmp/flouna_v5_run2"))
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    base = [json.loads(line) for line in (HERE / "train_mlx_v5.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    seen = set()
    for path in (HERE / "train_mlx_v5.jsonl", HERE / "valid_mlx_v5.jsonl",
                 HERE / "eval_mlx_v5.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                seen.add(norm(json.loads(line)["messages"][1]["content"]))
    for name in ("intent-eval.jsonl", "intent-eval-holdout.jsonl"):
        for line in (HERE.parent / "server/test/fixtures" / name).read_text(encoding="utf-8").splitlines():
            if line.strip():
                seen.add(norm(json.loads(line)["message"]))

    extra_rows = rows_from(extras(), seen)

    buckets = defaultdict(list)
    for row in base:
        text = row["messages"][1]["content"]
        output = json.loads(row["messages"][2]["content"])
        buckets[output["domain"]].append(row)
    rng = random.Random(args.seed)
    for rows in buckets.values():
        rng.shuffle(rows)

    curriculum = []
    curriculum += extra_rows
    curriculum += buckets["out_of_scope"][: 75]
    curriculum += buckets["greeting"][: 32]
    for domain, count in (("food", 250), ("ride", 200), ("shop", 60), ("combo", 40)):
        curriculum += buckets[domain][:count]
    curriculum = list({norm(r["messages"][1]["content"]): r for r in curriculum}.values())
    rng.shuffle(curriculum)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "train.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in curriculum) + "\n", encoding="utf-8")
    (args.out / "valid.jsonl").write_text(
        (HERE / "valid_mlx_v5.jsonl").read_text(encoding="utf-8"), encoding="utf-8")
    print(f"extras {len(extra_rows)} unique; curriculum {len(curriculum)} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
