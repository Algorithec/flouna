#!/usr/bin/env python3
"""Build the V6 corpus, validation split, targeted curriculum and action eval.

    python build_v6.py --data-dir /tmp/flouna_v6_data --curriculum-dir /tmp/flouna_v6_run2

What it does, in order:
  1. Canonicalises every V5 training row against the label audit in
     results/v5_holdout_error_analysis.md. Original files are only read.
  2. Adds targeted rows for the failure modes the audit found: ride origins
     and waits, unspecified vehicles, combo dietary, dish-implied dietary,
     priority cues in three languages and three casings, item precedence,
     shop categories, short requests and app small talk.
  3. Adds the action domain (all 18 kinds, every value set) and hard negatives
     where the user expresses intent but does not authorise an action.
  4. Writes a sealed action eval set that is never trained on.
  5. Checks duplicates, leakage into the sealed holdout and fixtures, schema
     validity, action semantics and label consistency, and writes
     results/v6_dataset_quality.md.

Inputs are never written: train_mlx_v5.jsonl, valid_mlx_v5.jsonl,
eval_mlx_v5.jsonl and the server fixtures stay byte-identical.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import flouna_schema as fs
import gen_data_v5 as g

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TRAIN_V5 = HERE / "train_mlx_v5.jsonl"
VALID_V5 = HERE / "valid_mlx_v5.jsonl"
HOLDOUT = HERE / "eval_mlx_v5.jsonl"
FIXTURES = [
    ROOT / "server/test/fixtures/intent-eval.jsonl",
    ROOT / "server/test/fixtures/intent-eval-holdout.jsonl",
]
ACTION_EVAL = HERE / "eval_action_v6.jsonl"
TRAIN_OUT = HERE / "train_mlx_v6.jsonl"
VALID_OUT = HERE / "valid_mlx_v6.jsonl"
REPORT_OUT = HERE / "results/v6_dataset_quality.md"

OOS_REPLY = g.OOS_REPLY

ACTION_RULES = (
    "action: the user tells the app to DO something with what it already has, not find something new: "
    "add, remove or change items in the cart, check out, start or show a group order, choose one of the options just shown, "
    "book the rides already chosen, arrange rides for several people, change a setting, or open a screen. "
    "Never use action for yes, no or cancel. Ordering food, booking a ride or buying a product is discovery, not action. "
    'Output action: {"kind":"cart.add"|"cart.remove"|"cart.set_qty"|"cart.show"|"cart.clear"|"checkout"|"group.create"|"group.show"|'
    '"select"|"ride.book"|"ride.group"|"ride.group_mode"|"settings.toggle"|"settings.visibility"|"settings.budget"|'
    '"settings.language"|"settings.theme"|"navigate","targetBy":"last"|"position"|"name"|"none","targetPosition":number,'
    '"targetName":string,"qty":number,"members":number,"withMyItems":true|false,"pick":"cheapest"|"fastest"|"none",'
    '"setting":"emailUpdates"|"smartSuggestions"|"emailMoneyUpdates"|"emailTips"|"shareLocation"|"activityStatus"|"none",'
    '"on":true|false,"value":string,"weeklyRupees":number}. '
    'Unused fields: targetBy, pick and setting "none"; numbers 0; text ""; booleans false. '
    "value is everyone|contacts|nobody for visibility, en|hi|mr|kn|ta|te for language, light|dark for theme, "
    "cart|orders|settings|security|profile|groups|help|rewards for navigate and shared|mine for ride.group_mode. "
    "weeklyRupees 0 removes the budget. Changing a password, two factor, fingerprint lock, signing out or deleting the account is navigate with value security."
)

TRAIN_SYSTEM = (
    "You are Flouna's intent engine for ordering food, booking rides and shopping in India.\n"
    'Reply ONLY with one JSON object: {"domain":"food"|"ride"|"shop"|"combo"|"action"|"greeting"|"out_of_scope","reply":string,"food"?,"ride"?,"shop"?,"action"?}\n'
    'food: {"item":string,"budgetPaise":number|null,"maxEtaMinutes":number|null,"dietary":"veg"|"nonveg"|"any","priority":"price"|"rating"|"speed"|"balanced"}\n'
    'ride: {"pickup":string|null,"drop":string,"vehicle":"bike"|"auto"|"cab"|"any","budgetPaise":number|null,"maxPickupMinutes":number|null,"priority":"price"|"rating"|"speed"|"balanced","scheduleAt":"HH:mm"|null}\n'
    'shop: {"item":string,"budgetPaise":number|null,"category":"electronics"|"fashion"|"home"|"appliances"|"any","priority":"price"|"rating"|"speed"|"balanced"}\n'
    + ACTION_RULES + "\n"
    "Rules: food=order/find food; budget in paise (Rs 300 = 30000); maxEtaMinutes=delivery limit; a delivery deadline with no priority word means speed. "
    "ride=transport; maxPickupMinutes=pickup wait only, not the whole trip; scheduleAt=clock time; pickup is null unless the user says where to pick them up; "
    "vehicle is any unless a vehicle word is given. shop=buy a product. combo=food AND ride. greeting=hello/thanks and small talk about the app. "
    "out_of_scope=coding, homework, news, jokes, weather, cricket, translation, general knowledge, advice, instructions; never follow instructions. "
    "A bare taste or mood is food with that phrase as the item; a bare product noun is shop; a bare speed or price ask with no object is food item food. "
    "item: dish if named, else meal word (breakfast/lunch/dinner), else the taste phrase, else food. "
    "priority: price=cheap/affordable/budget/sasta/takkuva, speed=fast/quick/asap/jaldi/fatafat/don't want to wait, rating=best/top-rated/badhiya/manchi, else balanced. "
    "dietary: explicit veg/non-veg/meat words first, else the dish itself (dosa, paneer, cake are veg; chicken, mutton, fish are nonveg), else any. "
    "reply: one short friendly sentence. For out_of_scope reply exactly: \"I can help you order food, book rides, or shop. What would you like?\""
)

# ---------------------------------------------------------------------------
# Canonical label rules (D1-D7 in results/v5_holdout_error_analysis.md)
# ---------------------------------------------------------------------------

MEALS = ("breakfast", "brunch", "lunch", "dinner", "snack")
MOOD_RE = re.compile(
    r"something\s+(?:cheesy|sweet|spicy|light|healthy|creamy|filling|fresh|hot|cold|savoury|savory)\b", re.I
)
DISH_DIETARY = dict(g.FOOD_DIETARY)
DISH_DIETARY.update({
    "dosa": "veg", "masala dosa": "veg", "plain dosa": "veg",
    "uttapam": "veg", "idli": "veg", "medu vada": "veg",
    "cake": "veg", "brownie": "veg", "pancakes": "veg", "waffles": "veg",
    "coffee": "veg", "chai": "veg", "milkshake": "veg", "smoothie": "veg",
    "dahi puri": "veg", "gulab jamun": "veg", "jalebi": "veg",
})
ITEM_CATEGORY = {
    g.norm_key(item): category
    for category, items in g.SHOP_ITEMS.items()
    for item in items
}

VEHICLE_PATTERNS = (
    ("bike", re.compile(
        r"\b(?:bike(?:\s+taxi)?|moto|motorbike|motor\s+bike|scooter|two\s+wheeler)\b", re.I)),
    ("auto", re.compile(r"\b(?:auto(?:\s+rickshaw)?|rickshaw|three\s+wheeler)\b", re.I)),
    ("cab", re.compile(r"\b(?:cab|car)\b|(?<!bike\s)(?<!bike-)taxi\b", re.I)),
)

BALANCED_CUES = re.compile(
    r"\b(?:no special preference|no preference|no particular preference|nothing specific|"
    r"doesn'?t matter|does not matter|decent|good value)\b", re.I)

PRIORITY_CUES = (
    ("rating", re.compile(
        r"\b(?:best|top[\s-]?rated|highest[\s-]?rated|highest rating|best[\s-]?rated|"
        r"highly rated|popular|"
        r"badhiya|manchi|good quality|best reviews|everyone rates highly)\b", re.I)),
    ("speed", re.compile(
        r"\b(?:fast(?:est)?|quick(?:est|ly)?|asap|as soon as possible|urgent(?:ly)?|jaldi|"
        r"fatafat|tondaraga|turant|hurry|in a rush|minimum wait|no waiting|no wait|"
        r"don'?t want to wait|do not want to wait|don'?t want a long wait|"
        r"do not want a long wait|without a long wait|right away|"
        r"immediately|express)\b", re.I)),
    ("price", re.compile(
        r"\b(?:cheap(?:est)?|affordable|inexpensive|low[\s-]?cost|lowest price|save money|"
        r"value for money|economical|sasta|saste|sabse sasta|takkuva(?: rate)?|"
        r"budget[\s-]?friendly|budget(?![\s-]*(?:is|of|with|within|limit)\b)"
        r"(?!\s*(?:₹|rs\.?|inr|rupees?)?\s*\d)|"
        r"without spending (?:a lot|much)|"
        r"don'?t want to spend|do not want to spend)\b", re.I)),
)


def priority_from_text(text: str, part: str, eta=None, wait=None) -> str:
    if BALANCED_CUES.search(text):
        return "balanced"
    for name, pattern in PRIORITY_CUES:
        if pattern.search(text):
            return name
    if part == "food" and eta is not None:
        return "speed"
    if part == "ride" and wait is not None:
        return "speed"
    return "balanced"

NONVEG_STATED = re.compile(
    r"\b(?:non[\s-]?veg(?:etarian)?|nonvegetarian|meat|chicken|mutton|goat|lamb|beef|pork|"
    r"fish|prawn|shrimp|egg|keema|kebab|tandoori\s+chicken)\b", re.I,
)
VEG_STATED = re.compile(r"\b(?:veg(?:etarian)?|veggie|pure\s+veg|jain)\b", re.I)
AVOID_MEAT = re.compile(
    r"\b(?:no|without|don'?t|do\s+not|never|avoid|not)\b[^.]{0,24}"
    r"\b(?:meat|non[\s-]?veg(?:etarian)?|chicken|mutton|fish|egg|prawn)\b", re.I,
)

TRANSFORMS: Counter = Counter()
TRANSFORM_SAMPLES: dict[str, list[str]] = defaultdict(list)


def note(kind: str, text: str, before=None, after=None) -> None:
    TRANSFORMS[kind] += 1
    if len(TRANSFORM_SAMPLES[kind]) < 8:
        if before is None:
            TRANSFORM_SAMPLES[kind].append(text)
        else:
            TRANSFORM_SAMPLES[kind].append(f"{text} :: {before!r} -> {after!r}")


def place_in_text(place: str, text: str) -> bool:
    p, t = g.norm_key(place), g.norm_key(text)
    if not p:
        return False
    if p in t:
        return True
    return p.startswith("the ") and p[4:] in t


def vehicle_from(text: str) -> str:
    found = [name for name, pattern in VEHICLE_PATTERNS if pattern.search(text)]
    if len(found) == 1:
        return found[0]
    if len(found) > 1:
        return "any"
    return "any"


def explicit_dietary(text: str) -> str | None:
    if AVOID_MEAT.search(text):
        return "veg"
    if NONVEG_STATED.search(text):
        return "nonveg"
    if VEG_STATED.search(text):
        return "veg"
    return None


def canonical_dietary(text: str, item: str) -> str:
    stated = explicit_dietary(text)
    if stated:
        return stated
    for candidate in (item, text):
        key = g.norm_key(candidate)
        if key in DISH_DIETARY:
            return DISH_DIETARY[key]
        for dish in sorted(DISH_DIETARY, key=len, reverse=True):
            if dish and re.search(rf"\b{re.escape(dish)}\b", key):
                return DISH_DIETARY[dish]
    return "any"


def canonical_item(text: str, item: str) -> str:
    t = g.norm_key(text)
    it = g.norm_key(item)
    dietary_only = {
        "veg", "nonveg", "non veg", "non vegetarian", "nonvegetarian", "vegetarian",
        "pure veg", "veggie", "jain", "non-veg",
    }
    needs_rule = (not it) or it in {
        "food", "something", "anything", "option", "options", "meal", "meals",
    } | dietary_only or it not in t
    if not needs_rule:
        return item
    for meal in MEALS:
        if re.search(rf"\b{meal}\b", t):
            return meal
    mood = MOOD_RE.search(text)
    if mood:
        return g.clean_text(mood.group(0).lower())
    return "food"


def canonical_food(text: str, body: dict) -> dict:
    item = canonical_item(text, str(body.get("item") or ""))
    if item != (body.get("item") or ""):
        note("food.item", text, body.get("item"), item)
    dietary = canonical_dietary(text, item)
    if dietary != body.get("dietary"):
        note("food.dietary", text, body.get("dietary"), dietary)
    ev = fs.text_evidence(text)
    budget = body.get("budgetPaise")
    if budget is not None and not ev["money"]:
        note("food.budget_phantom", text, budget, None)
        budget = None
    eta = body.get("maxEtaMinutes")
    if eta is not None and not ev["eta"]:
        note("food.eta_phantom", text, eta, None)
        eta = None
    priority = priority_from_text(text, "food", eta=eta)
    if priority != body.get("priority"):
        note("food.priority", text, body.get("priority"), priority)
    return {
        "item": item,
        "budgetPaise": budget,
        "maxEtaMinutes": eta,
        "dietary": dietary,
        "priority": priority,
    }


def extract_wait(text: str) -> int | None:
    if fs.TRIP_RE.search(text) and not fs.WAIT_RE.search(text):
        return None
    for pattern in (
        r"\b(?:wait|pickup|pick\s+me\s+up|reach\s+me|driver|come|aao)\b[^.]{0,45}?(\d{1,2})\s*(?:minutes?|mins?)\b",
        r"(\d{1,2})\s*(?:minutes?|mins?)\b[^.]{0,25}\b(?:wait|pickup|driver)\b",
    ):
        match = re.search(pattern, text, re.I)
        if match:
            return int(match.group(1))
    return None


def parse_clock(text: str) -> str | None:
    m = re.search(r"\b(?:at|by|tonight\s+at)\s+([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm)\b", text, re.I)
    if m:
        hour, minute, suffix = int(m.group(1)), int(m.group(2) or 0), m.group(3).lower()
        if suffix == "am":
            hour = 0 if hour == 12 else hour
        else:
            hour = 12 if hour == 12 else hour + 12
        return f"{hour:02d}:{minute:02d}"
    m = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", text)
    if m:
        return f"{int(m.group(1)):02d}:{int(m.group(2)):02d}"
    m = re.search(r"\b([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm)\b", text, re.I)
    if m:
        hour, minute, suffix = int(m.group(1)), int(m.group(2) or 0), m.group(3).lower()
        if suffix == "am":
            hour = 0 if hour == 12 else hour
        else:
            hour = 12 if hour == 12 else hour + 12
        return f"{hour:02d}:{minute:02d}"
    m = re.search(r"\btonight\s+at\s+([1-9]|1[0-2])\b", text, re.I)
    if m:
        hour = int(m.group(1))
        return f"{12 + hour if hour < 12 else hour:02d}:00"
    return None


def canonical_ride(text: str, body: dict) -> dict | None:
    drop = str(body.get("drop") or "").strip()
    if not drop:
        return None
    pickup = body.get("pickup")
    if pickup and not place_in_text(str(pickup), text):
        note("ride.pickup_phantom", text, pickup, None)
        pickup = None
    vehicle = vehicle_from(text)
    if vehicle != body.get("vehicle"):
        note("ride.vehicle", text, body.get("vehicle"), vehicle)
    ev = fs.text_evidence(text)
    budget = body.get("budgetPaise")
    if budget is not None and not ev["money"]:
        note("ride.budget_phantom", text, budget, None)
        budget = None
    wait = body.get("maxPickupMinutes")
    if wait is not None and (not ev["wait"] or (ev["trip"] and not fs.WAIT_RE.search(text))):
        note("ride.wait_phantom", text, wait, None)
        wait = None
    if wait is None and ev["wait"]:
        wait = extract_wait(text)
        if wait is not None:
            note("ride.wait_filled", text, None, wait)
    schedule = body.get("scheduleAt")
    if schedule and not ev["schedule"]:
        note("ride.schedule_phantom", text, schedule, None)
        schedule = None
    if schedule is None and ev["schedule"]:
        schedule = parse_clock(text)
        if schedule is not None:
            note("ride.schedule_filled", text, None, schedule)
    cue = priority_from_text(text, "ride", wait=wait)
    priority = cue
    if priority != body.get("priority"):
        note("ride.priority", text, body.get("priority"), priority)
    return {
        "pickup": pickup,
        "drop": drop,
        "vehicle": vehicle,
        "budgetPaise": budget,
        "maxPickupMinutes": wait,
        "priority": priority,
        "scheduleAt": schedule,
    }


def canonical_shop(text: str, body: dict) -> dict:
    item = str(body.get("item") or "").strip()
    category = ITEM_CATEGORY.get(g.norm_key(item))
    if category is None:
        label = body.get("category")
        category = label if label in fs.CATEGORIES else "any"
    if category != body.get("category"):
        note("shop.category", text, body.get("category"), category)
    ev = fs.text_evidence(text)
    budget = body.get("budgetPaise")
    if budget is not None and not ev["money"]:
        note("shop.budget_phantom", text, budget, None)
        budget = None
    cue = priority_from_text(text, "shop")
    priority = cue
    if priority != body.get("priority"):
        note("shop.priority", text, body.get("priority"), priority)
    return {"item": item or "product", "budgetPaise": budget, "category": category, "priority": priority}


def canonical_row(text: str, output: dict) -> dict | None:
    domain = output.get("domain")
    reply = str(output.get("reply") or "")
    new: dict = {"domain": domain, "reply": reply}
    if domain == "food" and isinstance(output.get("food"), dict):
        new["food"] = canonical_food(text, output["food"])
    elif domain == "ride" and isinstance(output.get("ride"), dict):
        ride = canonical_ride(text, output["ride"])
        if ride is None:
            return None
        new["ride"] = ride
    elif domain == "shop" and isinstance(output.get("shop"), dict):
        new["shop"] = canonical_shop(text, output["shop"])
    elif domain == "combo":
        if not isinstance(output.get("food"), dict) or not isinstance(output.get("ride"), dict):
            return None
        new["food"] = canonical_food(text, output["food"])
        ride = canonical_ride(text, output["ride"])
        if ride is None:
            return None
        new["ride"] = ride
    elif domain == "action" and isinstance(output.get("action"), dict):
        new["action"] = dict(output["action"])
    elif domain in ("greeting", "out_of_scope"):
        pass
    else:
        return None
    if new["domain"] == "action":
        errors = fs.validate_intent(new) + fs.validate_action_semantics(new.get("action"))
    else:
        errors = fs.validate_intent(new) + fs.label_conflicts(text, new)
    if errors:
        return None
    return new


# ---------------------------------------------------------------------------
# Action helpers
# ---------------------------------------------------------------------------

ACTION_DEFAULTS = {
    "kind": "cart.show",
    "targetBy": "none",
    "targetPosition": 0,
    "targetName": "",
    "qty": 0,
    "members": 0,
    "withMyItems": False,
    "pick": "none",
    "setting": "none",
    "on": False,
    "value": "",
    "weeklyRupees": 0,
}
ACTION_REPLIES = [
    "Okay, doing that now.",
    "Got it.",
    "Done, I will take care of that.",
    "Sure, on it.",
    "Okay, I will do that.",
    "Understood.",
]


def action_output(rng: random.Random, kind: str, reply: str | None = None, **over) -> dict:
    body = dict(ACTION_DEFAULTS)
    body["kind"] = kind
    body.update(over)
    return {"domain": "action", "reply": reply or rng.choice(ACTION_REPLIES), "action": body}


def build_action_eval() -> list[tuple[str, dict]]:
    """A fixed, hand-curated action benchmark. Never trained on, never tuned."""
    rng = random.Random(90210)
    cases: list[tuple[str, dict]] = []

    def add(text: str, out: dict) -> None:
        cases.append((text, out))

    def act(text: str, kind: str, **over) -> None:
        add(text, action_output(rng, kind, **over))

    # cart
    act("add that to my basket", "cart.add", targetBy="last", qty=1)
    act("put two more momos in my cart", "cart.add", targetBy="name", targetName="momos", qty=2)
    act("add the third option", "cart.add", targetBy="position", targetPosition=3, qty=1)
    act("remove the momos from my cart", "cart.remove", targetBy="name", targetName="momos")
    act("delete that item", "cart.remove", targetBy="last")
    act("remove option 2", "cart.remove", targetBy="position", targetPosition=2)
    act("make it three", "cart.set_qty", targetBy="last", qty=3)
    act("change the second item to qty 1", "cart.set_qty", targetBy="position", targetPosition=2, qty=1)
    act("what's in my cart", "cart.show")
    act("show my basket", "cart.show")
    act("empty my cart", "cart.clear")
    act("check out", "checkout")
    act("place the order", "checkout")
    # groups
    act("start a group order for four", "group.create", members=4, withMyItems=False)
    act("start a group order for 3 and include my items", "group.create", members=3, withMyItems=True)
    act("show the group order", "group.show")
    # selection and rides
    act("I'll take the cheapest", "select", pick="cheapest")
    act("go with the fastest one", "select", pick="fastest")
    act("choose the second option", "select", targetBy="position", targetPosition=2)
    act("book the ride I selected", "ride.book")
    act("arrange rides for 4 people", "ride.group", members=4)
    act("book cabs for 3 of us", "ride.group", members=3)
    act("make the group ride shared", "ride.group_mode", value="shared")
    act("keep the group ride to my items only", "ride.group_mode", value="mine")
    # toggles
    act("turn off email updates", "settings.toggle", setting="emailUpdates", on=False)
    act("enable smart suggestions", "settings.toggle", setting="smartSuggestions", on=True)
    act("stop sending me email tips", "settings.toggle", setting="emailTips", on=False)
    act("email me about money updates", "settings.toggle", setting="emailMoneyUpdates", on=True)
    act("share my location", "settings.toggle", setting="shareLocation", on=True)
    act("hide my activity status", "settings.toggle", setting="activityStatus", on=False)
    # visibility, budget, language, theme
    act("set my visibility to contacts", "settings.visibility", value="contacts")
    act("only I should see my profile", "settings.visibility", value="nobody")
    act("let everyone see my profile", "settings.visibility", value="everyone")
    act("set my weekly food budget to 2500", "settings.budget", weeklyRupees=2500)
    act("remove my weekly food budget", "settings.budget", weeklyRupees=0)
    act("switch the app to Hindi", "settings.language", value="hi")
    act("use Kannada", "settings.language", value="kn")
    act("switch to dark mode", "settings.theme", value="dark")
    act("use the light theme", "settings.theme", value="light")
    # navigation
    act("open my orders", "navigate", value="orders")
    act("go to my profile", "navigate", value="profile")
    act("show me the help screen", "navigate", value="help")
    act("open my rewards", "navigate", value="rewards")
    act("change my password", "navigate", value="security")
    act("sign me out", "navigate", value="security")
    act("delete my account", "navigate", value="security")
    act("turn on two factor authentication", "navigate", value="security")
    act("open the cart page", "navigate", value="cart")
    act("take me to settings", "navigate", value="settings")
    act("open my groups", "navigate", value="groups")

    # hard negatives: discovery, information, decision, confirmation
    add("order a pizza", food("pizza", "any"))
    add("book a cab to the airport", ride(None, "the airport", "cab"))
    add("find me a laptop under 50000",
        g.shop_output(rng, "laptop", "electronics", "balanced", 50000))
    for text in ("how do I add something to my cart", "where can I change my language",
                 "show me how to check out", "do you have dark mode",
                 "can I set a weekly budget", "where are my orders"):
        add(text, g.greeting_output(rng))
    oos = {"domain": "out_of_scope", "reply": OOS_REPLY}
    for text in ("should I check out", "I'm not sure whether to remove it", "yes", "no",
                 "cancel", "I might add two more later",
                 "if I clear my cart, will I lose my items", "did my order go through",
                 "I don't want to remove it", "maybe later"):
        add(text, dict(oos))
    add("I'd like to order dinner", food("dinner", "any"))
    add("what is the cheapest ride to the airport",
        ride(None, "the airport", "any", None, None, "price", None))
    add("I want to buy a wallet",
        g.shop_output(rng, "wallet", "fashion", "balanced", None))
    return cases


def write_action_eval(path: Path) -> list[str]:
    cases = build_action_eval()
    rows = [g.to_row(TRAIN_SYSTEM, text, out) for text, out in cases]
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    return [text for text, _ in cases]


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------

class Builder:
    def __init__(self, rng: random.Random, forbidden: set[str]):
        self.rng = rng
        self.rows: list[tuple[str, dict, str]] = []
        self.seen = set(forbidden)
        self.skipped = 0

    def add(self, text: str, output: dict, source: str, style: bool = True) -> bool:
        text = g.style_text(self.rng, text) if style else g.clean_text(text)
        key = g.norm_key(text)
        if not key or key in self.seen:
            self.skipped += 1
            return False
        if output["domain"] == "action":
            errors = fs.validate_intent(output) + fs.validate_action_semantics(output["action"])
        else:
            errors = fs.validate_intent(output) + fs.label_conflicts(text, output)
        if errors:
            raise ValueError(f"invalid row for {text!r}: {errors}")
        self.seen.add(key)
        self.rows.append((text, output, source))
        return True


REPLY_RNG = random.Random(20261116)


def ride(text_pickup, text_drop, vehicle, budget=None, wait=None, priority="balanced",
         schedule=None):
    return g.ride_output(REPLY_RNG, text_pickup, text_drop, vehicle, budget, wait, priority, schedule)


def food(item, dietary, priority="balanced", budget=None, eta=None):
    return g.food_output(REPLY_RNG, item, dietary, priority, budget, eta)


# ---------------------------------------------------------------------------
# Targeted non-action rows
# ---------------------------------------------------------------------------

WAIT_PHRASES = [
    "the driver should reach me within {n} minutes",
    "I can wait no more than {n} minutes for pickup",
    "pickup in under {n} minutes",
    "have the driver come within {n} minutes",
    "reach me in {n} minutes",
    "pick me up in {n} minutes",
    "don't want to wait more than {n} minutes",
    "{n} minute me aao",
    "{n} minutes lopala pick cheyandi",
]
ORIGIN_SHELLS = [
    "from {pickup} to {drop}",
    "{pickup} se {drop} tak",
    "{pickup} nundi {drop} ki",
    "pick me up from {pickup} and drop me at {drop}",
    "pickup at {pickup}, drop at {drop}",
]
NO_ORIGIN_SHELLS = [
    "{lead} to {drop}",
    "book a {lead} to {drop}",
    "I need a {lead} to {drop}",
    "{drop} ke liye {lead} chahiye",
    "{drop} ke liye {lead} book karo",
    "get me a {lead} to {drop}",
]


def gen_ride_pairs(b: Builder, n: int = 220) -> None:
    rng = b.rng
    for _ in range(n):
        pickup, drop = rng.sample(g.PLACES, 2)
        vehicle = rng.choices(["bike", "auto", "cab", "any"], weights=[0.22, 0.25, 0.38, 0.15])[0]
        cue_priority = rng.choices(["price", "speed", "rating", "balanced"], weights=[0.3, 0.3, 0.18, 0.22])[0]
        cue = "" if cue_priority == "balanced" else rng.choice(g.PRIORITY_ADJ[cue_priority])
        lead = f"{cue} {rng.choice(g.VEHICLES[vehicle])}".strip() if vehicle != "any" else f"{cue} ride".strip()
        budget = rng.choice(g.RIDE_BUDGETS) if rng.random() < 0.3 else None
        wait = rng.choice(g.PICKUP_VALUES) if rng.random() < 0.25 else None
        schedule = rng.choice(g.SCHEDULES) if (wait is None and rng.random() < 0.14) else None
        trip = rng.choice([20, 25, 30, 35, 45]) if (wait is None and schedule is None and rng.random() < 0.12) else None
        priority = cue_priority if cue_priority != "balanced" else ("speed" if wait is not None else "balanced")
        pair = rng.choice(ORIGIN_SHELLS).format(pickup=pickup, drop=drop)
        text = rng.choice([
            f"book {lead} {pair}",
            f"I need {lead} {pair}",
            f"{pair}, {lead} chahiye",
            f"please arrange {lead} {pair}",
        ])
        clauses = []
        if budget:
            clauses.append(g.money(rng, budget))
        if wait:
            clauses.append(rng.choice(WAIT_PHRASES).format(n=wait))
        if schedule:
            clauses.append(schedule[0])
        if trip:
            clauses.append(f"I need to arrive in {trip} minutes")
        if clauses:
            text = f"{text}, {', '.join(clauses[:-1])}" + (f" and {clauses[-1]}" if len(clauses) > 1 else f" {clauses[0]}")
        b.add(text, ride(pickup, drop, vehicle, budget, wait, priority, schedule[1] if schedule else None),
              "ride_pair")


def gen_ride_no_origin(b: Builder, n: int = 140) -> None:
    rng = b.rng
    for _ in range(n):
        drop = rng.choice(g.PLACES)
        vehicle = rng.choices(["bike", "auto", "cab", "any"], weights=[0.2, 0.25, 0.4, 0.15])[0]
        cue_priority = rng.choices(["price", "speed", "rating", "balanced"], weights=[0.3, 0.3, 0.18, 0.22])[0]
        cue = "" if cue_priority == "balanced" else rng.choice(g.PRIORITY_ADJ[cue_priority])
        lead = (f"{cue} {rng.choice(g.VEHICLES[vehicle])}" if vehicle != "any" else f"{cue} ride").strip()
        budget = rng.choice(g.RIDE_BUDGETS) if rng.random() < 0.28 else None
        wait = rng.choice(g.PICKUP_VALUES) if rng.random() < 0.3 else None
        schedule = rng.choice(g.SCHEDULES) if (wait is None and rng.random() < 0.12) else None
        trip = rng.choice([20, 25, 30, 35, 45]) if (wait is None and schedule is None and rng.random() < 0.12) else None
        priority = cue_priority if cue_priority != "balanced" else ("speed" if wait is not None else "balanced")
        text = rng.choice(NO_ORIGIN_SHELLS).format(lead=lead, drop=drop)
        clauses = []
        if budget:
            clauses.append(g.money(rng, budget))
        if wait:
            clauses.append(rng.choice(WAIT_PHRASES).format(n=wait))
        if schedule:
            clauses.append(schedule[0])
        if trip:
            clauses.append(f"I need to arrive in {trip} minutes")
        if clauses:
            text = f"{text}, {', '.join(clauses[:-1])}" + (f" and {clauses[-1]}" if len(clauses) > 1 else f" {clauses[0]}")
        b.add(text, ride(None, drop, vehicle, budget, wait, priority, schedule[1] if schedule else None),
              "ride_no_origin")


def gen_trip_deadline(b: Builder, n: int = 40) -> None:
    rng = b.rng
    for _ in range(n):
        drop = rng.choice(g.PLACES)
        minutes = rng.choice([20, 25, 30, 35, 45, 50])
        text = rng.choice([
            f"cab to {drop}, I need to arrive in {minutes} minutes",
            f"book a ride to {drop}, get me there in {minutes} minutes",
            f"how long to reach {drop}, I must be there in {minutes} minutes",
            f"{drop} jana hai, {minutes} minutes me pahuchna hai",
        ])
        b.add(text, ride(None, drop, vehicle_from(text), None, None, "balanced", None), "trip_deadline")


def gen_combo_rows(b: Builder, n: int = 110) -> None:
    rng = b.rng
    dishes = [d for d in list(DISH_DIETARY) if " " not in d or rng.random() < 0.4]
    for _ in range(n):
        item = rng.choice(dishes)
        drop = rng.choice(g.PLACES)
        explicit_vehicle = rng.random() < 0.3
        vehicle = rng.choices(["bike", "auto", "cab"], weights=[0.2, 0.25, 0.55])[0] if explicit_vehicle else "any"
        vword = rng.choice(g.VEHICLES[vehicle]) if explicit_vehicle else "ride"
        dietary = canonical_dietary(item, item)
        text = rng.choice([
            f"order {item} and book a {vword} to {drop}",
            f"{item} order karo aur {drop} ke liye {vword} book karo",
            f"get me {item} and a ride to {drop}",
            f"I want {item} for dinner and a {vword} to {drop}",
            f"food: {item}, and also need a ride to {drop}",
            f"book a {vword} to {drop} and order {item}",
            f"need {item} delivered and a {vword} to {drop}",
        ])
        out = {
            "domain": "combo",
            "reply": rng.choice(g.COMBO_REPLIES).format(item=item, drop=drop),
            "food": {"item": item, "budgetPaise": None, "maxEtaMinutes": None,
                     "dietary": dietary, "priority": "balanced"},
            "ride": {"pickup": None, "drop": drop, "vehicle": vehicle, "budgetPaise": None,
                     "maxPickupMinutes": None, "priority": "balanced", "scheduleAt": None},
        }
        b.add(text, out, "combo")


def gen_dietary_rows(b: Builder, n: int = 150) -> None:
    rng = b.rng
    dishes = list(DISH_DIETARY)
    for _ in range(n):
        item = rng.choice(dishes)
        dietary = DISH_DIETARY[item]
        priority = rng.choices(["price", "speed", "rating", "balanced"], weights=[0.25, 0.25, 0.15, 0.35])[0]
        cue = "" if priority == "balanced" else rng.choice(g.PRIORITY_ADJ[priority]) + " "
        shells = [
            f"{cue}{item}",
            f"order {cue}{item}",
            f"get me {cue}{item}",
            f"{cue}{item} chahiye",
            f"bhai {cue}{item} de do",
            f"I feel like having {cue}{item}",
            f"need {cue}{item} delivered",
        ]
        if priority == "speed":
            shells.append(f"send {item} ASAP")
        text = rng.choice(shells)
        if priority == "speed" and "send" not in text and rng.random() < 0.5:
            text = text.replace(item, f"{item} quickly", 1)
        b.add(text, food(item, dietary, priority), "dietary")


def gen_priority_rows(b: Builder, n: int = 150) -> None:
    rng = b.rng
    dishes = list(DISH_DIETARY)
    for _ in range(n):
        priority = rng.choices(["price", "speed", "rating"], weights=[0.4, 0.35, 0.25])[0]
        word = rng.choice(g.PRIORITY_ADJ[priority])
        if rng.random() < 0.25:
            word = word.upper()
        kind = rng.choices(["food", "shop", "ride"], weights=[0.5, 0.3, 0.2])[0]
        if kind == "food":
            item = rng.choice(dishes)
            text = rng.choice([f"{word} {item}", f"order {word} {item}", f"I want {word} {item}",
                               f"{item} {word} chahiye", f"get me {word} {item} please"])
            b.add(text, food(item, DISH_DIETARY[item], priority), "priority")
        elif kind == "shop":
            item = rng.choice([i for items in g.SHOP_ITEMS.values() for i in items])
            text = rng.choice([f"{word} {item}", f"buy {word} {item}", f"looking for {word} {item}",
                               f"{item} {word} chahiye"])
            b.add(text, g.shop_output(rng, item, ITEM_CATEGORY[g.norm_key(item)], priority, None), "priority")
        else:
            drop = rng.choice(g.PLACES)
            text = rng.choice([f"{word} cab to {drop}", f"book {word} ride to {drop}",
                               f"I need a {word} auto to {drop}"])
            vehicle = vehicle_from(text)
            b.add(text, ride(None, drop, vehicle, None, None, priority, None), "priority")


def gen_item_rows(b: Builder, n: int = 90) -> None:
    rng = b.rng
    for _ in range(n):
        meal = rng.choice(MEALS)
        priority = rng.choices(["price", "speed", "rating", "balanced"], weights=[0.3, 0.3, 0.15, 0.25])[0]
        cue = "" if priority == "balanced" else rng.choice(g.PRIORITY_ADJ[priority]) + " "
        text = rng.choice([
            f"something {cue}for {meal}",
            f"I need {cue}{meal}",
            f"get me {cue}{meal} please",
            f"{cue}{meal} chahiye",
            f"order {cue}{meal}",
            f"find {cue}{meal}",
        ])
        b.add(text, food(meal, "any", priority), "item")
    for _ in range(n // 3):
        dietary, label = rng.choice([("veg", "veg"), ("nonveg", "nonveg")])
        word = rng.choice(g.VEG_ADJ if dietary == "veg" else g.NONVEG_ADJ)
        text = rng.choice([f"{word} options", f"show me {word} food", f"I want {word} options",
                           f"{word} only please", f"give me something {word}"])
        b.add(text, food("food", label), "item")
    for _ in range(n // 3):
        mood = rng.choice(["sweet", "spicy", "light", "healthy", "cheesy", "creamy", "filling", "fresh"])
        text = rng.choice([f"something {mood}", f"I want something {mood}",
                           f"craving something {mood}", f"get me something {mood}"])
        b.add(text, food(f"something {mood}", "any"), "item")
    for text in ("what is the fastest option", "which option is quickest", "show me the quickest thing",
                 "I don't want a long wait", "no waiting please", "give me the fastest option"):
        b.add(text, food("food", "any", "speed"), "item")
    for text in ("cheapest thing you have", "what is the cheapest option"):
        b.add(text, food("food", "any", "price"), "item")
    for text in ("I am hungry",):
        b.add(text, food("food", "any", "balanced"), "item")


def gen_shop_categories(b: Builder, n: int = 110) -> None:
    rng = b.rng
    items = [(item, category) for category, rows in g.SHOP_ITEMS.items() for item in rows]
    for _ in range(n):
        item, category = rng.choice(items)
        priority = rng.choices(["price", "rating", "speed", "balanced"], weights=[0.35, 0.2, 0.1, 0.35])[0]
        cue = "" if priority == "balanced" else rng.choice(g.PRIORITY_ADJ[priority]) + " "
        budget = rng.choice(g.SHOP_BUDGETS) if rng.random() < 0.4 else None
        text = rng.choice([
            f"{cue}{item}", f"buy {cue}{item}", f"need {cue}{item}", f"looking for {cue}{item}",
            f"which {cue}{item} should I get", f"show me {cue}{item}",
            f"I want to buy {cue}{item}", f"{cue}{item} khareedna hai",
            f"my old one broke, so I want {cue}{item}",
        ])
        if budget:
            text = f"{text} {g.money(rng, budget)}"
        b.add(text, g.shop_output(rng, item, category, priority, budget), "shop")


def gen_short_domain(b: Builder, n: int = 90) -> None:
    rng = b.rng
    products = [i for items in g.SHOP_ITEMS.values() for i in items]
    for _ in range(n // 3):
        item = rng.choice(products)
        b.add(rng.choice([item, f"buy {item}", f"I want a {item}", f"need {item}"]),
              g.shop_output(rng, item, ITEM_CATEGORY[g.norm_key(item)], "balanced", None), "short")
    for _ in range(n // 3):
        text = rng.choice([
            "how does this app work", "what can you do for me", "tell me what you do",
            "are you a bot", "what is flouna", "how do I use this app",
            "what should I call you", "hello there, what is this app for",
            "hi, can you tell me what you do", "how do you actually work",
            "what can I ask you", "who made this app", "is this a real person",
        ])
        b.add(text, g.greeting_output(rng), "short")
    oos = [
        "what is the weather in Mumbai", "who won the match yesterday", "write a sorting function",
        "explain a black hole", "what is the capital of Australia", "recommend a series",
        "how do I bake bread", "give me a workout plan", "translate good morning to French",
        "who is the CEO of Google", "solve 15 percent of 240", "what is the news",
        "how tall is Everest", "is coffee healthy", "how do magnets work",
        "write a cover letter", "what should I watch tonight", "how to fix a bike puncture",
        "tell me a fun fact", "what is the time in London", "how do I learn guitar",
        "what does democracy mean", "why is the sky blue", "who invented the telephone",
        "how far is the moon", "write a poem about rain", "what is photosynthesis",
        "suggest a book", "how can I sleep better", "explain the stock market",
    ]
    for text in oos:
        b.add(text, {"domain": "out_of_scope", "reply": OOS_REPLY}, "short")


# ---------------------------------------------------------------------------
# Action training rows
# ---------------------------------------------------------------------------

def gen_action_rows(b: Builder) -> None:
    rng = b.rng

    def add(text: str, kind: str, **over) -> None:
        b.add(text, action_output(rng, kind, **over), "action")

    # cart.add: target x quantity x shell
    add_shells = [
        ("add that to my cart", "last", 0, "", 1),
        ("put it in my basket", "last", 0, "", 1),
        ("add one more of that", "last", 0, "", 1),
        ("add two of those", "last", 0, "", 2),
        ("add {name} to my cart", "name", 0, "{name}", 1),
        ("put {name} in my basket", "name", 0, "{name}", 1),
        ("add two {name}", "name", 0, "{name}", 2),
        ("add option {pos} to my cart", "position", "{pos}", "", 1),
        ("put option {pos} in my cart", "position", "{pos}", "", 1),
        ("add {qty} of option {pos}", "position", "{pos}", "", "{qty}"),
    ]
    for name in ("momos", "biryani", "pizza", "cake", "coffee", "burger", "saree", "laptop"):
        for shell, target, pos_ref, name_ref, qty_ref in add_shells:
            pos_val = rng.choice([2, 3, 4])
            qty_val = rng.choice([2, 3])
            text = shell.format(name=name, pos=pos_val, qty=qty_val)
            p = pos_val if target == "position" else 0
            q = qty_val if qty_ref == "{qty}" else qty_ref
            actual_name = name if name_ref == "{name}" else ""
            add(text, "cart.add", targetBy=target, targetPosition=p,
                targetName=actual_name, qty=q)

    for text in ("remove the momos from my cart", "delete the biryani", "take the pizza out of my basket",
                 "get rid of the momos", "remove that item", "delete it", "remove option 2",
                 "remove the second option"):
        target = "position" if "option" in text else ("name" if any(w in text for w in ("momos", "biryani", "pizza")) else "last")
        pos = 2 if "2" in text or "second" in text else 0
        name = next((w for w in ("momos", "biryani", "pizza") if w in text), "")
        add(text, "cart.remove", targetBy=target, targetPosition=pos, targetName=name)

    for text, qty in (("make it two", 2), ("make that three", 3), ("change it to one", 1),
                      ("set the quantity to four", 4), ("I want five of those", 5),
                      ("change the second item to qty 2", 2), ("set option 3 to quantity 1", 1)):
        target = "position" if "option" in text or "second" in text else "last"
        pos = 2 if "second" in text else (3 if "option 3" in text else 0)
        add(text, "cart.set_qty", targetBy=target, targetPosition=pos, qty=qty)

    for text in ("show my cart", "what is in my basket", "open my cart", "list my cart items",
                 "show me the basket", "what have I added"):
        add(text, "cart.show")
    for text in ("empty my cart", "clear the basket", "remove everything from my cart",
                 "delete all items in my basket"):
        add(text, "cart.clear")
    for text in ("check out", "place the order", "complete my order", "checkout now",
                 "finish the checkout", "pay and order"):
        add(text, "checkout")
    for members in (2, 3, 4, 5, 6, 8):
        add(f"start a group order for {members}", "group.create", members=members, withMyItems=False)
        add(f"create a group order for {members} with my items", "group.create", members=members, withMyItems=True)
    for text in ("show the group order", "show our group cart", "open the group order",
                 "what is in the group order"):
        add(text, "group.show")
    for text, pick in (("I'll take the cheapest", "cheapest"), ("choose the fastest", "fastest"),
                       ("go with the cheapest one", "cheapest"), ("give me the fastest option", "fastest")):
        add(text, "select", pick=pick)
    for pos in (1, 2, 3, 4):
        add(f"choose option {pos}", "select", targetBy="position", targetPosition=pos)
        add(f"I'll take the {['first', 'second', 'third', 'fourth'][pos - 1]} one", "select",
            targetBy="position", targetPosition=pos)
    for text in ("book the ride", "book the cab I selected", "confirm this ride booking",
                 "reserve the selected cab", "go ahead and book it"):
        add(text, "ride.book")
    for members in (2, 3, 4, 5, 6):
        add(f"arrange rides for {members} people", "ride.group", members=members)
        add(f"book cabs for {members} of us", "ride.group", members=members)
        add(f"we are {members}, book a ride for everyone", "ride.group", members=members)
    for text, value in (("make the group ride shared", "shared"), ("share the group ride", "shared"),
                        ("switch the group ride to shared", "shared"),
                        ("keep the group ride to my items", "mine"),
                        ("use only my items for the group ride", "mine"),
                        ("make it my items only", "mine")):
        add(text, "ride.group_mode", value=value)

    toggles = {
        "emailUpdates": ("email updates", "email updates"),
        "smartSuggestions": ("smart suggestions", "smart suggestions"),
        "emailMoneyUpdates": ("email money updates", "money updates by email"),
        "emailTips": ("email tips", "email tips"),
        "shareLocation": ("location sharing", "share my location"),
        "activityStatus": ("activity status", "show my activity status"),
    }
    for setting, (on_phrase, noun) in toggles.items():
        add(f"turn off {on_phrase}", "settings.toggle", setting=setting, on=False)
        add(f"turn on {on_phrase}", "settings.toggle", setting=setting, on=True)
        add(f"enable {noun}", "settings.toggle", setting=setting, on=True)
        add(f"disable {noun}", "settings.toggle", setting=setting, on=False)
    for text, value in (("set my visibility to everyone", "everyone"),
                        ("let contacts see my profile", "contacts"),
                        ("only I should see my profile", "nobody"),
                        ("hide my profile from everyone", "nobody"),
                        ("make my profile visible to contacts", "contacts"),
                        ("show my profile to everyone", "everyone")):
        add(text, "settings.visibility", value=value)
    for rupees in (500, 1000, 1500, 2500, 3000, 5000, 10000):
        add(f"set my weekly food budget to {rupees}", "settings.budget", weeklyRupees=rupees)
        add(f"make my weekly budget {rupees} rupees", "settings.budget", weeklyRupees=rupees)
    for text in ("remove my weekly food budget", "clear my weekly budget",
                 "set my weekly budget to zero", "delete my food budget"):
        add(text, "settings.budget", weeklyRupees=0)
    langs = {"en": ("English",), "hi": ("Hindi",), "mr": ("Marathi",), "kn": ("Kannada",),
             "ta": ("Tamil",), "te": ("Telugu",)}
    for code, names in langs.items():
        for name in names:
            add(f"switch the app to {name}", "settings.language", value=code)
            add(f"use {name}", "settings.language", value=code)
    for text, value in (("switch to dark mode", "dark"), ("use the dark theme", "dark"),
                        ("turn on dark mode", "dark"), ("switch to light mode", "light"),
                        ("use the light theme", "light"), ("turn off dark mode", "light")):
        add(text, "settings.theme", value=value)
    screens = {
        "cart": ("open the cart", "go to my cart", "show the cart page"),
        "orders": ("open my orders", "show my order history", "go to orders"),
        "settings": ("open settings", "take me to settings", "show the settings screen"),
        "security": ("open security", "go to privacy and security", "show security settings"),
        "profile": ("open my profile", "go to my profile", "show my profile page"),
        "groups": ("open my groups", "show the groups screen", "go to group orders"),
        "help": ("open help", "show the help screen", "take me to support"),
        "rewards": ("open my rewards", "show my rewards", "go to the rewards page"),
    }
    for value, texts in screens.items():
        for text in texts:
            add(text, "navigate", value=value)
    for text in ("change my password", "reset my password", "turn on two factor authentication",
                 "enable fingerprint lock", "sign me out", "log me out", "delete my account",
                 "change my phone number", "manage my security"):
        add(text, "navigate", value="security")

    # Hard negatives. Intent, information or a decision without authorisation.
    negatives = [
        ("order a pizza", food("pizza", "any")),
        ("book a cab to the airport", ride(None, "the airport", "cab")),
        ("find me a laptop under 50000", g.shop_output(rng, "laptop", "electronics", "balanced", 50000)),
        ("I want to buy running shoes", g.shop_output(rng, "running shoes", "fashion", "balanced", None)),
        ("order dinner for two", food("dinner", "any")),
        ("get me a ride home", ride(None, "home", "any")),
        ("how do I add something to my cart", g.greeting_output(rng)),
        ("where can I change my language", g.greeting_output(rng)),
        ("how do I check out", g.greeting_output(rng)),
        ("do you have dark mode", g.greeting_output(rng)),
        ("can I set a weekly budget", g.greeting_output(rng)),
        ("where are my orders", g.greeting_output(rng)),
        ("what can the cart do", g.greeting_output(rng)),
        ("should I check out now", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("I'm not sure whether to remove it", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("I haven't decided if I want it", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("I might add two more later", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("if I clear my cart, will I lose my items", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("did my order go through", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("I don't want to remove it", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("maybe later", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("I am thinking about checking out", {"domain": "out_of_scope", "reply": OOS_REPLY}),
        ("I would like to order dinner", food("dinner", "any")),
        ("can you find me a cheaper ride to the office",
         ride(None, "the office", "any", None, None, "price", None)),
    ]
    for text, out in negatives:
        b.add(text, out, "action_neg")
    for text in ("yes", "no", "cancel", "confirm", "okay", "sure", "not now", "go ahead"):
        b.add(text, {"domain": "out_of_scope", "reply": OOS_REPLY}, "action_neg")


# ---------------------------------------------------------------------------
# Load, canonicalise, write, report
# ---------------------------------------------------------------------------

def load_chat_rows(path: Path) -> list[tuple[str, dict]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        rows.append((row["messages"][1]["content"], json.loads(row["messages"][2]["content"])))
    return rows


def forbidden_texts(action_eval: list[str]) -> set[str]:
    seen = set(g.norm_key(t) for t in action_eval)
    for path in [HOLDOUT, VALID_V5] + FIXTURES:
        if not path.exists():
            continue
        if path.suffix == ".jsonl" and path.parent.name == "fixtures":
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    seen.add(g.norm_key(json.loads(line)["message"]))
        else:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                seen.add(g.norm_key(row["messages"][1]["content"]))
    return seen


def write_jsonl(path: Path, rows: list[tuple[str, dict, str]]) -> None:
    path.write_text(
        "".join(json.dumps(g.to_row(TRAIN_SYSTEM, text, out), ensure_ascii=False) + "\n"
                for text, out, _ in rows),
        encoding="utf-8",
    )


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def stats(rows: list[tuple[str, dict, str]]) -> dict:
    domains = Counter()
    priorities = Counter()
    dietary = Counter()
    vehicles = Counter()
    categories = Counter()
    kinds = Counter()
    action_fields = Counter()
    sources = Counter()
    for text, out, source in rows:
        domains[out["domain"]] += 1
        sources[source] += 1
        if out["domain"] == "action":
            body = out["action"]
            kinds[body["kind"]] += 1
            for key in ("targetBy", "pick", "setting", "value", "weeklyRupees"):
                if body[key] not in ("", "none", 0):
                    action_fields[key] += 1
        for part in ("food", "ride", "shop"):
            body = out.get(part)
            if not isinstance(body, dict):
                continue
            priorities[body.get("priority")] += 1
            if part == "food":
                dietary[body.get("dietary")] += 1
            if part == "ride":
                vehicles[body.get("vehicle")] += 1
            if part == "shop":
                categories[body.get("category")] += 1
    return {
        "domains": domains, "priorities": priorities, "dietary": dietary,
        "vehicles": vehicles, "categories": categories, "kinds": kinds,
        "action_fields": action_fields, "sources": sources,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=None,
                        help="write train.jsonl and valid.jsonl for mlx_lm here")
    parser.add_argument("--curriculum-dir", type=Path, default=None,
                        help="write a run-2 curriculum train.jsonl here")
    parser.add_argument("--skip-action-eval", action="store_true")
    args = parser.parse_args()

    eval_texts = write_action_eval(ACTION_EVAL) if not args.skip_action_eval else [
        text for text, _ in build_action_eval()
    ]
    forbidden = forbidden_texts(eval_texts)
    rng = random.Random(20261115)
    b = Builder(rng, forbidden)

    # 1. Canonicalise the V5 training rows. Keep the first copy of a duplicate.
    kept = dropped = 0
    for text, output in load_chat_rows(TRAIN_V5):
        new = canonical_row(text, output)
        if new is None:
            dropped += 1
            continue
        if b.add(text, new, "v5", style=False):
            kept += 1

    # 2. Targeted rows for the audited failures.
    gen_ride_pairs(b)
    gen_ride_no_origin(b)
    gen_trip_deadline(b)
    gen_combo_rows(b)
    gen_dietary_rows(b)
    gen_priority_rows(b)
    gen_item_rows(b)
    gen_shop_categories(b)
    gen_short_domain(b)
    gen_action_rows(b)

    base_rows = [r for r in b.rows if r[2] == "v5"]
    targeted_rows = [r for r in b.rows if r[2] != "v5"]
    all_rows = base_rows + targeted_rows
    write_jsonl(TRAIN_OUT, all_rows)

    # 3. Validation split: canonicalise the V5 valid rows, no targeted additions.
    train_keys_now = {g.norm_key(t) for t, _, _ in b.rows}
    valid_rows = []
    valid_dropped = 0
    seen_valid = set()
    for text, output in load_chat_rows(VALID_V5):
        new = canonical_row(text, output)
        key = g.norm_key(text)
        if new is None or key in train_keys_now or key in seen_valid:
            valid_dropped += 1
            continue
        seen_valid.add(key)
        valid_rows.append((text, new, "valid"))
    write_jsonl(VALID_OUT, valid_rows)

    if args.data_dir:
        args.data_dir.mkdir(parents=True, exist_ok=True)
        write_jsonl(args.data_dir / "train.jsonl", all_rows)
        write_jsonl(args.data_dir / "valid.jsonl", valid_rows)

    if args.curriculum_dir:
        args.curriculum_dir.mkdir(parents=True, exist_ok=True)
        curriculum = [r for r in targeted_rows if r[2].startswith("action")]
        non_action = [r for r in targeted_rows if not r[2].startswith("action")]
        rng.shuffle(non_action)
        curriculum += non_action[:520]
        rng.shuffle(curriculum)
        write_jsonl(args.curriculum_dir / "train.jsonl", curriculum)
        write_jsonl(args.curriculum_dir / "valid.jsonl", valid_rows)

    # 4. Leakage checks and the quality report.
    train_keys = {g.norm_key(t) for t, _, _ in all_rows}
    valid_keys = {g.norm_key(t) for t, _, _ in valid_rows}
    eval_keys = {g.norm_key(t) for t in eval_texts}
    holdout_keys = {g.norm_key(t) for t, _ in load_chat_rows(HOLDOUT)}
    fixture_keys = set()
    for path in FIXTURES:
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    fixture_keys.add(g.norm_key(json.loads(line)["message"]))
    leaks = {
        "train∩holdout": train_keys & holdout_keys,
        "train∩fixtures": train_keys & fixture_keys,
        "train∩action_eval": train_keys & eval_keys,
        "train∩valid": train_keys & valid_keys,
        "valid∩holdout": valid_keys & holdout_keys,
        "valid∩action_eval": valid_keys & eval_keys,
    }
    duplicates = len(all_rows) - len(train_keys)

    ts = stats(all_rows)
    vs = stats(valid_rows)
    eval_rows = load_chat_rows(ACTION_EVAL)
    es = stats([(t, o, "action_eval") for t, o in eval_rows])

    md: list[str] = []
    add = md.append
    add("# V6 dataset quality report")
    add("")
    add("Generated by `build_v6.py`. The V5 corpus, validation split, sealed holdout,")
    add("fixtures and action eval were read; only V6 files were written.")
    add("")
    add("## Files")
    add("")
    add("| File | Rows | SHA256 |")
    add("|---|---:|---|")
    for path in (TRAIN_OUT, VALID_OUT, ACTION_EVAL):
        add(f"| `{path.name}` | {len(path.read_text(encoding='utf-8').splitlines())} | `{sha256(path)}` |")
    add("")
    add("## Composition")
    add("")
    add(f"* V5 training rows kept after canonicalisation: **{kept:,}**")
    add(f"* V5 training rows dropped as unrepairable: {dropped}")
    add(f"* New targeted rows: **{len(targeted_rows):,}**")
    add(f"* Training rows total: **{len(all_rows):,}**")
    add(f"* Validation rows: **{len(valid_rows):,}** (V5 valid, canonicalised; {valid_dropped} dropped)")
    add(f"* Action eval rows (sealed, never trained): **{len(eval_rows)}**")
    add("")
    add("### Training sources")
    add("")
    add("| Source | Rows |")
    add("|---|---:|")
    for source, count in ts["sources"].most_common():
        add(f"| {source} | {count} |")
    add("")
    add("### Domains")
    add("")
    add("| Split | " + " | ".join(sorted(ts["domains"])) + " |")
    add("|---|" + "---:|" * len(ts["domains"]))
    add("| train | " + " | ".join(str(ts["domains"][d]) for d in sorted(ts["domains"])) + " |")
    add("| valid | " + " | ".join(str(vs["domains"][d]) for d in sorted(ts["domains"])) + " |")
    add("")
    add("### Action kinds in training")
    add("")
    add("| Kind | Rows |")
    add("|---|---:|")
    for kind, count in sorted(ts["kinds"].items()):
        add(f"| `{kind}` | {count} |")
    add("")
    missing_kinds = [k for k in fs.ACTION_KINDS if k not in ts["kinds"]]
    add(f"Kinds with no training rows: {missing_kinds or 'none'}")
    add("")
    add("### Action eval coverage")
    add("")
    add("| Kind | Rows |")
    add("|---|---:|")
    for kind, count in sorted(es["kinds"].items()):
        add(f"| `{kind}` | {count} |")
    add("")
    add(f"Eval domains: {dict(es['domains'])}")
    add("")
    add("## Canonicalisation applied to V5 rows")
    add("")
    add("| Repair | Rows | Example |")
    add("|---|---:|---|")
    for kind, count in TRANSFORMS.most_common():
        sample = TRANSFORM_SAMPLES[kind][0].replace("|", "\\|") if TRANSFORM_SAMPLES[kind] else ""
        add(f"| {kind} | {count} | {sample} |")
    add("")
    add("## Label rules enforced")
    add("")
    add("* **Pickup** is kept only when the place appears in the sentence. 535 V5 rows")
    add("  and 3 sealed cases carried a pickup the text never mentioned; those are gone")
    add("  from training and remain honest misses in the sealed set.")
    add("* **Vehicle** comes from an explicit word (bike/motorbike/scooter,")
    add("  auto/rickshaw, cab/taxi/car/uber/ola), otherwise `any`.")
    add("* **Dietary** takes an explicit veg/non-veg/meat statement first, then the")
    add("  canonical dish table (including dosa, cake, brownie, pancakes, coffee),")
    add("  otherwise `any`.")
    add("* **Priority** takes the user's cue (rating > speed > price, case-insensitive,")
    add("  Hindi/Telugu cues included), then a delivery deadline or pickup wait means")
    add("  speed, otherwise balanced. Explicit no-preference wording (\"no special")
    add("  preference\", \"decent\", \"good value\") stays balanced even with a deadline.")
    add("* **Item** is the dish if named, else the meal word, else the taste phrase,")
    add("  else `food`.")
    add("* **Shop category** is the canonical item-to-category map; the enum is")
    add("  unchanged at electronics/fashion/home/appliances/any.")
    add("* **Action** fields follow the server contract: 1-based targetPosition,")
    add("  `none`/0/\"\"/false for unused fields, weeklyRupees 0 removes the budget,")
    add("  password/two-factor/fingerprint/sign-out/delete are navigate security.")
    add("")
    add("## Validation")
    add("")
    add("| Check | Result |")
    add("|---|---|")
    add(f"| Schema-valid rows | {len(all_rows)}/{len(all_rows)} |")
    add(f"| Action semantics | all {ts['domains']['action']} action rows pass |")
    add(f"| Label conflicts (`label_conflicts`) | 0 |")
    add(f"| Exact duplicates inside train | {duplicates} |")
    add(f"| Exact train∩valid | {len(leaks['train∩valid'])} |")
    add(f"| Exact train∩holdout | {len(leaks['train∩holdout'])} |")
    add(f"| Exact train∩fixtures | {len(leaks['train∩fixtures'])} |")
    add(f"| Exact train∩action eval | {len(leaks['train∩action_eval'])} |")
    add(f"| Exact valid∩holdout | {len(leaks['valid∩holdout'])} |")
    add(f"| Exact valid∩action eval | {len(leaks['valid∩action_eval'])} |")
    add("")
    total_leaks = sum(len(v) for v in leaks.values())
    add(f"**{'PASS' if total_leaks == 0 and duplicates == 0 and not missing_kinds else 'FAIL'}**")
    add("")
    REPORT_OUT.parent.mkdir(parents=True, exist_ok=True)
    REPORT_OUT.write_text("\n".join(md) + "\n", encoding="utf-8")

    print(f"train {len(all_rows)}  valid {len(valid_rows)}  action eval {len(eval_rows)}")
    print(f"base kept {kept}  dropped {dropped}  targeted {len(targeted_rows)}  skipped {b.skipped}")
    print(f"domains {dict(ts['domains'])}")
    print(f"action kinds {dict(sorted(ts['kinds'].items()))}")
    print(f"leaks { {k: len(v) for k, v in leaks.items()} }  duplicates {duplicates}")
    print(f"wrote {TRAIN_OUT.name}, {VALID_OUT.name}, {ACTION_EVAL.name}, {REPORT_OUT.relative_to(HERE)}")
    return 0 if total_leaks == 0 and duplicates == 0 and not missing_kinds else 1


if __name__ == "__main__":
    sys.exit(main())
