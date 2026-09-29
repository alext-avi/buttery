// Render original, deterministic text fixtures. Run with: node sources/render-fixtures.cjs
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const receipts = {
  warehouse: {
    merchant: 'PANTRY CLUB', subtitle: 'WAREHOUSE MARKET', transaction_id: 'PC-004218',
    purchased_at_local: '2026-09-28T18:42:00', currency: 'USD',
    rows: [
      { raw: 'WHOLE MILK 1 GAL', item: 'whole milk', quantity: 1, unit: 'package', package_size: { quantity: 1, unit: 'US_gal' }, amount: 5.99, kind: 'food_purchase' },
      { raw: 'EGGS 24 CT', item: 'eggs', quantity: 1, unit: 'package', package_size: { quantity: 24, unit: 'count' }, amount: 6.49, kind: 'food_purchase' },
      { raw: 'BABY SPINACH 16 OZ', item: 'baby spinach', quantity: 1, unit: 'package', package_size: { quantity: 16, unit: 'oz_mass' }, amount: 4.99, kind: 'food_purchase' },
      { raw: 'STRAWBERRIES 2 LB', item: 'strawberries', quantity: 1, unit: 'package', package_size: { quantity: 2, unit: 'lb' }, amount: 8.99, kind: 'food_purchase' },
      { raw: 'CHKN BREAST 3 LB', item: 'chicken breast', quantity: 1, unit: 'package', package_size: { quantity: 3, unit: 'lb' }, amount: 12.99, kind: 'food_purchase' },
      { raw: 'GRK YOGURT 2X32 OZ', item: 'Greek yogurt', quantity: 1, unit: 'multipack', package_count: 2, package_size: { quantity: 32, unit: 'oz_mass' }, amount: 7.49, kind: 'food_purchase' },
    ], subtotal: 46.94, tax: 0, total: 46.94,
  },
  mixed: {
    merchant: 'CORNER PANTRY', subtitle: 'NEIGHBORHOOD MARKET', transaction_id: 'CP-001107',
    purchased_at_local: '2026-09-29T09:16:00', currency: 'USD',
    rows: [
      { raw: 'BANANAS', detail: '1.25 LB @ 0.64/LB', item: 'bananas', quantity: 1.25, unit: 'lb', unit_price: 0.64, amount: 0.80, kind: 'food_purchase' },
      { raw: 'CHERRY TOMATOES 10 OZ', detail: '2 @ 2.49', item: 'cherry tomatoes', quantity: 2, unit: 'package', package_size: { quantity: 10, unit: 'oz_mass' }, unit_price: 2.49, amount: 4.98, kind: 'food_purchase' },
      { raw: 'CHICKPEAS 15 OZ CAN', detail: '4 @ 0.99', item: 'canned chickpeas', quantity: 4, unit: 'can', package_size: { quantity: 15, unit: 'oz_mass' }, unit_price: 0.99, amount: 3.96, kind: 'food_purchase' },
      { raw: 'BABY SPINACH 5 OZ', item: 'baby spinach', quantity: 1, unit: 'package', package_size: { quantity: 5, unit: 'oz_mass' }, amount: 3.49, kind: 'food_purchase' },
      { raw: 'SPINACH COUPON', amount: -0.50, kind: 'discount' },
      { raw: 'PAPER TOWELS 2 ROLL', amount: 6.99, kind: 'non_food_purchase' },
      { raw: 'RETURN: MILK 1/2 GAL', item: 'milk', quantity: 1, unit: 'package', package_size: { quantity: 0.5, unit: 'US_gal' }, amount: -4.29, kind: 'return' },
    ], subtotal: 15.43, tax: 0.56, total: 15.99,
  },
};

const recipe = {
  title: 'Tomato & spinach pasta', servings: 2, total_time_minutes: 20,
  ingredients: [
    { text: '150 g dry fusilli', item: 'dry fusilli', quantity: 150, unit: 'g', optional: false },
    { text: '1 tbsp olive oil', item: 'olive oil', quantity: 1, unit: 'tbsp', optional: false },
    { text: '2 garlic cloves, finely chopped', item: 'garlic', quantity: 2, unit: 'clove', optional: false },
    { text: '200 g cherry tomatoes, halved', item: 'cherry tomatoes', quantity: 200, unit: 'g', optional: false },
    { text: '100 g baby spinach', item: 'baby spinach', quantity: 100, unit: 'g', optional: false },
    { text: '1/2 tsp salt', item: 'salt', quantity: 0.5, unit: 'tsp', optional: false },
    { text: '1/4 tsp black pepper', item: 'black pepper', quantity: 0.25, unit: 'tsp', optional: false },
    { text: '2 tbsp grated Parmesan (optional)', item: 'Parmesan', quantity: 2, unit: 'tbsp', optional: true },
  ],
  steps: [
    'Cook the fusilli according to its package directions. Reserve 1/2 cup of cooking water, then drain.',
    'Warm the oil in a skillet. Add the garlic and stir for 30 seconds. Add the tomatoes and cook for 5 minutes.',
    'Add the spinach, salt, and pepper. Stir for about 2 minutes, until the spinach wilts.',
    'Toss in the pasta. Add a little reserved cooking water if needed. Serve with the optional Parmesan.',
  ],
};

const receiptHtml = (data, recaptured = false) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic receipt fixture</title><style>
* { box-sizing:border-box } body { margin:0; background:${recaptured ? '#a79d91' : '#c8c0b5'}; min-height:1400px; display:grid; place-items:center; padding:72px; color:#24211d; }
.paper { width:600px; padding:44px 35px; background:#fffdf5; box-shadow:0 9px 24px #332b2344; font:22px/1.45 'Courier New',monospace; ${recaptured ? 'transform:rotate(3deg); background:linear-gradient(94deg,#f3efdf,#fffdf5 55%,#e9e3d5);' : ''} }
h1 { font-size:36px; margin:0; text-align:center; letter-spacing:2px } .center { text-align:center } .small { font-size:18px } .rule { border-top:2px dashed #555; margin:23px 0 } .row { display:flex; justify-content:space-between; gap:15px; margin:15px 0 0 } .amount { white-space:nowrap } .detail { font-size:20px; padding-left:20px } .total { font-size:28px; font-weight:bold } p { margin:7px 0 }
</style><body><main class="paper"><h1>${escape(data.merchant)}</h1><p class="center small">${escape(data.subtitle)}</p><div class="rule"></div><p>TXN ${escape(data.transaction_id)}</p><p>${escape(data.purchased_at_local.replace('T', ' '))}</p><p class="small">QTY 1 UNLESS SHOWN BELOW</p><div class="rule"></div>${data.rows.map(row => `<div class="row"><span>${escape(row.raw)}</span><span class="amount">${row.amount.toFixed(2)}</span></div>${row.detail ? `<div class="detail">${escape(row.detail)}</div>` : ''}`).join('')}<div class="rule"></div><div class="row"><span>SUBTOTAL</span><span>${data.subtotal.toFixed(2)}</span></div><div class="row"><span>TAX</span><span>${data.tax.toFixed(2)}</span></div><div class="row total"><span>TOTAL USD</span><span>${data.total.toFixed(2)}</span></div><div class="rule"></div><p class="center small">SYNTHETIC TEST RECEIPT</p><p class="center small">No real purchase or payment</p></main></body></html>`;

const recipeHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(recipe.title)}</title><style>
* { box-sizing:border-box } body { margin:0; font:17px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#273328; background:#fffdf7 } header { padding:15px 24px; border-bottom:1px solid #dfe3d7; font-weight:700; letter-spacing:.03em; } header span { float:right; font-size:11px; padding-top:5px; color:#6a7568; } main { padding:27px 26px 38px; } .eyebrow { color:#62745b; text-transform:uppercase; font-size:11px; letter-spacing:.13em; margin:0 0 10px } h1 { font-family:Georgia,serif; font-size:36px; line-height:1.08; letter-spacing:-.7px; margin:0 0 18px } .intro { color:#64705f; font-size:15px; margin:0 0 18px } .meta { display:flex; gap:12px; font-size:13px; margin-bottom:27px } .meta span { background:#eaf0e3; padding:7px 11px; border-radius:6px } h2 { font:700 23px Georgia,serif; margin:27px 0 13px } ul { list-style:none; padding:0; margin:0 } li.ingredient { padding:9px 0; border-bottom:1px solid #e5e7dc; } ol { padding-left:24px } ol li { margin:0 0 18px; padding-left:5px } .note { background:#f0eee0; border-left:3px solid #a8ae8d; padding:13px; font-size:13px; color:#646951 } footer { margin-top:25px; font-size:11px; color:#7d8174 }
</style><body><header>Weeknight notes <span>TEST KITCHEN</span></header><main><p class="eyebrow">An original fixture recipe</p><h1>${escape(recipe.title)}</h1><p class="intro">A quick skillet dinner with a short ingredient list.</p><div class="meta"><span>Serves ${recipe.servings}</span><span>${recipe.total_time_minutes} minutes</span></div><h2>Ingredients</h2><ul>${recipe.ingredients.map((item,index) => `<li class="ingredient" data-index="${index}">${escape(item.text)}</li>`).join('')}</ul><h2>Method</h2><ol>${recipe.steps.map(text => `<li class="step">${escape(text)}</li>`).join('')}</ol><div class="note">Parmesan is optional. No substitution or dietary guarantee is implied by this recipe.</div><footer>Fictional page · original synthetic test content</footer></main></body></html>`;

(async () => {
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const capture = async (name, html, viewport, fullPage) => {
    fs.writeFileSync(path.join(__dirname, name + '.html'), html);
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(root, 'images', name + '.png'), fullPage });
    const visibleIngredients = await page.locator('.ingredient').evaluateAll(els => els.filter(el => el.getBoundingClientRect().bottom <= innerHeight).map(el => Number(el.dataset.index)));
    const partialIngredients = await page.locator('.ingredient').evaluateAll(els => els.filter(el => el.getBoundingClientRect().top < innerHeight && el.getBoundingClientRect().bottom > innerHeight).map(el => Number(el.dataset.index)));
    await page.close();
    return { id: name, visible_ingredient_indices: visibleIngredients, partial_ingredient_indices: partialIngredients };
  };
  const captures = [];
  try {
    captures.push(await capture('receipt-warehouse-clean', receiptHtml(receipts.warehouse), { width: 900, height: 1400 }, true));
    captures.push(await capture('receipt-warehouse-recapture', receiptHtml(receipts.warehouse, true), { width: 1000, height: 1400 }, true));
    captures.push(await capture('receipt-mixed-lines', receiptHtml(receipts.mixed), { width: 900, height: 1500 }, true));
    captures.push(await capture('recipe-complete', recipeHtml, { width: 430, height: 900 }, true));
    captures.push(await capture('recipe-cropped', recipeHtml, { width: 430, height: 540 }, false));
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(__dirname, 'expected-text.json'), JSON.stringify({ receipts, recipe, cropped_capture: captures.find(c => c.id === 'recipe-cropped') }, null, 2) + '\n');
  console.log(JSON.stringify({ rendered: captures.map(c => c.id), cropped_capture: captures.at(-1) }, null, 2));
})();
