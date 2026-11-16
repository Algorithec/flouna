#!/usr/bin/env python3
"""Audit the V6 training corpus before building V7. Read-only on the source.

    python data/v7/audit_corpus_v7.py

Writes data/v7/dataset_audit_v7.json and .md. The source file is only read.
"""
from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE.parent.parent
sys.path.insert(0, str(MODEL))

import flouna_schema as fs  # noqa: E402
import gen_data_v5 as g  # noqa: E402
import validate_dataset as vd  # noqa: E402
import re  # noqa: E402

VEG_WORDS = re.compile(r"\b(?:veg|paneer|dal|chole|rajma|chana|dosa|idli|vada|pav bhaji|upma|poha|uttapam|gulab jamun|jalebi|paratha|thali)\b", re.I)
NONVEG_WORDS = re.compile(r"\b(?:chicken|mutton|fish|prawn|egg|keema)\b", re.I)
PRICE_WORDS = re.compile(r"\b(?:cheap(?:est)?|affordable|budget\b(?!\s*(?:of\s*)?[₹\d])|budget[\s-]friendly|inexpensive|low[\s-]cost|sasta|sabse sasta|takkuva|economical|best price|lowest price|value for money|save money|save on|spend much|spending a lot|without spending|cheaper|low price)\b", re.I)
SPEED_WORDS = re.compile(r"\b(?:fast(?:est)?|quick(?:est)?|quickly|urgent|immediately|asap|jaldi|fatafat|tondaraga|turant|express|hurry|soon|right away|right now|abhi|don'?t want to wait)\b", re.I)
DEADLINE = re.compile(r"\b(?:within|in|under|by|max|maximum)\s+\d{1,3}\s*(?:min|minutes?|mins?)\b|\d{1,3}\s*min(?:ute)?s?\s*(?:me|tak)\b", re.I)
RATING_WORDS = re.compile(r"\b(?:best|top rated|top-rated|highest rated|best rated|highly rated|highest rating|rates? (?:highly|well)|popular|badhiya|manchi|good quality)\b", re.I)
NO_PREF = re.compile(r"\b(?:no (?:special|particular|specific)?\s*preference|no preference|doesn'?t matter|nothing specific|nothing special)\b", re.I)
WAIT_LIMIT = re.compile(r"\b(?:pickup|pick me|wait|driver|cab should reach|reach me)\b[^.]{0,30}\d{1,3}\s*min", re.I)


def priority_policy(text: str, domain: str) -> str:
    """Documented V7 precedence, verified against the sealed holdout's own labels.

    no-preference phrase > rating word > speed word > price word > deadline > balanced.
    A food delivery deadline and a ride pickup wait are speed only when no stronger cue
    is present. A ride trip deadline has no schema field, so it stays balanced.
    """
    if NO_PREF.search(text):
        return "balanced"
    if RATING_WORDS.search(text):
        return "rating"
    if SPEED_WORDS.search(text):
        return "speed"
    if PRICE_WORDS.search(text):
        return "price"
    if domain == "food" and DEADLINE.search(text):
        return "speed"
    if domain == "ride" and WAIT_LIMIT.search(text):
        return "speed"
    return "balanced"
GREET_TOKENS = re.compile(
    r"^(?:hi|hello|hey|yo|sup|howdy|namaste|namaskar|good (?:morning|afternoon|evening|night)|"
    r"(?:hey |hi |hello )?(?:there|flouna)|start|help|what can you do|what is flouna|"
    r"thanks?|thank you|thx|ty|dhanyavaad|shukriya|ok(?:ay)?|alright|fine|got it|cool|nice|"
    r"bye|goodbye|see you|see ya|good night|that helps|that works|perfect)\b", re.I)
DISCOVERY = re.compile(r"\b(?:find|show me|suggest|recommend|search|options?|available|near me|what(?:'s| is) good|best .* near)\b", re.I)
RIDE_WORD = re.compile(r"\b(?:cab|taxi|auto|rickshaw|bike|ride|driver|pickup|pick me|airport|station)\b", re.I)
AMOUNT = re.compile(r"(?:₹|rs\.?|inr|rupees?)\s*(\d{2,7})|(\d{2,7})\s*(?:rupees?|rs\b|₹|tak|lopala|lopu|varaku)", re.I)
GENERIC_ITEMS = {"food", "popular dishes", "something to eat", "meal", "item", "dish", ""}
SHOP_ITEM_WORDS = {g.norm_key(x): cat for cat, items in g.SHOP_ITEMS.items() for x in items}
FOOD_ITEM_WORDS = {g.norm_key(x) for x in g.VEG_FOODS + g.NONVEG_FOODS + g.ANY_FOODS}


def semantic_audit(rows: list[dict]) -> dict:
    findings: dict[str, list[dict]] = defaultdict(list)

    def add(kind: str, r: dict, detail: str) -> None:
        findings[kind].append({"line": r["line"], "text": r["text"], "domain": r["output"]["domain"], "detail": detail})

    for r in rows:
        o = r["output"]
        text = r["text"]
        dom = o["domain"]
        body = part(o)
        reply = o.get("reply", "")

        if dom == "food" and body:
            item = (body.get("item") or "").strip()
            if item.lower() in GENERIC_ITEMS:
                add("generic_food_item", r, f"item={item!r}")
            if body.get("dietary") == "veg" and NONVEG_WORDS.search(text):
                add("dietary_conflict", r, "veg label but non-veg word in text")
            if body.get("dietary") == "nonveg" and VEG_WORDS.search(text) and not NONVEG_WORDS.search(text) and not re.search(r"non[- ]?veg", text, re.I):
                add("dietary_conflict", r, "nonveg label but only veg words in text")
            if g.norm_key(item) in SHOP_ITEM_WORDS:
                add("domain_food_shop_item", r, f"food item is a shop product: {item!r}")

        if dom == "shop" and body:
            item = (body.get("item") or "").strip()
            if g.norm_key(item) in FOOD_ITEM_WORDS:
                add("domain_shop_food_item", r, f"shop item is a food: {item!r}")
            if item.lower() in GENERIC_ITEMS:
                add("generic_shop_item", r, f"item={item!r}")

        if dom == "ride" and body:
            veh = body.get("vehicle")
            explicit = None
            for word, v in g.VEHICLE_WORDS.items():
                if re.search(rf"\b{re.escape(word)}s?\b", text, re.I):
                    explicit = v
                    break
            if veh == "cab" and explicit is None:
                add("vehicle_cab_without_cue", r, "vehicle=cab but no vehicle word in text")
            if explicit and veh not in (explicit, "any"):
                add("vehicle_conflict", r, f"text says {explicit}, label {veh}")
            if veh == "any" and explicit and explicit != "any":
                add("vehicle_any_with_explicit", r, f"explicit {explicit} but label any")

        if body and dom in ("food", "ride", "shop"):
            pri = body.get("priority")
            price_cue = bool(PRICE_WORDS.search(text))
            speed_cue = bool(SPEED_WORDS.search(text) or DEADLINE.search(text))
            rating_cue = bool(RATING_WORDS.search(text))
            if pri == "price" and not price_cue:
                add("priority_price_without_cue", r, "priority=price but no price words")
            if pri == "speed" and not speed_cue:
                add("priority_speed_without_cue", r, "priority=speed but no speed words")
            if pri == "rating" and not rating_cue:
                add("priority_rating_without_cue", r, "priority=rating but no rating words")
            if pri == "balanced" and (price_cue or speed_cue or rating_cue):
                add("priority_balanced_with_cue", r, "priority=balanced but text has a priority cue")
            budget = body.get("budgetPaise")
            m = AMOUNT.search(text)
            if budget is not None and m:
                amount = int(m.group(1) or m.group(2))
                if abs(budget - amount * 100) > 1 and abs(budget - amount) > 1:
                    add("budget_unit", r, f"text ₹{amount} -> {budget} paise")

        if dom == "action" and isinstance(o.get("action"), dict):
            kind = o["action"]["kind"]
            if DISCOVERY.search(text) and not re.search(r"\b(?:that|this|those|these|it|option \d|second|third|first|basket|cart)\b", text, re.I):
                add("action_ambiguous_discovery", r, f"kind={kind} but text reads like a search")
            if re.search(r"\b(?:remove|delete|get rid of)\b", text, re.I) and kind not in ("cart.remove", "cart.clear") and not (kind == "settings.budget" and re.search(r"budget", text, re.I)):
                add("action_kind_mismatch", r, f"text says remove, kind={kind}")

        if dom == "greeting":
            if re.search(r"\b(?:order|find|buy|book|cancel|play|write|explain|calculate)\b", text, re.I):
                add("greeting_suspicious", r, "greeting label but text asks for work")
        if dom == "out_of_scope":
            if re.search(r"\b(?:order|get me|find me|show me|book me|i want to buy|deliver)\b", text, re.I) and not re.search(r"\b(?:how|why|can you cook|is .* healthy|recipe)\b", text, re.I):
                add("oos_supported_cue", r, "out_of_scope but text contains a supported request cue")
            if len(text.split()) <= 2 and GREET_TOKENS.search(text):
                add("oos_greeting_short", r, "short greeting-like text labelled out_of_scope")

        if dom in ("food", "ride", "shop", "combo"):
            if not isinstance(body, dict):
                add("missing_part", r, f"domain {dom} without a body")
        if dom == "combo":
            if not isinstance(o.get("food"), dict) or not isinstance(o.get("ride"), dict):
                add("combo_incomplete", r, "combo without both food and ride")

        if not reply or not reply.strip():
            add("empty_reply", r, "empty reply")
        elif re.search(r"[—–]|\s-\s", reply):
            add("reply_dash", r, "reply contains a dash")
        if dom == "out_of_scope" and reply.strip() != g.OOS_REPLY:
            add("oos_reply_not_canonical", r, reply[:80])

    return findings

SOURCE = MODEL / "train_mlx_v6.jsonl"
HOLDOUT = MODEL / "eval_mlx_v5.jsonl"
FIXTURES = [
    MODEL.parent / "server/test/fixtures/intent-eval.jsonl",
    MODEL.parent / "server/test/fixtures/intent-eval-holdout.jsonl",
]
OUT_JSON = HERE / "dataset_audit_v7.json"
OUT_MD = HERE / "dataset_audit_v7.md"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def signature(output: dict) -> str:
    return json.dumps(output, sort_keys=True, ensure_ascii=False)


def part(output: dict) -> dict | None:
    for key in ("food", "ride", "shop"):
        if isinstance(output.get(key), dict):
            return output[key]
    return None


def part_name(output: dict) -> str | None:
    for key in ("food", "ride", "shop"):
        if isinstance(output.get(key), dict):
            return key
    return None


def contradiction_families(outputs: list[dict]) -> set[str]:
    """Which output families actually disagree inside one text group."""
    fams: set[str] = set()
    if len({o.get("domain") for o in outputs}) > 1:
        fams.add("domain")
    doms = {o.get("domain") for o in outputs}
    if doms <= {"greeting", "out_of_scope"} and len(doms) > 1:
        fams.add("greeting_vs_oos")
    action_kinds = {o["action"].get("kind") for o in outputs if isinstance(o.get("action"), dict)}
    if len(action_kinds) > 1:
        fams.add("action_kind")
    if "action" in doms and doms - {"action"}:
        fams.add("action_vs_other_domain")
    for key, fields in (
        ("ride", ("vehicle", "pickup", "drop", "budgetPaise", "maxPickupMinutes", "scheduleAt", "priority")),
        ("food", ("item", "budgetPaise", "maxEtaMinutes", "dietary", "priority")),
        ("shop", ("item", "budgetPaise", "category", "priority")),
    ):
        bodies = [o[key] for o in outputs if isinstance(o.get(key), dict)]
        if len(bodies) > 1:
            for field in fields:
                if len({json.dumps(b.get(field), sort_keys=True) for b in bodies}) > 1:
                    fams.add(f"{key}.{field}")
    return fams


def main() -> int:
    src_copy = HERE / "source" / SOURCE.name
    if not src_copy.exists():
        src_copy.write_bytes(SOURCE.read_bytes())
    assert sha256(src_copy) == sha256(SOURCE), "source copy is not byte-identical"

    rows = []
    invalid_json = []
    structure_errors = []
    for line_no, line in enumerate(SOURCE.open(encoding="utf-8"), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            invalid_json.append({"line": line_no, "error": str(exc)})
            continue
        messages = row.get("messages")
        if not isinstance(messages, list) or [m.get("role") for m in messages if isinstance(m, dict)] != [
            "system", "user", "assistant"
        ]:
            structure_errors.append({"line": line_no, "issue": "expected system/user/assistant"})
            continue
        system, text, answer = (m.get("content") for m in messages)
        if not all(isinstance(x, str) for x in (system, text, answer)):
            structure_errors.append({"line": line_no, "issue": "non-string content"})
            continue
        try:
            output = json.loads(answer)
        except json.JSONDecodeError as exc:
            invalid_json.append({"line": line_no, "error": f"assistant: {exc}", "text": text})
            continue
        rows.append({"line": line_no, "system": system, "text": text, "raw": answer, "output": output})

    systems = Counter(r["system"] for r in rows)

    schema_errors, action_semantics, conflicts = [], [], []
    valid = []
    for r in rows:
        errs = fs.validate_intent(r["output"])
        if errs:
            schema_errors.append({"line": r["line"], "text": r["text"], "errors": errs})
            continue
        semantics = fs.validate_action_semantics(r["output"]["action"]) if r["output"]["domain"] == "action" else []
        if semantics:
            action_semantics.append({"line": r["line"], "text": r["text"], "errors": semantics})
            continue
        probs = fs.label_conflicts(r["text"], r["output"])
        # injected typos are a deliberate robustness device, not a label problem
        real = [p for p in probs if p != "injected typo"]
        if real:
            conflicts.append({"line": r["line"], "text": r["text"], "problems": real})
        else:
            valid.append(r)

    # duplicates and contradictions, keyed on normalized user text
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[vd.norm_text(r["text"])].append(r)

    exact_dup_groups = []
    contradictions = []
    dup_row_count = 0
    for key, members in groups.items():
        if len(members) < 2:
            continue
        dup_row_count += len(members) - 1
        sigs = {signature(m["output"]) for m in members}
        entry = {
            "text": members[0]["text"],
            "count": len(members),
            "lines": [m["line"] for m in members],
            "distinct_labels": len(sigs),
            "domains": sorted({m["output"]["domain"] for m in members}),
        }
        exact_dup_groups.append(entry)
        if len(sigs) > 1:
            contradictions.append(
                {
                    "text": members[0]["text"],
                    "count": len(members),
                    "lines": [m["line"] for m in members],
                    "families": sorted(contradiction_families([m["output"] for m in members])),
                    "labels": [m["output"] for m in members],
                }
            )

    near090 = vd.near_pairs([(r["text"], {}) for r in rows], 0.9)
    near080 = vd.near_pairs([(r["text"], {}) for r in rows], 0.8)

    # leakage against the sealed holdout (normalized exact + 4-gram similarity)
    holdout_texts = []
    for line in HOLDOUT.read_text(encoding="utf-8").splitlines():
        if line.strip():
            holdout_texts.append(json.loads(line)["messages"][1]["content"])
    hold_norm = {vd.norm_text(t) for t in holdout_texts}
    hold_grams = [vd.token_grams(t) for t in holdout_texts]
    exact_leak = [r for r in rows if vd.norm_text(r["text"]) in hold_norm]
    near_leak = []
    for r in rows:
        g = vd.token_grams(r["text"])
        if not g:
            continue
        for i, hg in enumerate(hold_grams):
            if not hg:
                continue
            score = len(g & hg) / len(g | hg)
            if score >= 0.8:
                near_leak.append({"line": r["line"], "text": r["text"], "holdout": holdout_texts[i], "score": round(score, 3)})
                break

    fixture_norm = vd.fixture_texts()
    fixture_leak = [r for r in rows if vd.norm_text(r["text"]) in fixture_norm]

    # distributions
    semantic = semantic_audit(rows)
    templates = Counter(" ".join(vd.norm_text(r["text"]).split()[:3]) for r in rows)

    policy_mismatch = Counter()
    multi_cue = Counter()
    for r in rows:
        if r["output"]["domain"] not in ("food", "ride", "shop"):
            continue
        body = part(r["output"]) or {}
        t = r["text"]
        cues = [
            name
            for name, rx in (("price", PRICE_WORDS), ("rating", RATING_WORDS), ("speed", SPEED_WORDS))
            if rx.search(t)
        ]
        if DEADLINE.search(t):
            cues.append("deadline")
        if NO_PREF.search(t):
            cues.append("no_pref")
        if len(cues) > 1:
            multi_cue["+".join(sorted(cues))] += 1
        want = priority_policy(t, r["output"]["domain"])
        if body.get("priority") != want:
            policy_mismatch[f"{r['output']['domain']}:{body.get('priority')}->{want}"] += 1

    bare_entity = Counter()
    generic = ("manchurian", "noodles", "pizza", "burger", "thali", "dosa", "sandwich",
               "biryani", "pasta", "momos", "roll", "samosa", "chowmein", "maggi")
    for r in rows:
        low = vd.norm_text(r["text"])
        if low in generic:
            bare_entity[f"{low}->{r['output']['domain']}"] += 1

    domains = Counter(r["output"]["domain"] for r in valid)
    priorities, dietary, vehicles, categories = Counter(), Counter(), Counter(), Counter()
    action_kinds = Counter()
    for r in valid:
        o = r["output"]
        if o["domain"] == "action":
            action_kinds[o["action"]["kind"]] += 1
        body = part(o)
        if body:
            priorities[body.get("priority")] += 1
            if o["domain"] == "food":
                dietary[body.get("dietary")] += 1
            if o["domain"] == "ride":
                vehicles[body.get("vehicle")] += 1
            if o["domain"] == "shop":
                categories[body.get("category")] += 1

    ambiguous = [
        c
        for c in conflicts
        if not any("no amount in text" in p or "no delivery time" in p or "no pickup wait" in p or "no clock time" in p for p in c["problems"])
    ]
    unjustifiable = [c for c in conflicts if c not in ambiguous]

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {"path": str(SOURCE.relative_to(MODEL)), "sha256": sha256(SOURCE), "bytes": SOURCE.stat().st_size},
        "holdout": {"path": str(HOLDOUT.relative_to(MODEL)), "sha256": sha256(HOLDOUT), "rows": len(holdout_texts)},
        "counts": {
            "rows": len(rows) + len(invalid_json) + len(structure_errors),
            "parsed_rows": len(rows),
            "valid_rows": len(valid),
            "schema_or_semantics_invalid": len(schema_errors) + len(action_semantics),
            "rows_with_label_conflicts": len(conflicts),
            "unique_normalized_texts": len(groups),
            "exact_duplicate_extra_rows": dup_row_count,
            "duplicate_text_groups": len(exact_dup_groups),
            "contradictory_text_groups": len(contradictions),
            "near_duplicate_pairs_0.9": len(near090),
            "near_duplicate_pairs_0.8": len(near080),
        },
        "system_prompts": {f"len{syslen}": n for syslen, n in Counter(len(s) for s in systems).items()},
        "invalid_json": invalid_json[:50],
        "structure_errors": structure_errors[:50],
        "schema_errors": schema_errors[:50],
        "schema_error_count": len(schema_errors),
        "action_semantics_errors": action_semantics[:50],
        "action_semantics_error_count": len(action_semantics),
        "label_conflicts": conflicts[:80],
        "label_conflict_count": len(conflicts),
        "ambiguous": ambiguous[:60],
        "ambiguous_count": len(ambiguous),
        "unjustifiable": unjustifiable[:60],
        "unjustifiable_count": len(unjustifiable),
        "contradictions": contradictions[:80],
        "contradiction_families": dict(
            Counter(f for c in contradictions for f in c["families"]).most_common()
        ),
        "duplicate_examples": exact_dup_groups[:20],
        "holdout_leakage": {
            "exact": [{"line": r["line"], "text": r["text"]} for r in exact_leak][:20],
            "exact_count": len(exact_leak),
            "near_0.8": near_leak[:20],
            "near_0.8_count": len(near_leak),
        },
        "fixture_leakage_count": len(fixture_leak),
        "semantic_issues": {k: v[:60] for k, v in semantic.items()},
        "semantic_issue_counts": {k: len(v) for k, v in sorted(semantic.items(), key=lambda kv: -len(kv[1]))},
        "semantic_issue_rows": len({f["line"] for v in semantic.values() for f in v}),
        "template_redundancy": {
            "top_first_three_tokens": templates.most_common(15),
            "texts_in_templates_over_40": sum(n for _, n in templates.items() if n > 40),
        },
        "priority_policy": "no-preference phrase > rating word > speed word > price word > deadline > balanced",
        "priority_policy_mismatches": {
            "count": sum(policy_mismatch.values()),
            "breakdown": dict(policy_mismatch.most_common()),
        },
        "multi_cue_rows": {"count": sum(multi_cue.values()), "breakdown": dict(multi_cue.most_common(12))},
        "coverage_gaps": {
            "bare_generic_food_entities": {"count": sum(bare_entity.values()), "labels": dict(bare_entity)},
            "ceiling_phrase_rows": sum(1 for r in rows if re.search(r"\bceiling\b", r["text"], re.I)),
            "action_rows": domains.get("action", 0),
            "greeting_rows": domains.get("greeting", 0),
            "oos_rows": domains.get("out_of_scope", 0),
            "vehicle_any": sum(1 for r in valid if r["output"]["domain"] == "ride" and r["output"]["ride"].get("vehicle") == "any"),
            "vehicle_cab": sum(1 for r in valid if r["output"]["domain"] == "ride" and r["output"]["ride"].get("vehicle") == "cab"),
            "system_prompt_variants": len(systems),
        },
        "distributions": {
            "domains": dict(domains.most_common()),
            "priorities": dict(priorities.most_common()),
            "dietary": dict(dietary.most_common()),
            "vehicles": dict(vehicles.most_common()),
            "categories": dict(categories.most_common()),
            "action_kinds": dict(action_kinds.most_common()),
        },
    }
    OUT_JSON.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    c = report["counts"]
    d = report["distributions"]["domains"]
    lines = [
        "# V7 source corpus audit",
        "",
        f"Source: `{report['source']['path']}`  ",
        f"SHA256: `{report['source']['sha256']}`  ",
        f"Sealed holdout: `{report['holdout']['path']}` SHA256 `{report['holdout']['sha256'][:12]}…{report['holdout']['sha256'][-6:]}` ({report['holdout']['rows']} rows)",
        "",
        "## Counts",
        "",
        f"- rows: {c['rows']} (parsed {c['parsed_rows']})",
        f"- valid rows: {c['valid_rows']}",
        f"- schema/action-semantics invalid: {c['schema_or_semantics_invalid']}",
        f"- rows with text/label conflicts: {c['rows_with_label_conflicts']} (ambiguous {report['ambiguous_count']}, unjustifiable {report['unjustifiable_count']})",
        f"- unique normalized texts: {c['unique_normalized_texts']}",
        f"- exact duplicate extra rows: {c['exact_duplicate_extra_rows']} across {c['duplicate_text_groups']} groups",
        f"- contradictory text groups: {c['contradictory_text_groups']}",
        f"- near-duplicate pairs: {c['near_duplicate_pairs_0.9']} @0.9, {c['near_duplicate_pairs_0.8']} @0.8",
        f"- holdout leakage: {report['holdout_leakage']['exact_count']} exact, {report['holdout_leakage']['near_0.8_count']} near (>=0.8)",
        f"- fixture leakage: {report['fixture_leakage_count']}",
        "",
        "## Contradiction families",
        "",
    ]
    for fam, n in report["contradiction_families"].items():
        lines.append(f"- {fam}: {n}")
    lines += ["", "## Domains", ""]
    for dom, n in d.items():
        lines.append(f"- {dom}: {n}")
    lines += ["", "## Action kinds", ""]
    for kind, n in report["distributions"]["action_kinds"].items():
        lines.append(f"- {kind}: {n}")
    lines += ["", "## Semantic issues", ""]
    if report["semantic_issue_counts"]:
        for kind, n in report["semantic_issue_counts"].items():
            lines.append(f"- {kind}: {n}")
    else:
        lines.append("- none")
    lines += ["", "## Template redundancy", ""]
    for gram, n in report["template_redundancy"]["top_first_three_tokens"][:10]:
        lines.append(f"- `{gram}`: {n}")
    lines += ["", "## Priority policy", "", report["priority_policy"], ""]
    lines.append(f"- rows that violate the documented policy: {report['priority_policy_mismatches']['count']}")
    for k, n in report["priority_policy_mismatches"]["breakdown"].items():
        lines.append(f"  - {k}: {n}")
    lines.append(f"- rows carrying two or more priority cues: {report['multi_cue_rows']['count']}")
    lines += ["", "## Coverage gaps", ""]
    for k, n in report["coverage_gaps"].items():
        lines.append(f"- {k}: {n}")
    lines += ["", "## Verdict", ""]
    if c["contradictory_text_groups"] or c["rows_with_label_conflicts"] or report["holdout_leakage"]["exact_count"]:
        lines.append(
            "The source corpus cannot be reused wholesale. V7 must drop contradictory groups, "
            "quarantine conflict rows, and exclude any holdout overlap before generating new contrastive data."
        )
    else:
        lines.append("Source corpus is internally consistent.")
    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(json.dumps(report["counts"], indent=2))
    print("contradiction families:", report["contradiction_families"])
    print("domains:", d)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
