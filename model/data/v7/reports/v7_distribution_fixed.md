# FLOUNA V7 fixed dataset distribution

Generated 2026-11-16T07:15:44+00:00. Train rows: **4147**; valid rows: 225; private eval rows: 495.

## Domains (train)

| domain | rows | share |
|---|---|---|
| food | 1465 | 35.33% |
| ride | 1250 | 30.14% |
| action | 490 | 11.82% |
| shop | 389 | 9.38% |
| out_of_scope | 295 | 7.11% |
| combo | 140 | 3.38% |
| greeting | 118 | 2.85% |

## System prompts (train)

| prompt | rows | share |
|---|---|---|
| prod_compact | 1871 | 45.12% |
| v6 | 1732 | 41.77% |
| short | 544 | 13.12% |

## Priority (train, per search part)

- food: balanced 67.3%, speed 19.7%, price 8.4%, rating 4.5%
- ride: balanced 78.9%, speed 11.2%, price 6.2%, rating 3.7%
- shop: balanced 67.3%, price 16.2%, rating 12.1%, speed 4.4%

Sealed holdout reference (read-only, not used to tune the mix): balanced 47.8%, speed 30.5%, price 14.3%, rating 7.3%. Training carries more balanced labels because most corpus sentences have no priority cue; cue-bearing rows are expanded, not resampled to match the holdout.

## Label coverage (train)

- food (1465 rows): dietary_any 39.6%, dietary_veg 39.3%, dietary_nonveg 21.1%, eta 21.0%, budget 37.9%
- ride (1250 rows): pickup 20.6%, budget 26.6%, wait 7.9%, schedule 5.1%
- shop (389 rows): budget 60.4%

## Ride vehicles

any 33.7%, cab 31.8%, auto 21.6%, bike 13.0%

## Food dietary

any 39.6%, veg 39.3%, nonveg 21.1%

## Action kinds

cart.add 101, cart.set_qty 72, cart.remove 46, group.create 32, select 31, settings.toggle 23, checkout 23, navigate 22, cart.show 18, cart.clear 18, ride.group 17, ride.book 17, group.show 15, settings.budget 14, settings.language 13, settings.visibility 11, ride.group_mode 9, settings.theme 8

## Entity coverage

- distinct food items: 152
- distinct ride drops: 69
- distinct shop items: 75
- distinct 4-gram text prefixes: 3157

## Imbalance flags

| flag | status | detail |
|---|---|---|
| food_domain_share | OK | {"count": 1465, "share": 0.3533} |
| ride_domain_share | OK | {"count": 1250, "share": 0.3014} |
| action_domain_share | OK | {"count": 490, "share": 0.1182} |
| combo_domain_present | OK | {"count": 140, "share": 0.0338} |
| oos_domain_present | OK | {"count": 295, "share": 0.0711} |
| greeting_domain_present | OK | {"count": 118, "share": 0.0285} |
| short_prompt_share | OK | {"count": 544, "share": 0.1312} |
| vehicle_any_share | OK | {"count": 468, "share": 0.3367} |
| vehicle_cab_share | OK | {"count": 442, "share": 0.318} |
| vehicle_bike_present | OK | {"count": 180, "share": 0.1295} |
| dietary_veg_nonveg_ratio | OK | {"veg": 0.3932, "nonveg": 0.2109} |
| priority_balanced_share | OK | {"count": 2440, "share": 0.721} |
| priority_price_present | OK | {"count": 284, "share": 0.0839} |
| priority_rating_present | OK | {"count": 172, "share": 0.0508} |
| priority_speed_present | OK | {"count": 488, "share": 0.1442} |
| shop_categories_covered | OK | ["fashion", "any", "electronics", "home", "appliances"] |
| all_action_kinds_present | OK | {"kinds": 18} |
| template_prefix_redundancy | OK | {"pick me up from": 42} |

Overall: **no flags**.
