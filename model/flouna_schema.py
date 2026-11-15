"""Shared schema, parsing and scoring helpers for the Flouna intent model."""
from __future__ import annotations

import json
import re

DOMAINS = ("food", "ride", "shop", "combo", "greeting", "out_of_scope")
PRIORITIES = ("price", "rating", "speed", "balanced")
DIETARY = ("veg", "nonveg", "any")
VEHICLES = ("bike", "auto", "cab", "any")
CATEGORIES = ("electronics", "fashion", "home", "appliances", "any")

ENUM_FIELDS = {
    "domain": DOMAINS,
    "priority": PRIORITIES,
    "dietary": DIETARY,
    "vehicle": VEHICLES,
    "category": CATEGORIES,
}

FOOD_FIELDS = {
    "item": str,
    "budgetPaise": (int, float, type(None)),
    "maxEtaMinutes": (int, float, type(None)),
    "dietary": str,
    "priority": str,
}
RIDE_FIELDS = {
    "pickup": (str, type(None)),
    "drop": str,
    "vehicle": str,
    "budgetPaise": (int, float, type(None)),
    "maxPickupMinutes": (int, float, type(None)),
    "priority": str,
    "scheduleAt": (str, type(None)),
}
SHOP_FIELDS = {
    "item": str,
    "budgetPaise": (int, float, type(None)),
    "category": str,
    "priority": str,
}

SCHEDULE_RE = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")

ROOT_ALLOWED = {"domain", "reply", "food", "ride", "shop"}
PART_FIELDS = {"food": FOOD_FIELDS, "ride": RIDE_FIELDS, "shop": SHOP_FIELDS}
FLAT_KEYS = {
    "item", "budgetPaise", "maxEtaMinutes", "maxPickupMinutes", "dietary",
    "priority", "pickup", "drop", "vehicle", "scheduleAt", "category",
}


def _type_ok(value, expected) -> bool:
    if expected is (str, type(None)):
        return value is None or isinstance(value, str)
    if expected is str:
        return isinstance(value, str)
    if isinstance(expected, tuple):
        if isinstance(value, bool):
            return False
        return isinstance(value, expected)
    return isinstance(value, expected)


def _number_ok(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0


def validate_intent(obj: object, require_part: bool = True) -> list[str]:
    """Return the schema errors for one model answer. Empty means valid."""
    errors: list[str] = []
    if not isinstance(obj, dict):
        return [f"root is {type(obj).__name__}, expected object"]

    extra = set(obj) - ROOT_ALLOWED
    if extra:
        errors.append(f"unexpected root keys: {sorted(extra)}")
    flat = set(obj) & FLAT_KEYS
    if flat:
        errors.append(f"flat fields at root: {sorted(flat)}")

    domain = obj.get("domain")
    if domain not in DOMAINS:
        errors.append(f"domain {domain!r} not in {DOMAINS}")
    if not isinstance(obj.get("reply"), str):
        errors.append("reply must be a string")

    if require_part and domain == "food" and not isinstance(obj.get("food"), dict):
        errors.append("food object missing")
    if require_part and domain == "ride" and not isinstance(obj.get("ride"), dict):
        errors.append("ride object missing")
    if require_part and domain == "shop" and not isinstance(obj.get("shop"), dict):
        errors.append("shop object missing")
    if require_part and domain == "combo":
        if not isinstance(obj.get("food"), dict):
            errors.append("combo food object missing")
        if not isinstance(obj.get("ride"), dict):
            errors.append("combo ride object missing")

    for part, fields in PART_FIELDS.items():
        value = obj.get(part)
        if value is None:
            continue
        if not isinstance(value, dict):
            errors.append(f"{part} must be an object")
            continue
        unknown = set(value) - set(fields)
        if unknown:
            errors.append(f"{part} has unexpected keys: {sorted(unknown)}")
        missing = set(fields) - set(value)
        if missing:
            errors.append(f"{part} missing keys: {sorted(missing)}")
        for key, expected in fields.items():
            if key not in value:
                continue
            got = value[key]
            if key in ("budgetPaise", "maxEtaMinutes", "maxPickupMinutes"):
                if got is not None and not _number_ok(got):
                    errors.append(f"{part}.{key} must be a non-negative number or null")
            elif not _type_ok(got, expected):
                errors.append(f"{part}.{key} has type {type(got).__name__}")
        for key, allowed in ENUM_FIELDS.items():
            if key in value and value[key] not in allowed:
                errors.append(f"{part}.{key} {value[key]!r} not in {allowed}")
        if part == "ride" and isinstance(value.get("scheduleAt"), str):
            if not SCHEDULE_RE.match(value["scheduleAt"]):
                errors.append(f"ride.scheduleAt {value['scheduleAt']!r} is not HH:mm")
    return errors


def parse_json_response(text: str):
    """Parse the first JSON object in a model answer. Returns (obj, error)."""
    if not isinstance(text, str):
        return None, f"answer is {type(text).__name__}, expected string"
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.I)
        t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t), None
    except json.JSONDecodeError:
        pass
    start = t.find("{")
    if start < 0:
        return None, "no JSON object in answer"
    try:
        obj, _ = json.JSONDecoder().raw_decode(t[start:])
        return obj, None
    except json.JSONDecodeError as exc:
        return None, f"JSON parse error: {exc}"


def _norm(value) -> str:
    return re.sub(r"\s+", " ", str(value)).strip().lower()


def _string_match(want: str, got: str, field: str) -> bool:
    if field in ENUM_FIELDS or field == "scheduleAt":
        return _norm(want) == _norm(got)
    return _norm(want) in _norm(got) or _norm(got) in _norm(want)


def compare_expected(expected: dict, actual: dict | None) -> list[dict]:
    """Compare only the fields the case asserts, like the repo harness.

    Free-text fields (item, drop, pickup) match by containment; enums by exact
    value. A missing sub-object fails every asserted field inside it, which is
    what catches the flat-schema failure.
    """
    results: list[dict] = []
    if not isinstance(actual, dict):
        actual = {}

    for key, want in expected.items():
        if key == "reply":
            continue
        if isinstance(want, dict):
            got = actual.get(key)
            if not isinstance(got, dict):
                for sub, sub_want in want.items():
                    results.append({"field": f"{key}.{sub}", "want": sub_want, "got": None, "ok": False})
                continue
            for sub, sub_want in want.items():
                got_v = got.get(sub)
                if sub_want is None:
                    ok = got_v is None
                elif isinstance(sub_want, (int, float)) and not isinstance(sub_want, bool):
                    ok = isinstance(got_v, (int, float)) and not isinstance(got_v, bool) and got_v == sub_want
                elif isinstance(sub_want, str):
                    ok = isinstance(got_v, str) and _string_match(sub_want, got_v, sub)
                else:
                    ok = got_v == sub_want
                results.append({"field": f"{key}.{sub}", "want": sub_want, "got": got_v, "ok": ok})
            continue

        got = actual.get(key)
        if want is None:
            ok = got is None
        elif isinstance(want, str):
            ok = isinstance(got, str) and _string_match(want, got, key)
        else:
            ok = got == want
        results.append({"field": key, "want": want, "got": got, "ok": ok})
    return results


def part_key(expected: dict) -> str | None:
    for key in ("food", "ride", "shop"):
        if isinstance(expected.get(key), dict):
            return key
    return None


_NUM = r"\d{2,7}(?!\d)"
MONEY_RE = re.compile(
    rf"(?:₹|rs\.?|inr|rupees?|rupaye)\s*{_NUM}"
    rf"|\b{_NUM}\s*(?:rupees?|rupaye|rs\b|₹)"
    rf"|(?:budget|spend|ceiling|total|at most|not more than)\D{{0,12}}{_NUM}"
    rf"|(?:under|below|max)\s+{_NUM}\s*(?!\s*(?:minutes?|mins?)\b)"
    rf"|\b{_NUM}\D{{0,8}}(?:tak|lopala|lopu|varaku|se kam|ke andar)\b",
    re.I,
)
ETA_RE = re.compile(r"\d+\s*(?:minutes?|mins?|min\b)|half an hour", re.I)
WAIT_RE = re.compile(r"\b(?:pickup|pick me up|come within|wait|reach me|driver|aao)\b", re.I)
# "arrive in 30 minutes" is a trip deadline, not a pickup wait.
TRIP_RE = re.compile(r"\b(?:arrive|reach)\b[^.]{0,30}\d+\s*(?:minutes?|mins?|min\b)", re.I)
SCHEDULE_TEXT_RE = re.compile(
    r"(?:\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b)"
    r"|(?:\b(?:at|by)\s+(?:[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:am|pm)\b)"
    r"|(?:\b(?:[1-9]|1[0-2]):[0-5]\d\s*(?:am|pm)\b)"
    r"|(?:\b(?:[1-9]|1[0-2])\s*(?:am|pm)\b)"
    r"|(?:\btonight at\s+(?:[1-9]|1[0-2])\b)",
    re.I,
)
TYPO_RE = re.compile(
    r"\b(?:ordr|cheep|fst|bset|ned|bok|piza|burge|chiken|minit|rupeez|plz|quik)\b", re.I
)


def text_evidence(text: str) -> dict[str, bool]:
    """Which constraint families a user message actually mentions."""
    return {
        "money": bool(MONEY_RE.search(text)),
        "eta": bool(ETA_RE.search(text)),
        "wait": bool(WAIT_RE.search(text)),
        "trip": bool(TRIP_RE.search(text)),
        "schedule": bool(SCHEDULE_TEXT_RE.search(text)),
        "typo": bool(TYPO_RE.search(text)),
    }


def label_conflicts(text: str, output: dict) -> list[str]:
    """Fields a sentence and its label disagree about. Empty means consistent."""
    ev = text_evidence(text)
    problems: list[str] = []
    if ev["typo"]:
        problems.append("injected typo")
    for part in ("food", "ride", "shop"):
        body = output.get(part)
        if not isinstance(body, dict):
            continue
        if body.get("budgetPaise") is not None and not ev["money"]:
            problems.append(f"{part}.budgetPaise set but no amount in text")
        if body.get("budgetPaise") is None and ev["money"]:
            problems.append(f"{part}.budgetPaise null but text states an amount")
        if part == "food":
            if body.get("maxEtaMinutes") is not None and not ev["eta"]:
                problems.append("food.maxEtaMinutes set but no delivery time in text")
            if body.get("maxEtaMinutes") is None and ev["eta"]:
                problems.append("food.maxEtaMinutes null but text states a delivery time")
        if part == "ride":
            if body.get("maxPickupMinutes") is not None and not ev["wait"]:
                problems.append("ride.maxPickupMinutes set but no pickup wait in text")
            if body.get("maxPickupMinutes") is None and ev["wait"]:
                problems.append("ride.maxPickupMinutes null but text states a pickup wait")
            if body.get("scheduleAt") is not None and not ev["schedule"]:
                problems.append("ride.scheduleAt set but no clock time in text")
            if body.get("scheduleAt") is None and ev["schedule"]:
                problems.append("ride.scheduleAt null but text states a clock time")
    return problems



def constraint_count(expected: dict) -> int:
    """How many independent constraints a case asserts (for slicing metrics)."""
    count = 0
    part = part_key(expected)
    if not part:
        return 0
    body = expected[part]
    if body.get("budgetPaise") is not None:
        count += 1
    if body.get("maxEtaMinutes") is not None or body.get("maxPickupMinutes") is not None:
        count += 1
    if body.get("dietary") in ("veg", "nonveg"):
        count += 1
    if body.get("priority") not in (None, "balanced"):
        count += 1
    if body.get("scheduleAt") is not None:
        count += 1
    if body.get("item") or body.get("drop"):
        count += 0
    return count
