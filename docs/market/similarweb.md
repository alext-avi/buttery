# Market snapshot (Similarweb)

Web traffic for the tools people use today to plan meals, list groceries and look up how long food
keeps. It's pulled from the Similarweb API for **June–August 2026**, worldwide, all devices. The
raw data is in [`similarweb-2026-08.json`](similarweb-2026-08.json) and the script is
[`scripts/similarweb-market.mjs`](../../scripts/similarweb-market.mjs).

| Group | Site | Visits in Aug 2026 | Avg. visit (Jun–Aug mean) | Bounce (Jun–Aug mean) |
|---|---|---|---|---|
| Recipe demand | allrecipes.com | **75.6M** | 2m 37s | 62% |
| Grocery | instacart.com | **48.1M** | 5m 06s | 43% |
| Meal planning / recipes | eatthismuch.com | 1.65M | 1m 17s | 55% |
| | supercook.com (cook with what you have) | 629K | 1m 49s | 36% |
| | plantoeat.com | 449K | **4m 42s** | **29%** |
| | samsungfood.com (formerly Whisk) | 407K | 1m 56s | 44% |
| | mealime.com | 127K | 1m 27s | 43% |
| | paprikaapp.com | 80K | 57s | 42% |
| Lists / household organizers | cozi.com | 1.39M | 1m 30s | 46% |
| | anylist.com | 390K | 1m 25s | 57% |
| | ourgroceries.com | 332K | 1m 47s | 41% |
| **Shelf-life lookups** | stilltasty.com | 94K | **42s** | 51% |
| | eatbydate.com | 47K | 57s | 47% |

## What it suggests for the pitch

1. **Cooking and grocery shopping are mass behaviors, but organizing the food in between is not.**
   Recipe and grocery sites draw tens of millions of visits a month. The tools that track what's
   on hand draw hundreds of thousands. People cook and shop at scale, but few keep an inventory.
   That's the gap Buttery fills by making the record a by-product of talking to an assistant.
2. **People already ask Buttery's core question by hand.** Dedicated shelf-life sites get about
   140K visits a month, with short sessions (42–57 s): one lookup ("how long does opened milk
   last?"), then gone. Buttery answers it automatically for every item on the receipt, with a
   confidence level and a record of which model estimated it.
3. **The engaged users are the ones who maintain a system.** Plan to Eat's long sessions and low
   bounce rate show that people who do keep structured records use them heavily. The barrier is
   the upkeep, which is exactly what Buttery removes.
4. **"Cook with what you have" is a proven want.** SuperCook's model (enter your ingredients, get
   recipes) draws about 630K visits a month. Buttery fills in the ingredients automatically from
   receipts and adds urgency from expiry dates.

## Caveats (please keep these in the deck notes)

- **This is web traffic only.** Most of these products are mainly mobile apps, so web visits
  understate their real usage, a lot for app-first products like Paprika and Mealime. Similarweb's
  app data wasn't pulled.
- The figures are Similarweb's modeled estimates, worldwide, across all devices, including
  subdomains.
- Visits aren't users. Compare them within this table, not against user counts quoted elsewhere.
- `out-of-milk.com` returned no data.
