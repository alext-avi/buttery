# Food image fixtures

Eight synthetic images for developing the agent-first kitchen app. Open `index.html` for the gallery. `manifest.json` records expected behavior, SHA-256 hashes, dimensions, provenance, and eight workflow scenarios. Version 2 uses substantially harder fridge images with dense clutter and obstructed views.

| Image | What it exercises |
| --- | --- |
| `images/receipt-warehouse-clean.png` | Six grocery lines; abbreviations; package sizes; yogurt multipack |
| `images/receipt-warehouse-recapture.png` | Same purchase with different pixels; transaction deduplication |
| `images/receipt-mixed-lines.png` | Weighted bananas, quantities, coupon, non-food item, milk return |
| `images/fridge-overstuffed-v2.png` | Dense overlapping packages, stacked leftovers, turned labels, and cloudy drawers |
| `images/fridge-obstructed-v2.png` | Door-rack obstruction, glare, soft foreground, and partially visible produce |
| `images/recipe-complete.png` | Two servings; eight ingredients; fractions; optional Parmesan; four steps |
| `images/recipe-cropped.png` | Partial extraction; ask for missing ingredients and methods |
| `images/meal-skillet.png` | Ingredient candidates; uncertain protein; no automatic consumption event |

## Use in development

1. Give the vision/agent flow one image plus its `suggested_user_message` from the manifest. Start with an isolated synthetic household.
2. Keep evaluator files separate: do not send the manifest, source HTML, generation prompts, or expected JSON to the model being evaluated. Avoid descriptive filenames as model-visible hints when running formal evaluations.
3. Compare extracted data with `sources/expected-text.json` for text images and the conservative `expected`/`must_not` annotations for photos. The full recipe must not leak into the cropped-recipe test.
4. Exercise the manifest scenarios: exact retries, recapture deduplication, receipt/photo reconciliation, occlusion, incomplete recipes, ambiguous cooking, fresh-session state recovery, and recipe-to-shopping shortfalls.

The photo annotations were visually reviewed during creation. They are not a measured physical inventory. A dairy-style jug, for example, is not proof of milk contents or a remaining quantity when its label is hidden. Accept uncertainty and plausible tentative alternatives; do not score hidden prompt details or an exhaustive package count as facts. The fridge photos are independent scenes, and the skillet is not proof that the captured recipe was followed. Targeted follow-up photos are appropriate when the visible evidence cannot resolve a needed item.

The earlier easy fridge images and their annotations are retained under `retired/fridge-v1/`. They are excluded from the active manifest, gallery, and `images/` directory. Use the manifest or active `images/` directory rather than recursively collecting all PNGs in the pack.

Receipt data proves a purchase within the fictional scenario, not the current remaining inventory. A return should be reconciled against a matching lot before removal. The fictitious local transaction timestamps have no encoded timezone. The pack's prices and taxes are fabricated and are not intended to model tax rules.

## Sources and regeneration

- Three active photo PNGs: generated using the **built-in image_gen tool**. Exact prompts are in `sources/imagegen-prompts.json`. Version 2 fridge edit prompts and retained input references are in `sources/fridge-v2-prompts.json`; their visual review is in `sources/fridge-v2-review.json`. Annotations describe the output. Regeneration will produce different images and requires a new visual review.
- Five text PNGs: rendered from original HTML by local Playwright/Chromium. Receipt merchants and transactions are fictional; the recipe is original synthetic content. No external images or copied recipe text were used.
- `sources/render-fixtures.cjs` holds the structured text data and render code. Generated HTML is retained alongside it for inspection. Fonts and Chromium versions can change the pixel output across machines; the current PNGs are the reference assets.
- `sources/annotations.json` holds the behavioral expectations and scenarios. `sources/catalog.cjs` assembles the manifest and standalone gallery and verifies asset metadata, arithmetic, and capture assumptions.

From the repository root:

```sh
node tests/fixtures/food-images/sources/render-fixtures.cjs
node tests/fixtures/food-images/sources/catalog.cjs
```

Rendering uses this project's installed Playwright and Chromium. The photo generation prompts are documented but are not executed by these scripts. If text or layouts change, inspect the PNGs and update annotations before refreshing the catalog. No production app endpoints are called.

## Scope

These are starter fixtures, not measured extraction results. They have not been run through the application's ingestion pipeline. The receipt images are clean HTML renders with a modest recapture variation; they do not cover real thermal-paper fading, severe blur, folds, handwriting, diverse retailer layouts, languages, or lighting conditions. Add consented real-world examples as those cases become relevant.
