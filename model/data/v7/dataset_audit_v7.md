# V7 source corpus audit

Source: `train_mlx_v6.jsonl`  
SHA256: `3b8a991102b1aab0f5ce075b6ad23690773d7a625c5e6104d267da392f5d3fde`  
Sealed holdout: `eval_mlx_v5.jsonl` SHA256 `f412d8fc2d53…0e603a` (382 rows)

## Counts

- rows: 11418 (parsed 11418)
- valid rows: 11418
- schema/action-semantics invalid: 0
- rows with text/label conflicts: 0 (ambiguous 0, unjustifiable 0)
- unique normalized texts: 11418
- exact duplicate extra rows: 0 across 0 groups
- contradictory text groups: 0
- near-duplicate pairs: 1 @0.9, 9 @0.8
- holdout leakage: 0 exact, 0 near (>=0.8)
- fixture leakage: 0

## Contradiction families


## Domains

- food: 4905
- ride: 4284
- shop: 1321
- combo: 570
- action: 193
- out_of_scope: 105
- greeting: 40

## Action kinds

- cart.add: 38
- navigate: 24
- settings.toggle: 22
- settings.budget: 16
- ride.group: 13
- group.create: 12
- select: 10
- settings.language: 10
- cart.set_qty: 7
- cart.remove: 6
- cart.show: 6
- ride.book: 5
- ride.group_mode: 5
- settings.visibility: 5
- checkout: 4
- settings.theme: 4
- cart.clear: 3
- group.show: 3

## Semantic issues

- priority_balanced_with_cue: 425
- generic_food_item: 75
- priority_speed_without_cue: 5
- oos_greeting_short: 1

## Template redundancy

- `get me a`: 265
- `i feel like`: 135
- `i m ordering`: 108
- `dinner for the`: 106
- `could you find`: 102
- `we have guests`: 102
- `which app for`: 91
- `book a ride`: 81
- `need a ride`: 78
- `i want to`: 69

## Priority policy

no-preference phrase > rating word > speed word > price word > deadline > balanced

- rows that violate the documented policy: 163
  - ride:speed->balanced: 86
  - food:balanced->price: 20
  - food:balanced->speed: 13
  - food:speed->price: 11
  - ride:balanced->price: 11
  - food:price->speed: 8
  - shop:balanced->price: 8
  - ride:speed->price: 2
  - ride:price->speed: 2
  - food:speed->balanced: 2
- rows carrying two or more priority cues: 1098

## Coverage gaps

- bare_generic_food_entities: {'count': 4, 'labels': {'thali->food': 1, 'sandwich->food': 1, 'pasta->food': 1, 'pizza->food': 1}}
- ceiling_phrase_rows: 0
- action_rows: 193
- greeting_rows: 40
- oos_rows: 105
- vehicle_any: 1068
- vehicle_cab: 1431
- system_prompt_variants: 1

## Verdict

Source corpus is internally consistent.
