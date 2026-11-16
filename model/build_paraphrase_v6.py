#!/usr/bin/env python3
"""Build a sealed unseen-paraphrase set for V6 generalisation checks.

    python build_paraphrase_v6.py

Every sentence here is hand-written for this set and never appears in the V6
training corpus or the 382-case holdout. Labels are hand-assigned with the
D1-D8 conventions in results/v5_holdout_error_analysis.md, then checked twice:
schema validity plus text/label conflicts, and equality with build_v6's
canonical rules. Any disagreement is a bug in this file, not a label to
smooth over, so the build fails loudly.

The set is small and purposely covers the failure classes the holdout audit
found (priority cues, dish-implied dietary, phantom pickups, vehicles,
categorical items, action vs discovery/OOS) plus a hard-negative slice. It is
never trained on and is reported separately from the fixed benchmark.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import build_v6 as b6
import flouna_schema as fs
import gen_data_v5 as g
import validate_dataset as vd

HERE = Path(__file__).resolve().parent
OUT = HERE / "eval_paraphrase_v6.jsonl"

REPLIES = {
    "food": "Let me find some options for you.",
    "ride": "Let me look for rides near you.",
    "shop": "Let me search for that product.",
    "greeting": "Hi! I can help you order food, book rides, or shop.",
    "out_of_scope": g.OOS_REPLY,
    "action": "On it.",
}


def food(item, dietary, priority="balanced", budget=None, eta=None):
    return {
        "domain": "food",
        "reply": REPLIES["food"],
        "food": {"item": item, "budgetPaise": budget, "maxEtaMinutes": eta,
                 "dietary": dietary, "priority": priority},
    }


def ride(pickup, drop, vehicle, budget=None, wait=None, priority="balanced", schedule=None):
    return {
        "domain": "ride",
        "reply": REPLIES["ride"],
        "ride": {"pickup": pickup, "drop": drop, "vehicle": vehicle,
                 "budgetPaise": budget, "maxPickupMinutes": wait,
                 "priority": priority, "scheduleAt": schedule},
    }


def shop(item, category, priority="balanced", budget=None):
    return {
        "domain": "shop",
        "reply": REPLIES["shop"],
        "shop": {"item": item, "budgetPaise": budget, "category": category,
                 "priority": priority},
    }


def greeting():
    return {"domain": "greeting", "reply": REPLIES["greeting"]}


def oos():
    return {"domain": "out_of_scope", "reply": REPLIES["out_of_scope"]}


def act(kind, **over):
    body = dict(b6.ACTION_DEFAULTS)
    body["kind"] = kind
    body.update(over)
    return {"domain": "action", "reply": REPLIES["action"], "action": body}


def cases() -> list[tuple[str, dict]]:
    rows: list[tuple[str, dict]] = []

    def add(text: str, out: dict) -> None:
        rows.append((text, out))

    # --- food: priority, dietary, item, budget, ETA -------------------------
    add("I want something spicy delivered before midnight", food("something spicy", "any"))
    add("order a paneer tikka, fastest possible", food("paneer tikka", "veg", "speed"))
    add("get me a chicken biryani quickly", food("chicken biryani", "nonveg", "speed"))
    add("I'd like veg momos under 200 rupees", food("veg momos", "veg", budget=20000))
    add("cheap biryani please", food("biryani", "any", "price"))
    add("send dosa in 20 minutes", food("dosa", "veg", "speed", eta=20))
    add("best rated sushi nearby", food("sushi", "any", "rating"))
    add("a good value lunch within 30 minutes", food("lunch", "any", eta=30))
    add("non vegetarian dinner, no budget limit", food("dinner", "nonveg"))
    add("pure veg thali please", food("veg thali", "veg"))
    add("I'm craving pizza tonight", food("pizza", "any"))
    add("low cost idli breakfast", food("idli", "veg", "price"))
    add("something healthy and quick", food("something healthy", "any", "speed"))
    add("mutton biryani, best quality", food("mutton biryani", "nonveg", "rating"))
    add("cheapest veg option available", food("food", "veg", "price"))
    add("show me dessert choices under 250", food("dessert", "any", budget=25000))
    add("I need food fast, don't care about price", food("food", "any", "speed"))
    add("quick bite within 15 mins, anything cheap", food("food", "any", "speed", eta=15))
    add("jaldi se chicken momos bhejo", food("chicken momos", "nonveg", "speed"))
    add("budget lunch under 150", food("lunch", "any", "price", budget=15000))
    add("veg fried rice with no waiting", food("veg fried rice", "veg", "speed"))
    add("top rated biryani, money is no issue", food("biryani", "any", "rating"))
    add("cheapest coffee you have", food("coffee", "veg", "price"))
    add("gulab jamun within half an hour", food("gulab jamun", "veg", "speed", eta=30))
    add("protein rich salad", food("salad", "any"))
    add("medium spicy noodles, asap", food("noodles", "any", "speed"))
    add("family dinner under 800 rupees, highly rated", food("dinner", "any", "rating", budget=80000))
    add("send cake to my office in 45 minutes", food("cake", "veg", "speed", eta=45))
    add("egg roll, cheap and fast", food("egg roll", "nonveg", "speed"))
    add("order rajma chawal, no special preference", food("rajma chawal", "veg"))

    # --- ride: origin, drop, vehicle, wait, schedule, budget ----------------
    add("book an auto from Madhapur to Kukatpally", ride("Madhapur", "Kukatpally", "auto"))
    add("pick me up from the office within 10 minutes and drop me at the airport",
        ride("the office", "the airport", "any", wait=10, priority="speed"))
    add("cheapest auto to Banjara Hills", ride(None, "Banjara Hills", "auto", priority="price"))
    add("fastest cab from Gachibowli to Hitech City",
        ride("Gachibowli", "Hitech City", "cab", priority="speed"))
    add("take me to Secunderabad in a bike taxi", ride(None, "Secunderabad", "bike"))
    add("auto from KPHB to Ameerpet, no rush", ride("KPHB", "Ameerpet", "auto"))
    add("I want a comfortable cab to Jubilee Hills", ride(None, "Jubilee Hills", "cab"))
    add("schedule a cab from home to the airport at 6:30 am",
        ride("home", "the airport", "cab", schedule="06:30"))
    add("book a ride to Charminar under 250", ride(None, "Charminar", "any", budget=25000))
    add("need a rickshaw from Mehdipatnam to Abids right now",
        ride("Mehdipatnam", "Abids", "auto"))
    add("fast cab to the railway station from my home",
        ride("my home", "the railway station", "cab", priority="speed"))
    add("bike from the metro station to the office, jaldi",
        ride("the metro station", "the office", "bike", priority="speed"))
    add("lowest price cab from LB Nagar to Secunderabad",
        ride("LB Nagar", "Secunderabad", "cab", priority="price"))
    add("hurry, I need an auto to the hospital", ride(None, "the hospital", "auto", priority="speed"))
    add("cab from Begumpet to Shamshabad airport, leave at 5 pm",
        ride("Begumpet", "Shamshabad airport", "cab", schedule="17:00"))
    add("book a car to Gachibowli, driver should reach in 8 minutes",
        ride(None, "Gachibowli", "cab", wait=8, priority="speed"))
    add("from Nampally to Kukatpally, cheapest possible",
        ride("Nampally", "Kukatpally", "any", priority="price"))
    add("I don't want a long wait, send a cab to Hitech City",
        ride(None, "Hitech City", "cab", priority="speed"))
    add("auto rickshaw to Golconda Fort, top rated drivers",
        ride(None, "Golconda Fort", "auto", priority="rating"))
    add("need a ride home from the office", ride("the office", "home", "any"))
    add("quick bike to the mall from the hostel",
        ride("the hostel", "the mall", "bike", priority="speed"))
    add("book a cab for 6:45 pm from the airport to Banjara Hills",
        ride("the airport", "Banjara Hills", "cab", schedule="18:45"))
    add("cab to the airport, pickup at Madhapur, 12 minutes max wait",
        ride("Madhapur", "the airport", "cab", wait=12, priority="speed"))
    add("cheap ride from Ameerpet to SR Nagar", ride("Ameerpet", "SR Nagar", "any", priority="price"))
    add("I need an auto, reach me in 5 minutes, to go to the station",
        ride(None, "the station", "auto", wait=5, priority="speed"))
    add("ride from the gym to my apartment, no special preference",
        ride("the gym", "my apartment", "any"))
    add("get me a cab to the airport, money is not a concern", ride(None, "the airport", "cab"))
    add("fastest ride to the airport from Secunderabad",
        ride("Secunderabad", "the airport", "any", priority="speed"))

    # --- shop: category map, priority, budget -------------------------------
    add("cheap running shoes under 2000", shop("running shoes", "fashion", "price", 200000))
    add("best rated wireless earbuds under ₹3000",
        shop("wireless earbuds", "electronics", "rating", 300000))
    add("I need an office chair, low cost", shop("office chair", "home", "price"))
    add("top rated air fryer below 8000 rupees", shop("air fryer", "appliances", "rating", 800000))
    add("buy a kurta under 1200", shop("kurta", "fashion", budget=120000))
    add("cheap refrigerator", shop("refrigerator", "appliances", "price"))
    add("show me a decent backpack under 1500", shop("backpack", "fashion", budget=150000))
    add("best quality gaming laptop, budget 70000",
        shop("gaming laptop", "electronics", "rating", 7000000))
    add("wallet under 500, quick", shop("wallet", "fashion", "speed", 50000))
    add("washing machine, no special preference", shop("washing machine", "appliances"))
    add("saree for 2500 rupees", shop("saree", "fashion", budget=250000))
    add("fast delivery on headphones under 2000",
        shop("headphones", "electronics", "speed", 200000))

    # --- action positives ---------------------------------------------------
    add("add two garlic naans to the cart",
        act("cart.add", targetBy="name", targetName="garlic naan", qty=2))
    add("remove the last thing I added", act("cart.remove", targetBy="last"))
    add("remove option 2 from my cart", act("cart.remove", targetBy="position", targetPosition=2))
    add("set the qty of the third item to four",
        act("cart.set_qty", targetBy="position", targetPosition=3, qty=4))
    add("add the last item again", act("cart.add", targetBy="last", qty=1))
    add("clear my basket", act("cart.clear"))
    add("start a group order for 5 people, include what's in my cart",
        act("group.create", members=5, withMyItems=True))
    add("show me the group order", act("group.show"))
    add("take the cheapest option", act("select", pick="cheapest"))
    add("go ahead and book the ride I chose", act("ride.book"))
    add("get rides for 3 of us", act("ride.group", members=3))
    add("make the group ride use only my selections", act("ride.group_mode", value="mine"))
    add("enable email tips for me", act("settings.toggle", setting="emailTips", on=True))
    add("set weekly budget to 4000", act("settings.budget", weeklyRupees=4000))
    add("set my profile visibility to nobody", act("settings.visibility", value="nobody"))
    add("change the app language to Tamil", act("settings.language", value="ta"))
    add("open the security page", act("navigate", value="security"))
    add("use light theme", act("settings.theme", value="light"))

    # --- hard negatives: discovery, information, decision -------------------
    add("how can I empty my cart", greeting())
    add("how do I change my weekly budget", greeting())
    add("where do I see my past orders", greeting())
    add("I need a cab to the airport", ride(None, "the airport", "cab"))
    add("order two pizzas", food("pizza", "any"))
    add("did my cart empty", oos())
    add("never mind, cancel it", oos())
    add("maybe I'll check out later", oos())
    add("should I order now or later", oos())
    add("if I book a cab, can I cancel it later", oos())

    # --- chit-chat ----------------------------------------------------------
    add("hello there, good morning", greeting())
    add("thanks, that's all", greeting())
    add("can you tell me a joke", oos())
    add("what's the weather in Hyderabad", oos())
    add("remind me to call mom at 6", oos())
    return rows


def load_texts(path: Path) -> list[str]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if "messages" in row:
            rows.append(row["messages"][1]["content"])
        elif "message" in row:
            rows.append(row["message"])
    return rows


def main() -> int:
    rows = cases()
    problems: list[str] = []
    changed: list[str] = []

    for text, out in rows:
        errors = fs.validate_intent(out)
        if out["domain"] == "action":
            errors += fs.validate_action_semantics(out["action"])
        else:
            errors += fs.label_conflicts(text, out)
        if errors:
            problems.append(f"{text!r}: {errors}")
        canonical = b6.canonical_row(text, out)
        if canonical is None:
            problems.append(f"{text!r}: canonical_row rejected the label")
        elif canonical != out:
            changed.append(f"{text!r}:\n  hand      {out}\n  canonical {canonical}")

    seen: dict[str, str] = {}
    for text, _ in rows:
        key = vd.norm_text(text)
        if key in seen:
            problems.append(f"duplicate paraphrase: {text!r} == {seen[key]!r}")
        seen[key] = text

    leaks = 0
    for name, path in (
        ("train_v6", HERE / "train_mlx_v6.jsonl"),
        ("valid_v6", HERE / "valid_mlx_v6.jsonl"),
        ("holdout", HERE / "eval_mlx_v5.jsonl"),
        ("action_eval", HERE / "eval_action_v6.jsonl"),
        ("train_v5", HERE / "train_mlx_v5.jsonl"),
    ):
        known = {vd.norm_text(t) for t in load_texts(path)}
        hits = [text for text, _ in rows if vd.norm_text(text) in known]
        leaks += len(hits)
        if hits:
            problems.append(f"exact overlap with {name}: {hits}")

    near = 0
    for name, path in (("train_v6", HERE / "train_mlx_v6.jsonl"),
                       ("holdout", HERE / "eval_mlx_v5.jsonl")):
        known = [(t, {}) for t in load_texts(path)]
        combos = known + [(text, {}) for text, _ in rows]
        for a, b, score in vd.near_pairs(combos):
            if a < len(known) <= b and score >= 0.9:
                near += 1
                if score >= 0.95:
                    problems.append(
                        f"near-duplicate of {name} ({score:.2f}): {known[a][0]!r} ~ {combos[b][0]!r}")

    print(f"paraphrase cases: {len(rows)}")
    if problems:
        print("PROBLEMS")
        for p in problems:
            print(" ", p)
    if changed:
        print("hand label vs canonical rule differences")
        for c in changed:
            print(" ", c)
    print(f"exact overlaps: {leaks}   near duplicates >= 0.90: {near}")
    if problems or changed:
        return 1

    system = b6.TRAIN_SYSTEM
    lines = []
    for text, out in rows:
        lines.append(json.dumps({
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": text},
                {"role": "assistant", "content": json.dumps(out, ensure_ascii=False)},
            ]
        }, ensure_ascii=False))
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    counts: dict[str, int] = {}
    for _, out in rows:
        counts[out["domain"]] = counts.get(out["domain"], 0) + 1
    print(f"domains: {dict(sorted(counts.items()))}")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
