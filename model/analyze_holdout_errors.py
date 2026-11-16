#!/usr/bin/env python3
"""Explain every sealed-holdout failure V5 made, and audit the labels.

    python analyze_holdout_errors.py

Reads, changes nothing:
  results/v5_final.jsonl   V5 predictions (382 holdout rows)
  eval_mlx_v5.jsonl        the sealed holdout itself (for the user text)

Writes:
  results/v5_holdout_errors.jsonl        one machine-readable record per miss
  results/v5_holdout_error_analysis.md   the human review, including the
                                         label-consistency audit (A/B/C/D)

The per-case category and label ruling are curated by hand below, after
reading all 38 misses. They are not inferred at runtime: the point of the
file is the judgement, not the diffing. The diff itself is computed with the
same compare_expected() the evaluator uses, so the fields listed here are
exactly the fields the harness scored wrong.
"""
from __future__ import annotations

import json
from pathlib import Path

import flouna_schema as fs

HERE = Path(__file__).resolve().parent
PREDICTIONS = HERE / "results/v5_final.jsonl"
HOLDOUT = HERE / "eval_mlx_v5.jsonl"
OUT_JSONL = HERE / "results/v5_holdout_errors.jsonl"
OUT_MD = HERE / "results/v5_holdout_error_analysis.md"
TOTAL = 382

# A = correct label for the input under the FLOUNA contract.
# B = incorrect label: the text does not support it.
# C = ambiguous: more than one defensible reading, or the generator used hidden
#     state the text cannot show.
# D = insufficient information: the input cannot support any label.
ANNOTATIONS = {
    "holdout-4": dict(
        category="item_convention",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="The request names a meal, not a dish. The holdout label keeps "
              "'lunch' as the item; V5 copied the filler word 'something'.",
        decision="Teach the item precedence meal noun > taste phrase > dietary-only "
                 "word > 'food'. No holdout change.",
    ),
    "holdout-12": dict(
        category="dietary_dish_implied",
        consistency="B",
        causes=["dataset"],
        fixable=False,
        notes="'dosa' is veg in the corpus dish convention, but the handcrafted "
              "holdout table falls back to 'any' because the ingredient list has "
              "'masala dosa' and 'plain dosa' but not bare 'dosa'. V5 output veg, "
              "which is the corpus-consistent label.",
        decision="Extend the canonical dish map with 'dosa' -> veg and keep the "
                 "rule that the map supplies implied dietary. The sealed label is "
                 "left untouched and this case is expected to stay a miss.",
    ),
    "holdout-14": dict(
        category="domain_short_request",
        consistency="C",
        causes=["dataset", "model", "production_prompt"],
        fixable=True,
        notes="'fastest option' names no object. In a food-first app the sealed "
              "set reads it as food/speed; a ride reading is also defensible. V5 "
              "fell back to out_of_scope.",
        decision="Teach the app default: a bare speed or price ask with no object "
                 "is food with item 'food'. Keep the sealed label as-is.",
    ),
    "holdout-15": dict(
        category="domain_short_request",
        consistency="C",
        causes=["dataset", "model", "production_prompt"],
        fixable=True,
        notes="'I don't want to wait' names no object. The sealed set reads it as "
              "food/speed; V5 returned out_of_scope.",
        decision="Same app-default rule as holdout-14: no object means food, and "
                 "wait-aversion is a speed cue.",
    ),
    "holdout-19": dict(
        category="item_convention",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="A dietary adjective is not a dish. The label says item 'food' and "
              "dietary nonveg; V5 made the adjective the item.",
        decision="Teach item 'food' when the only content is a dietary word.",
    ),
    "holdout-22": dict(
        category="item_convention",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="Same as holdout-19 for 'pure veg options'.",
        decision="Same dietary-only rule; item stays 'food'.",
    ),
    "holdout-36": dict(
        category="greeting_app_smalltalk",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="The production contract defines greeting as small talk about the "
              "app itself. 'how do you actually work' is exactly that; V5 sent it "
              "to out_of_scope.",
        decision="Add unseen paraphrases of app small talk, not the sealed text.",
    ),
    "holdout-60": dict(
        category="priority_cue_missed",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'badhiya' is in the corpus rating cue list, next to 'best' and "
              "'top-rated'. V5 chose speed.",
        decision="Add Hindi/Urdu rating cue coverage in mixed sentences.",
    ),
    "holdout-83": dict(
        category="priority_eta_convention_conflict",
        consistency="C",
        causes=["dataset"],
        fixable=False,
        notes="Budget + delivery deadline, no priority word. The label is balanced, "
              "while holdout-336 has the same surface (amount + deadline, no cue) "
              "and is labelled speed. The generator decided speed only when no "
              "priority had been sampled, and that hidden state is not in the text.",
        decision="Adopt the corpus-majority rule (deadline with no explicit priority "
                 "-> speed; 713 speed vs 205 balanced among ETA-only training rows). "
                 "This case is mathematically unlearnable and is expected to stay a "
                 "miss. The sealed label is not rewritten.",
    ),
    "holdout-106": dict(
        category="priority_eta_convention_conflict",
        consistency="C",
        causes=["dataset"],
        fixable=False,
        notes="Delivery deadline with no priority word, labelled balanced, the same "
              "contradiction as holdout-83.",
        decision="Same as holdout-83: follow the majority convention, accept the miss.",
    ),
    "holdout-142": dict(
        category="dietary_dish_implied",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="Dish map says pancakes are veg; V5 fell back to any.",
        decision="Train the full dish map, including desserts and drinks, across "
                 "delivery shells in Hindi and English.",
    ),
    "holdout-154": dict(
        category="priority_cue_casing",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'SASTA' is the price cue 'sasta' in capitals. V5 output balanced, so "
              "the cue was lost, not the casing of the label.",
        decision="Include uppercase and mixed-case cue variants in training. Labels "
                 "stay canonical lowercase; no runtime post-processing is added.",
    ),
    "holdout-165": dict(
        category="ride_from_to_parse",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'Gachibowli se Forum Mall tak' is origin then destination. V5 put "
              "the origin in drop and lost the pickup.",
        decision="Add X-se-Y-tak / from-X-to-Y pair extraction with trip deadlines "
                 "in the same sentence.",
    ),
    "holdout-169": dict(
        category="ride_phantom_pickup_label",
        consistency="B",
        causes=["dataset"],
        fixable=False,
        notes="There is no origin anywhere in the sentence, but the label carries "
              "pickup Secunderabad. This is the generator's 20% random pickup that "
              "the chosen shell omitted. The contract says pickup is null when not "
              "stated; V5's null was right and the benchmark marked it wrong.",
        decision="Never teach a pickup that is absent from the text. V6 will output "
                 "null and this case will remain a miss. Sealed label untouched.",
    ),
    "holdout-174": dict(
        category="ride_pickup_wait_missed",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'the cab should reach me in 4 minutes' is the pickup wait. V5 kept "
              "the budget and rating but dropped maxPickupMinutes.",
        decision="Add driver/cab-reaches-me phrasings as wait evidence.",
    ),
    "holdout-175": dict(
        category="ride_pickup_wait_missed",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'reach me in 8 minutes' is the pickup wait; V5 dropped it.",
        decision="Same pickup-wait coverage as holdout-174.",
    ),
    "holdout-183": dict(
        category="ride_pickup_wait_missed",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'the cab should reach me in 15 minutes' is the pickup wait; V5 "
              "dropped it.",
        decision="Same pickup-wait coverage.",
    ),
    "holdout-186": dict(
        category="ride_priority_wait",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="Boolean wait limit and no explicit priority word: the corpus rule is "
              "wait -> speed. V5 said balanced.",
        decision="Teach wait -> speed when no price/rating word is present.",
    ),
    "holdout-192": dict(
        category="ride_from_to_parse",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'SE ... TAK' in capitals is the same origin/destination pattern as "
              "holdout-165. V5 lost the pickup.",
        decision="Same pair extraction, with uppercase coverage.",
    ),
    "holdout-196": dict(
        category="ride_pickup_wait_missed",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'have the driver arrive within 10 minutes' is the pickup wait and "
              "implies speed. V5 dropped the wait and said balanced.",
        decision="Same wait phrasing and wait -> speed coverage.",
        fields_note="ride.maxPickupMinutes, ride.priority",
    ),
    "holdout-208": dict(
        category="ride_from_to_parse",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'lingampally se madhapur tak taxi' is origin/destination. V5 reversed "
              "them like holdout-165 and 192, though it did catch the wait.",
        decision="Same pair extraction; train the pair before the vehicle phrase.",
        fields_note="ride.pickup, ride.drop",
    ),
    "holdout-230": dict(
        category="ride_phantom_pickup_label",
        consistency="B",
        causes=["dataset"],
        fixable=False,
        notes="No origin in 'forum mall ke liye car chahiye'; the label carries "
              "Kothapet from the generator's hidden random pickup.",
        decision="Same as holdout-169: never train phantom pickups; expect the miss.",
    ),
    "holdout-231": dict(
        category="ride_phantom_pickup_label",
        consistency="B",
        causes=["dataset"],
        fixable=False,
        notes="No origin in 'GACHIBOWLI KE LIYE BEST AUTO RICKSHAW CHAHIYE'; the "
              "label carries Charminar from hidden generator state.",
        decision="Same as holdout-169: never train phantom pickups; expect the miss.",
    ),
    "holdout-239": dict(
        category="shop_category_enum",
        consistency="A",
        causes=["model", "schema"],
        fixable=True,
        notes="'office chair' belongs to home, one of the five existing categories. "
              "V5 invented 'furniture', which is outside the enum.",
        decision="Train the canonical item->category map and keep the enum unchanged. "
                 "No second schema and no new category.",
    ),
    "holdout-252": dict(
        category="priority_cue_missed",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'sasta' is a price cue; V5 said balanced on a shop row.",
        decision="Add price cues across shop nouns, including mixed-case and mixed "
                 "Hindi/English sentences.",
    ),
    "holdout-262": dict(
        category="priority_cue_missed",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="'manchi' is the Telugu rating cue in the corpus, next to 'best'. V5 "
              "said balanced.",
        decision="Add Telugu rating cue coverage.",
    ),
    "holdout-273": dict(
        category="combo_vehicle_label_noise",
        consistency="C",
        causes=["dataset", "model"],
        fixable=False,
        notes="No vehicle word in the sentence; the label picked cab at random. The "
              "dietary side (dahi puri -> veg) is correct and V5 missed it. So the "
              "case mixes a real model miss with an arbitrary vehicle label.",
        decision="Canonicalise unspecified vehicle to 'any' (contract: vehicle only "
                 "when stated). The dietary miss is fixable; the vehicle label is "
                 "not, so this case will stay a miss overall.",
        label_by_field={"food.dietary": "A", "ride.vehicle": "B"},
    ),
    "holdout-274": dict(
        category="combo_vehicle_label_noise",
        consistency="B",
        causes=["dataset"],
        fixable=False,
        notes="No vehicle word; label cab. V5 guessed bike. Neither reading is "
              "supported by the text.",
        decision="Canonical 'any' when no vehicle is stated; accept the miss.",
        label_by_field={"ride.vehicle": "B"},
    ),
    "holdout-276": dict(
        category="combo_vehicle_label_noise",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="No vehicle word; label any, which is the canonical reading. V5 "
              "guessed bike.",
        decision="Teach unspecified vehicle -> any in combos.",
        label_by_field={"ride.vehicle": "A"},
    ),
    "holdout-279": dict(
        category="combo_vehicle_label_noise",
        consistency="B",
        causes=["dataset"],
        fixable=False,
        notes="No vehicle word; label auto. V5 guessed bike. The food side is right.",
        decision="Canonical 'any'; accept the vehicle miss.",
        label_by_field={"food.dietary": "A", "ride.vehicle": "B"},
    ),
    "holdout-280": dict(
        category="combo_vehicle_label_noise",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="No vehicle word; label any. V5 guessed auto.",
        decision="Teach unspecified vehicle -> any in combos.",
        label_by_field={"ride.vehicle": "A"},
    ),
    "holdout-281": dict(
        category="combo_vehicle_label_noise",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="No vehicle word; label any. V5 guessed cab.",
        decision="Teach unspecified vehicle -> any in combos.",
        label_by_field={"ride.vehicle": "A"},
    ),
    "holdout-282": dict(
        category="combo_vehicle_label_noise",
        consistency="B",
        causes=["dataset"],
        fixable=False,
        notes="No vehicle word; label cab. V5 guessed any, which is the canonical "
              "reading but not the sampled label.",
        decision="Canonical 'any'; accept the miss.",
        label_by_field={"ride.vehicle": "B"},
    ),
    "holdout-284": dict(
        category="dietary_dish_implied",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="Dish map says cake is veg; V5 said any. The ride side is correct.",
        decision="Train the full dish map on combo sentences.",
    ),
    "holdout-291": dict(
        category="dietary_dish_implied",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="Dish map says brownie is veg; V5 said any.",
        decision="Train the full dish map on combo sentences.",
    ),
    "holdout-301": dict(
        category="domain_short_request",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="The production contract says a taste or mood is a food request and "
              "the mood is the item. V5 sent 'something cheesy' to out_of_scope.",
        decision="Add unseen taste/mood paraphrases as food with the phrase as item.",
    ),
    "holdout-322": dict(
        category="domain_short_request",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="A bare product noun is a shop request. V5 sent 'wallet' to "
              "out_of_scope.",
        decision="Add bare product nouns across the five categories.",
    ),
    "holdout-336": dict(
        category="priority_eta_convention_conflict",
        consistency="A",
        causes=["model"],
        fixable=True,
        notes="Amount + deadline with no priority word, labelled speed. This is the "
              "corpus-majority convention and the opposite of holdout-83/106.",
        decision="Follow the majority: deadline with no explicit priority -> speed.",
    ),
}

CATEGORY_TITLES = {
    "item_convention": "Item convention (dish vs meal vs dietary word)",
    "dietary_dish_implied": "Dietary implied by the dish",
    "domain_short_request": "Short request domain",
    "greeting_app_smalltalk": "App small talk as greeting",
    "priority_cue_missed": "Priority cue in the sentence",
    "priority_cue_casing": "Priority cue hidden by casing",
    "priority_eta_convention_conflict": "Deadline/priority convention conflict",
    "ride_from_to_parse": "Ride origin/destination parsing",
    "ride_phantom_pickup_label": "Phantom pickup in the label",
    "ride_pickup_wait_missed": "Ride pickup wait missed",
    "ride_priority_wait": "Ride wait implies speed",
    "combo_vehicle_label_noise": "Combo vehicle label noise",
    "shop_category_enum": "Shop category outside the enum",
}


def load_holdout_texts() -> dict[str, str]:
    rows = [json.loads(line) for line in HOLDOUT.read_text(encoding="utf-8").splitlines() if line.strip()]
    return {f"holdout-{i}": row["messages"][1]["content"] for i, row in enumerate(rows, 1)}


def main() -> int:
    texts = load_holdout_texts()
    preds = [json.loads(line) for line in PREDICTIONS.read_text(encoding="utf-8").splitlines() if line.strip()]
    fails = [p for p in preds if p["set"] == "holdout" and not p["fully_right"]]
    fails.sort(key=lambda p: int(p["id"].split("-")[1]))

    records = []
    for pred in fails:
        ident = pred["id"]
        ann = ANNOTATIONS[ident]
        diffs = [r for r in fs.compare_expected(pred["expected"], pred["actual"]) if not r["ok"]]
        # A missing food/shop/ride object fails every nested assertion at once;
        # collapse those into one root cause instead of counting five fields.
        fields = []
        for d in diffs:
            field = d["field"]
            part = field.split(".")[0]
            if (part in ("food", "ride", "shop")
                    and isinstance(pred["expected"].get(part), dict)
                    and not isinstance(pred["actual"].get(part), dict)):
                field = f"{part} (object missing)"
            if field not in fields:
                fields.append(field)
        records.append({
            "id": ident,
            "input": texts[ident],
            "expected": pred["expected"],
            "actual": pred["actual"],
            "field_diffs": diffs,
            "failure_category": ann["category"],
            "affected_fields": fields,
            "label_consistency": ann["consistency"],
            "label_by_field": ann.get("label_by_field", {}),
            "causes": {
                "model": "model" in ann["causes"],
                "dataset": "dataset" in ann["causes"],
                "schema_ambiguity": "schema" in ann["causes"],
                "production_prompt": "production_prompt" in ann["causes"],
            },
            "model_fixable": ann["fixable"],
            "notes": ann["notes"],
            "v6_decision": ann["decision"],
        })

    OUT_JSONL.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records),
        encoding="utf-8",
    )

    missing = set(ANNOTATIONS) - {r["id"] for r in records}
    extra = {r["id"] for r in records} - set(ANNOTATIONS)
    if missing or extra:
        raise SystemExit(f"annotation mismatch: missing={sorted(missing)} extra={sorted(extra)}")

    lines: list[str] = []
    add = lines.append

    add("# V5 sealed-holdout error analysis")
    add("")
    add("Generated by `model/analyze_holdout_errors.py` from `results/v5_final.jsonl`")
    add("and `eval_mlx_v5.jsonl`. The sealed holdout was read, not modified.")
    add("")
    add(f"* Holdout size: {TOTAL} cases")
    add(f"* V5 fully-right: {TOTAL - len(records)} ({100 * (TOTAL - len(records)) / TOTAL:.1f}%)")
    add(f"* V5 misses analysed: {len(records)} ({100 * len(records) / TOTAL:.1f}%)")
    add(f"* Right independently of the sampled label: {TOTAL - len(records) + sum(1 for r in records if r['model_fixable'])}"
        f" ({100 * (TOTAL - len(records) + sum(1 for r in records if r['model_fixable'])) / TOTAL:.2f}%)")
    add("")
    add("A case counts as *model-fixable* when its asserted label is supported by the")
    add("sentence under the FLOUNA contract and training can teach the rule. The rest")
    add("are label errors or genuinely ambiguous labels; they are left in the sealed")
    add("set as they are.")
    add("")

    add("## Failure categories")
    add("")
    add("| Category | Cases | Model-fixable | IDs |")
    add("|---|---:|---:|---|")
    by_cat: dict[str, list[dict]] = {}
    for r in records:
        by_cat.setdefault(r["failure_category"], []).append(r)
    for cat in sorted(by_cat, key=lambda c: (-len(by_cat[c]), c)):
        rows = by_cat[cat]
        ids = ", ".join(r["id"].replace("holdout-", "") for r in rows)
        add(f"| {CATEGORY_TITLES.get(cat, cat)} | {len(rows)} | {sum(1 for r in rows if r['model_fixable'])} | {ids} |")
    add("")

    add("## Affected fields")
    add("")
    counts: dict[str, int] = {}
    for r in records:
        for f in r["affected_fields"]:
            counts[f] = counts.get(f, 0) + 1
    add("| Field | Misses |")
    add("|---|---:|")
    for field, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        add(f"| `{field}` | {count} |")
    add("")

    add("## Cause and label-consistency totals")
    add("")
    add("| Bucket | Cases |")
    add("|---|---:|")
    for label, key in (
        ("Caused by the model (at least partly)", "model"),
        ("Caused by the dataset labels", "dataset"),
        ("Caused by schema ambiguity", "schema_ambiguity"),
        ("Caused by the production prompt", "production_prompt"),
    ):
        add(f"| {label} | {sum(1 for r in records if r['causes'][key])} |")
    for grade, text in (
        ("A", "Correct label"),
        ("B", "Incorrect label"),
        ("C", "Ambiguous label"),
        ("D", "Insufficient information"),
    ):
        add(f"| Label {grade}: {text} | {sum(1 for r in records if r['label_consistency'] == grade)} |")
    add("")

    add("## All 38 misses")
    add("")
    add("| ID | Input | Category | Wrong fields | Label | Fixable |")
    add("|---|---|---|---|---|---|")
    for r in records:
        text = r["input"].replace("|", "\\|")
        if len(text) > 58:
            text = text[:55] + "..."
        add(f"| {r['id'].replace('holdout-', '')} | {text} | {r['failure_category']} | "
            f"{', '.join(r['affected_fields'])} | {r['label_consistency']} | "
            f"{'yes' if r['model_fixable'] else 'no'} |")
    add("")

    add("## Case detail")
    for r in records:
        add("")
        add(f"### {r['id']} - {CATEGORY_TITLES.get(r['failure_category'], r['failure_category'])}")
        add("")
        add(f"**Input:** {r['input']}")
        add("")
        add("**Expected:** `" + json.dumps(r["expected"], ensure_ascii=False) + "`")
        add("")
        add("**V5 actual:** `" + json.dumps(r["actual"], ensure_ascii=False) + "`")
        add("")
        add("**Field diffs:** " + "; ".join(
            f"`{d['field']}` expected {json.dumps(d['want'], ensure_ascii=False)}, "
            f"got {json.dumps(d['got'], ensure_ascii=False)}"
            for d in r["field_diffs"]))
        add("")
        causes = ", ".join(k.replace("_", " ") for k, v in r["causes"].items() if v)
        add(f"**Label consistency:** {r['label_consistency']} | **Cause:** {causes} | "
            f"**Model-fixable:** {'yes' if r['model_fixable'] else 'no'}")
        if r["label_by_field"]:
            add("")
            add("Per-field ruling: " + ", ".join(
                f"`{f}` {g}" for f, g in r["label_by_field"].items()))
        add("")
        add(f"**Analysis:** {r['notes']}")
        add("")
        add(f"**V6 decision:** {r['v6_decision']}")

    add("")
    add("---")
    add("")
    add("# Phase 2 - label-consistency audit")
    add("")
    add("The rulings below are corpus-wide, not just about the 38 misses. Each one")
    add("was checked against the production contract in")
    add("`server/src/modules/chat/llm/prompt.ts`, the V5 generator in")
    add("`gen_data_v5.py`, and the training rows themselves. The sealed holdout is")
    add("unchanged.")
    add("")

    add("## D1. Dietary: explicit statement first, then the canonical dish map")
    add("")
    add("Where the labels disagree: V5 mixes generations. The V4 rows were repaired")
    add("with `detect_dietary(text, item)`, which searches the dish word for veg/nonveg")
    add("markers. The V5 rows use `FOOD_DIETARY`, a dish table. The handcrafted")
    add("holdout table uses the table too. The table has `masala dosa` and `plain dosa`")
    add("but not `dosa`, so `send dosa ASAP` fell back to `any` while every other")
    add("dish-implied holdout case (pancakes, cake, brownie, dahi puri, coffee) expects")
    add("its dish value.")
    add("")
    add("Ruling: A = explicit word (veg, non-veg, chicken, meat...) or unambiguous dish")
    add("in the canonical map; otherwise any. Add `dosa` (and the rest of the ingredient")
    add("list) to the map. **holdout-12 is graded B** under this convention and is")
    add("expected to remain a miss. The production prompt says dietary is extracted")
    add("\"if stated\"; we keep the dish map because the recommender filters on it and")
    add("because 10k training rows plus five of six sealed implied cases use it. This")
    add("divergence is recorded here, not hidden.")
    add("")

    add("## D2. Ride vehicle: explicit word only, otherwise any")
    add("")
    add("`gen_ride` and `gen_combo` sample a vehicle even when the sentence never names")
    add("one, so the same surface has cab, auto, bike and any labels. The production")
    add("contract asks for a vehicle preference; with no preference the honest value is")
    add("`any`.")
    add("")
    add("Ruling: map explicit words (bike/motorbike/scooter; auto/rickshaw/auto")
    add("rickshaw; cab/taxi/car) to the enum; otherwise `any`. In the audit: holdout-276,")
    add("280, 281 (label any) are A; holdout-273, 274, 279, 282 (label cab/auto) are B.")
    add("The V6 rule fixes three of the seven and cannot fix the other four.")
    add("")

    add("## D3. Priority: cues in the user's words, then a single deadline rule")
    add("")
    add("Cue order: rating (best, top-rated, badhiya, manchi) > speed (fast, quick,")
    add("asap, jaldi, don't want to wait) > price (cheap, sasta, budget, low cost) >")
    add("balanced. Cues are matched case-insensitively, so `SASTA` counts and the label")
    add("is still lowercase.")
    add("")
    add("Deadline rule: a delivery deadline or a pickup wait with no explicit priority")
    add("word means speed. Among ETA-only training rows this convention is 713 speed vs")
    add("205 balanced; it is also what the sealed set expects for 336. It contradicts")
    add("the sealed labels of 83 and 106, which share the same surface. That pair is")
    add("graded C: the generator used hidden state, so no model can separate them. V6")
    add("follows the majority and accepts the two misses.")
    add("")

    add("## D4. Item: dish > meal > taste phrase > dietary word > 'food'")
    add("")
    add("The holdout labels show the intended precedence: `lunch` is the item in")
    add("\"something low cost for lunch\"; `food` is the item in \"nonvegetarian options\"")
    add("and \"pure veg options\"; `something cheesy` stays whole as a mood item. V5")
    add("mixed these up. V6 training will use the precedence above. No schema change.")
    add("")

    add("## D5. Phantom pickups are never taught")
    add("")
    add("Up to 545 V5 training rows carry a pickup that the chosen sentence shell")
    add("omitted. Three sealed cases (169, 230, 231) carry the same defect. The contract")
    add("says pickup is null unless stated; V5's behaviour was right and the benchmark")
    add("scored it wrong.")
    add("")
    add("Ruling: strip every pickup whose name is absent from its sentence when")
    add("building V6; require an origin cue (`from X to Y`, `X se Y tak`, `pickup at`,")
    add("`pick me up from`, `nundi`) to keep one. The three sealed cases are graded B and")
    add("will remain misses. They are not rewritten and not trained against.")
    add("")

    add("## D6. Casing is a training problem, not an output post-process")
    add("")
    add("The enum labels are already canonical lowercase, and the evaluator compares")
    add("them case-insensitively. The casing failures are cues the model failed to")
    add("recognise (`SASTA`, `SE ... TAK`), not labels that need rewriting. Ruling:")
    add("include uppercase and mixed-case rows in training; do not add a runtime")
    add("lowercasing layer and do not change the enums.")
    add("")

    add("## D7. Shop categories stay the five existing values")
    add("")
    add("`electronics`, `fashion`, `home`, `appliances`, `any`. V5 invented `furniture`")
    add("for an office chair, which the server schema rejects. Ruling: train the")
    add("item-to-category map with `home` for furniture, and add a validation rule that")
    add("rejects any category outside the enum. No sixth category is introduced.")
    add("")

    add("## D8. Action: present in production, absent from the benchmark")
    add("")
    add("The production prompt and schema define 18 action kinds with 12 required")
    add("fields, but the sealed 382 contain zero action cases and V5's corpus has none.")
    add("V5's only action measurement is the four-prompt probe in")
    add("`results/v5_ollama_action_probe.json`, where it answered all four as discovery")
    add("food/shop rows (0/4).")
    add("")
    add("Ruling: V6 trains the contract as written, including hard negatives (information")
    add("and discovery requests that mention a cart, order or ride but do not authorise")
    add("an action, plus yes/no/cancel). Action accuracy is measured on a separate")
    add("sealed action set that is never trained on, because the 382-case holdout cannot")
    add("measure it. The production prompt is not changed.")
    add("")

    add("## Consequence for the sealed score")
    add("")
    add("Ten of the 38 misses are not fixable without teaching a label the sentence")
    add("does not support: 12 (dietary table gap), 83 and 106 (deadline convention),")
    add("169, 230, 231 (phantom pickups), 273, 274, 279, 282 (arbitrary vehicles).")
    add("If every other miss is fixed, the sealed ceiling is")
    add(f"**{TOTAL - 10}/{TOTAL} = {100 * (TOTAL - 10) / TOTAL:.2f}%**. An honest 99%")
    add("is therefore not reachable on this benchmark; the honest target for V6 is the")
    add("ceiling, and the remaining gap is documented label noise.")
    add("")

    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT_JSONL.relative_to(HERE)} ({len(records)} records)")
    print(f"wrote {OUT_MD.relative_to(HERE)}")
    print(f"fixable {sum(1 for r in records if r['model_fixable'])}/{len(records)}; "
          f"ceiling {TOTAL - 10}/{TOTAL} = {100 * (TOTAL - 10) / TOTAL:.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
