#!/usr/bin/env python3
"""Phase 14: composition and imbalance report for the V7 dataset.

    python data/v7/distribution_v7.py

Writes data/v7/reports/v7_distribution.json and .md from the built splits.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import v7_lib as L
import validate_dataset as vd
import token_preflight_v7 as TP

HERE = Path(__file__).resolve().parent
REPORTS = HERE / "reports"
SPLITS = {
    "train": HERE / "train_v7.jsonl",
    "valid": HERE / "valid_v7.jsonl",
    "eval": HERE / "validation/v7_validation.jsonl",
}
FIXED_SPLITS = {
    "train": HERE.parent / "v7_fixed/train_v7.jsonl",
    "valid": HERE.parent / "v7_fixed/valid_v7.jsonl",
    "eval": HERE.parent / "v7_fixed/validation/v7_validation.jsonl",
}
SHORT = L.SYSTEMS["short"]
V6 = L.SYSTEMS["v6"]
PROD = L.SYSTEMS["prod"]
SYSTEM_TEXTS = {"v6": V6, "prod": PROD, "short": SHORT}


def load(path: Path) -> list[dict]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            msgs = row["messages"]
            out.append({
                "system": msgs[0]["content"],
                "text": msgs[1]["content"],
                "output": json.loads(msgs[2]["content"]),
            })
    return out


def share(counter: Counter, total: int) -> dict:
    return {k: {"count": v, "share": round(v / total, 4) if total else 0.0}
            for k, v in counter.most_common()}


def analyse(rows: list[dict]) -> dict:
    total = len(rows)
    domains = Counter(r["output"]["domain"] for r in rows)
    systems = Counter(next((name for name, text in SYSTEM_TEXTS.items()
                            if r["system"] == text), "unknown") for r in rows)
    priority = Counter()
    priority_by_domain: dict[str, Counter] = {}
    vehicle = Counter()
    dietary = Counter()
    category = Counter()
    actions = Counter()
    food_fields = Counter()
    ride_fields = Counter()
    shop_fields = Counter()
    food_items, ride_drops, shop_items, dishes = set(), set(), set(), set()
    for r in rows:
        out = r["output"]
        dom = out["domain"]
        if dom in ("food", "shop"):
            body = out[dom]
            priority[body["priority"]] += 1
            priority_by_domain.setdefault(dom, Counter())[body["priority"]] += 1
            if body.get("budgetPaise") is not None:
                (food_fields if dom == "food" else shop_fields)["budget"] += 1
        if dom == "food":
            food_fields["total"] += 1
            food_fields["dietary_any"] += body["dietary"] == "any"
            food_fields["dietary_veg"] += body["dietary"] == "veg"
            food_fields["dietary_nonveg"] += body["dietary"] == "nonveg"
            if body.get("maxEtaMinutes") is not None:
                food_fields["eta"] += 1
            dietary[body["dietary"]] += 1
            food_items.add(body["item"].lower())
            dishes.add(body["item"].lower())
        elif dom == "ride":
            body = out["ride"]
            priority[body["priority"]] += 1
            priority_by_domain.setdefault("ride", Counter())[body["priority"]] += 1
            ride_fields["total"] += 1
            ride_fields["pickup"] += body.get("pickup") is not None
            ride_fields["budget"] += body.get("budgetPaise") is not None
            ride_fields["wait"] += body.get("maxPickupMinutes") is not None
            ride_fields["schedule"] += body.get("scheduleAt") is not None
            vehicle[body["vehicle"]] += 1
            ride_drops.add(body["drop"].lower())
        elif dom == "shop":
            shop_fields["total"] += 1
            category[out["shop"]["category"]] += 1
            shop_items.add(out["shop"]["item"].lower())
        elif dom == "action":
            actions[out["action"]["kind"]] += 1
        elif dom == "combo":
            for part in ("food", "ride"):
                body = out[part]
                priority[body["priority"]] += 1
                priority_by_domain.setdefault(part, Counter())[body["priority"]] += 1
            if out["food"].get("budgetPaise") is not None:
                food_fields["budget"] += 1
            if out["ride"].get("budgetPaise") is not None:
                ride_fields["budget"] += 1
            vehicle[out["ride"]["vehicle"]] += 1
            ride_drops.add(out["ride"]["drop"].lower())
            food_items.add(out["food"]["item"].lower())

    prefix = Counter(" ".join(vd.norm_text(r["text"]).split()[:4]) for r in rows)
    heavy_prefix = {k: v for k, v in prefix.most_common(15) if v > 40}
    return {
        "rows": total,
        "domains": share(domains, total),
        "systems": share(systems, total),
        "primary_priority": share(priority, sum(priority.values())),
        "priority_by_domain": {d: share(c, sum(c.values()))
                               for d, c in priority_by_domain.items()},
        "ride_vehicle": share(vehicle, sum(vehicle.values())),
        "food_dietary": share(dietary, sum(dietary.values())),
        "shop_category": share(category, sum(category.values())),
        "action_kinds": share(actions, sum(actions.values())),
        "field_rates": {
            "food": {k: (round(v / food_fields["total"], 4) if k != "total" else v)
                     for k, v in food_fields.items()},
            "ride": {k: (round(v / ride_fields["total"], 4) if k != "total" else v)
                     for k, v in ride_fields.items()},
            "shop": {k: (round(v / shop_fields["total"], 4) if k != "total" else v)
                     for k, v in shop_fields.items()},
        },
        "coverage": {
            "distinct_food_items": len(food_items),
            "distinct_ride_drops": len(ride_drops),
            "distinct_shop_items": len(shop_items),
        },
        "template_redundancy": {
            "distinct_4gram_prefixes": len(prefix),
            "prefixes_used_more_than_40_times": heavy_prefix,
        },
    }


def flags(train: dict) -> list[dict]:
    out: list[dict] = []

    def add(name: str, ok: bool, detail) -> None:
        out.append({"flag": name, "ok": bool(ok), "detail": detail})

    dom = train["domains"]
    add("food_domain_share", dom.get("food", {}).get("share", 0) <= 0.45, dom.get("food"))
    add("ride_domain_share", dom.get("ride", {}).get("share", 0) <= 0.45, dom.get("ride"))
    action_share = dom.get("action", {}).get("share", 0)
    add("action_domain_share", 0.08 <= action_share <= 0.18, dom.get("action"))
    add("combo_domain_present", dom.get("combo", {}).get("share", 0) >= 0.02, dom.get("combo"))
    add("oos_domain_present", dom.get("out_of_scope", {}).get("share", 0) >= 0.02,
        dom.get("out_of_scope"))
    add("greeting_domain_present", dom.get("greeting", {}).get("share", 0) >= 0.015,
        dom.get("greeting"))
    short_share = train["systems"].get("short", {}).get("share", 0)
    add("short_prompt_share", short_share >= 0.08, train["systems"].get("short"))
    veh = train["ride_vehicle"]
    any_share = veh.get("any", {}).get("share", 0)
    add("vehicle_any_share", 0.30 <= any_share <= 0.55, veh.get("any"))
    add("vehicle_cab_share", veh.get("cab", {}).get("share", 0) <= 0.55, veh.get("cab"))
    add("vehicle_bike_present", veh.get("bike", {}).get("share", 0) >= 0.05, veh.get("bike"))
    diet = train["food_dietary"]
    veg, nonveg = (diet.get("veg", {}).get("share", 0), diet.get("nonveg", {}).get("share", 0))
    add("dietary_veg_nonveg_ratio", (veg / nonveg if nonveg else 99) <= 3.0,
        {"veg": veg, "nonveg": nonveg})
    prio = train["primary_priority"]
    add("priority_balanced_share", prio.get("balanced", {}).get("share", 0) <= 0.80,
        prio.get("balanced"))
    for key in ("price", "rating", "speed"):
        add(f"priority_{key}_present", prio.get(key, {}).get("share", 0) >= 0.03, prio.get(key))
    add("shop_categories_covered", len(train["shop_category"]) == 5,
        list(train["shop_category"]))
    add("all_action_kinds_present", len(train["action_kinds"]) == 18,
        {"kinds": len(train["action_kinds"])})
    add("template_prefix_redundancy", len(train["template_redundancy"]
                                           ["prefixes_used_more_than_40_times"]) <= 10,
        train["template_redundancy"]["prefixes_used_more_than_40_times"])
    return out


def holdout_priority() -> dict:
    """Read-only reference: the sealed holdout's own priority mix.

    Recorded for transparency only. The training mix is not steered to match it;
    doing so would fit the dataset to the evaluation set.
    """
    counts: Counter = Counter()
    for line in L.SEALED_HOLDOUT.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        out = json.loads(json.loads(line)["messages"][2]["content"])
        for part in ("food", "ride", "shop"):
            body = out.get(part)
            if isinstance(body, dict) and "priority" in body:
                counts[body["priority"]] += 1
    total = sum(counts.values())
    return {k: {"count": c, "share": round(c / total, 4) if total else 0.0}
            for k, c in counts.most_common()}


def md(report: dict) -> str:
    t = report["train"]
    title = ("FLOUNA V7 fixed dataset distribution"
             if report.get("dataset") == "v7_fixed" else "FLOUNA V7 dataset distribution")
    lines = [
        f"# {title}",
        "",
        f"Generated {report['generated_at']}. Train rows: **{t['rows']}**; "
        f"valid rows: {report['valid']['rows']}; private eval rows: {report['eval']['rows']}.",
        "",
        "## Domains (train)",        "",
        "| domain | rows | share |",
        "|---|---|---|",
    ]
    for k, v in t["domains"].items():
        lines.append(f"| {k} | {v['count']} | {v['share']:.2%} |")
    lines += ["", "## System prompts (train)", "", "| prompt | rows | share |", "|---|---|---|"]
    for k, v in t["systems"].items():
        lines.append(f"| {k} | {v['count']} | {v['share']:.2%} |")
    lines += ["", "## Priority (train, per search part)", ""]
    for dom, counts in t["priority_by_domain"].items():
        parts = ", ".join(f"{k} {v['share']:.1%}" for k, v in counts.items())
        lines.append(f"- {dom}: {parts}")
    hp = report.get("holdout_priority_reference", {})
    if hp:
        lines.append("")
        lines.append("Sealed holdout reference (read-only, not used to tune the mix): " +
                     ", ".join(f"{k} {v['share']:.1%}" for k, v in hp.items()) +
                     ". Training carries more balanced labels because most corpus "
                     "sentences have no priority cue; cue-bearing rows are expanded, "
                     "not resampled to match the holdout.")
    lines += ["", "## Label coverage (train)", ""]
    for dom, rates in t["field_rates"].items():
        parts = ", ".join(f"{k} {v:.1%}" for k, v in rates.items() if k != "total")
        lines.append(f"- {dom} ({rates['total']} rows): {parts}")
    lines += ["", "## Ride vehicles", "",
              ", ".join(f"{k} {v['share']:.1%}" for k, v in t["ride_vehicle"].items())]
    lines += ["", "## Food dietary", "",
              ", ".join(f"{k} {v['share']:.1%}" for k, v in t["food_dietary"].items())]
    lines += ["", "## Action kinds", "",
              ", ".join(f"{k} {v['count']}" for k, v in t["action_kinds"].items())]
    lines += ["", "## Entity coverage", "",
              f"- distinct food items: {t['coverage']['distinct_food_items']}",
              f"- distinct ride drops: {t['coverage']['distinct_ride_drops']}",
              f"- distinct shop items: {t['coverage']['distinct_shop_items']}",
              f"- distinct 4-gram text prefixes: {t['template_redundancy']['distinct_4gram_prefixes']}"]
    lines += ["", "## Imbalance flags", "", "| flag | status | detail |", "|---|---|---|"]
    for f in report["imbalance_flags"]:
        lines.append(f"| {f['flag']} | {'OK' if f['ok'] else 'FLAG'} | {json.dumps(f['detail'], ensure_ascii=False)} |")
    lines += ["", f"Overall: **{'no flags' if all(f['ok'] for f in report['imbalance_flags']) else 'review flags above'}**."]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", choices=["v7", "v7_fixed"], default="v7")
    args = parser.parse_args()
    splits = SPLITS
    suffix = ""
    if args.dataset == "v7_fixed":
        splits = FIXED_SPLITS
        SYSTEM_TEXTS.clear()
        SYSTEM_TEXTS.update({"v6": V6, "prod_compact": TP.compact_prompt(), "short": SHORT})
        suffix = "_fixed"
    data = {name: analyse(load(path)) for name, path in splits.items()}
    report = {
        "phase": 14,
        "dataset": args.dataset,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "train": data["train"],
        "valid": data["valid"],
        "eval": data["eval"],
    }
    report["imbalance_flags"] = flags(data["train"])
    report["holdout_priority_reference"] = holdout_priority()
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / f"v7_distribution{suffix}.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (REPORTS / f"v7_distribution{suffix}.md").write_text(md(report), encoding="utf-8")

    print("train rows", data["train"]["rows"])
    print("domains:", {k: v["share"] for k, v in data["train"]["domains"].items()})
    print("vehicles:", {k: v["share"] for k, v in data["train"]["ride_vehicle"].items()})
    print("dietary:", {k: v["share"] for k, v in data["train"]["food_dietary"].items()})
    bad = [f for f in report["imbalance_flags"] if not f["ok"]]
    print("flags:", "none" if not bad else json.dumps(bad, ensure_ascii=False))
    print("wrote", REPORTS / f"v7_distribution{suffix}.json", "and .md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
