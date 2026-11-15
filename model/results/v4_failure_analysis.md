# V4 baseline — manual failure analysis

16 prompts from the task spec were sent to
`Qwen/Qwen2.5-1.5B-Instruct` + `flouna-lora-v4-baseline` (checkpoint 200) with
the 402-token compact training prompt, greedy decoding. Raw responses are in
`results/v4_manual_raw.json`; nothing below was edited.

| # | Prompt | Raw response (verbatim) | Verdict |
|---|---|---|---|
| 1 | order me a pizza under 300 rupees | `{"domain":"food","reply":"Got it, finding the best deal for you.","food":{"item":"pizza","budgetPaise":30000,"maxEtaMinutes":null,"dietary":"any","priority":"balanced"}}` | Correct |
| 2 | find me a cheap pizza | `{"domain": "food", "reply": "Searching for pizza across platforms.", "food": {"item": "pizza", "budgetPaise": 10000, "maxEtaMinutes": null, "dietary": "any", "priority": "price"}}` | **Fail**: priority correct, but invents `budgetPaise: 10000` |
| 3 | I need food quickly | `{"domain": "food", "reply": "Searching for food across platforms.", "food": {"item": "food", "budgetPaise": null, "maxEtaMinutes": null, "dietary": "any", "priority": "speed"}}` | Correct (generic item) |
| 4 | find me something affordable | `{"domain": "food", "reply": "Searching for something affordable across platforms.", "food": {"item": "something affordable", "budgetPaise": null, "maxEtaMinutes": null, "dietary": "any", "priority": "price"}}` | **Fail**: item is a filler phrase, not a product |
| 5 | show me non-veg biryani | `{"domain": "food", "reply": "Searching for biryani across platforms.", "food": {"item": "biryani", "budgetPaise": null, "maxEtaMinutes": null, "dietary": "nonveg", "priority": "speed"}}` | Dietary correct; priority should be balanced (no speed cue) |
| 6 | find non vegetarian food | `{"domain": "food", "reply": "Searching for non-vegetarian food across platforms.", "food": {"item": "non-vegetarian", "budgetPaise": null, "maxEtaMinutes": null, "dietary": "nonveg", "priority": "speed"}}` | Dietary correct; item and priority wrong |
| 7 | what is the fastest option | `{"domain": "speed", "reply": "Let me find the fastest option for you!", "speed": "speed", "scheduleAt": null}}` | **Fail**: invalid domain, flat root fields, malformed JSON |
| 8 | I don't want to wait | `{"domain": "out_of_scope", "reply": "I can help you order food, book rides, or shop. What would you like?"}` | Ambiguous (no product/ride named); schema valid |
| 9 | tell me a joke | `{"domain": "out_of_scope", "reply": "I can help you order food, book rides, or shop. What would you like?"}` | Correct |
| 10 | who won the cricket match | `{"domain": "out_of_scope", ...same reply...}` | Correct |
| 11 | what is the weather today | `{"domain": "out_of_scope", ...same reply...}` | Correct |
| 12 | explain quantum computing | `{"domain": "out_of_scope", ...same reply...}` | Correct |
| 13 | I want pizza | `{"domain": "food", "reply": "Looking up pizza deals for you.", "food": {"item": "pizza", "budgetPaise": null, "maxEtaMinutes": null, "dietary": "any", "priority": "balanced"}}` | Correct |
| 14 | I want vegetarian pizza under 300 | `{"domain": "food", "reply": "Searching for pizza across platforms.", "food": {"item": "pizza", "budgetPaise": 30000, "maxEtaMinutes": null, "dietary": "nonveg", "priority": "rating"}}` | **Fail**: dietary `nonveg` for a vegetarian request; priority `rating` not `balanced` |
| 15 | I want chicken biryani delivered quickly | `{"domain":"food","reply":"Got it, finding the best deal for you.","food":{"item":"chicken","budgetPaise":null,"maxEtaMinutes":null,"dietary":"nonveg","priority":"speed"}}` | **Fail**: item `chicken` instead of `biryani`; dietary/priority correct |
| 16 | I need a cab to the airport | `{"domain":"ride","reply":"On it, comparing ride options for you.","ride":{"pickup":null,"drop":"the airport","vehicle":"cab","budgetPaise":null,"maxPickupMinutes":null,"priority":"balanced","scheduleAt":null}}` | Correct |

Result: 8 correct, 4 hard failures, 3 partial/label failures, 1 ambiguous case.

## Failure classes and root causes

### F1. Dietary cue inversion / omission (prompts 14, and 133 veg→any rows in eval)

The V4 corpus has 1,525 food rows but only 107 explicit dietary labels (34 veg,
73 nonveg). A `veg` mention is therefore weaker evidence than the generic
`any` default, and the model frequently predicts `any` or even `nonveg`.
V5 adds 1,769 `veg` and 1,034 `nonveg` rows with varied wording
(`vegetarian`, `pure veg`, `non-veg`, `non vegetarian`, `chicken`, `mutton`,
`meat`, `fish`, `prawn`, `egg`). The canonical enum stays `veg`/`nonveg`/`any`.

### F2. Priority drift (prompts 5, 6, 14)

V4 has 903 speed vs 939 price rows, but the speed cue templates also contain
words like `delivered`/`quickly` that co-occur with food items; the model
over-predicts `speed` for neutral requests (`balanced → speed` 37 rows,
`speed → balanced` 31). V5 contains 1,706 price-cue rows and 1,058 speed-cue
rows built so the label is exactly the cue, plus 5,452 `balanced` rows with no
cue, including explicit negative controls ("show me pizza" → balanced).

### F3. Item extraction picks the modifier (prompts 4, 6, 15)

"chicken biryani" → `chicken`, "non vegetarian food" → `non-vegetarian`.
V4 templates often placed the cuisine first. V5 adds item-position paraphrases
(`biryani, chicken please`, `I want chicken biryani`) and label conflicts are
rejected by the validator (a food item must not be a dietary word or filler).

### F4. Phantom budgets (prompt 2)

`cheap` was treated as an amount cue in a share of V4 rows. V5 clears budgets
when no numeric amount is present (60 repaired rows) and the validator checks
that a non-null `budgetPaise` has a matching amount in the text.

### F5. Default pickup `MG Road` (ride rows)

283/1,403 baseline predictions carry `ride.pickup: "MG Road"` even when the
text names no pickup. V4 ride data over-used that string. V5 ride rows use
`pickup: null` unless the text names a pickup, with varied pickup strings
(`office`, `hotel`, `Bandra station`, `Manikonda`, …), so the shortcut is
broken.

### F6. Invalid domain / flat output (prompt 7)

The model emitted `"domain":"speed"` with flat `speed`/`scheduleAt` keys.
This is the V4 flat-structure failure resurfacing when the prompt has no
domain noun. V5 trains only the nested schema (`food`/`ride`/`shop` objects)
and the validator rejects any root key outside
`domain/reply/food/ride/shop`; the V5 holdout includes bare ambiguous
priority-only prompts.

### F7. OOS → greeting

Only 1/44 OOS rows in this checkpoint, but it is the known production failure.
V4 had 23 OOS rows. V5 has 75 OOS rows with the exact hard negatives from the
spec (weather, cricket, quantum, Python, president, joke, translation,
airplanes, Elon Musk, capital of Japan) plus conversational non-greetings
("ok", "hmm", "what can you do"), and keeps greetings separate. The prompt
also maps unrecognised requests to `out_of_scope`, never `greeting`.

## Eval-level evidence (1,403 rows)

| Observation | Count |
|---|---:|
| `ride.pickup = "MG Road"` | 283 |
| `veg → any` (dietary cue missed) | 133 |
| `balanced → speed` | 37 |
| `speed → balanced` | 31 |
| `balanced → price` | 13 |
| `speed → price` | 11 |
| `price → speed` | 7 |
| `out_of_scope → greeting` | 1 |
| `out_of_scope → shop/ride/food` | 6 |
| non-canonical dietary strings (`non veg`, `vegetarian`) | 3 |
| flat structures | 0 |
| JSON parse failures | 0 |

## What V5 changes (all verifiable in `train_mlx_v5.jsonl`)

- 10,166 rows; canonical enums only; nested schema only.
- 75 OOS rows, 32 greetings, 461 combos, 1,172 shop rows, 3,854 ride rows.
- 2,803 explicit dietary labels; 1,706 price-cue and 1,058 speed-cue rows.
- 4,335 rows with 2+ constraints; 9,035 rows with an explicit `null` field.
- `pickup` is null unless named; budgets require an explicit amount.
- `validate_dataset.py`: 0 hard failures, 0 cross-split overlap, 0 fixture
  overlap, 1 near-duplicate warning (intentional word-order pair).
