/**
 * End-to-end smoke test in a real browser.
 *
 * Drives the built client against the real server the way a person would:
 * admin signs in and creates a customer, the customer signs in, builds an
 * order, watches the compliance panel, finalizes, and gets a meal plan.
 *
 * Run: node tools/smoke.mjs   (server must already be listening on $BASE)
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4300';
const ADMIN = { id: 'owner@store.test', pw: 'smoke-test-password' };
const CUSTOMER = { id: 'shopper@example.test', pw: 'customer-password-1' };

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('  [page error]', error.message));
  return { context, page };
}

async function signIn(page, who) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#identifier', who.id);
  await page.fill('#password', who.pw);
  await page.click('button[type=submit]');
  await page.waitForTimeout(1200);
}

// ---------------------------------------------------------------- admin
{
  const { context, page } = await newPage();
  await signIn(page, ADMIN);
  check('admin signs in', await page.locator('text=Customers').first().isVisible());

  await page.click('button:has-text("Add customer")');
  await page.fill('#na-name', 'Test Shopper');
  await page.fill('#na-email', CUSTOMER.id);
  await page.fill('#na-pw', CUSTOMER.pw);
  await page.fill('#na-ref', 'SCN-2026-SMOKE');
  await page.fill('#na-members', '3');
  await page.fill('#na-start', '2026-08-03');
  await page.click('button[type=submit]:has-text("Create account")');
  await page.waitForTimeout(1500);
  check('admin creates a customer account', await page.locator(`text=${CUSTOMER.id}`).first().isVisible());
  await context.close();
}

// ------------------------------------------------------------- customer
{
  const { context, page } = await newPage();
  await signIn(page, CUSTOMER);

  check('customer lands on the order screen', await page.locator('text=Build the order').first().isVisible());

  // AC-11: no staff surfaces anywhere in the customer's chrome.
  const chrome = await page.locator('nav.tabs').innerText().catch(() => '');
  check('AC-11 customer sees no staff tabs', !/Customers|Records|Admin/i.test(chrome), chrome.replace(/\n/g, ' '));

  await page.click('button:has-text("Start a new order")');
  await page.waitForTimeout(1200);

  // The requirement is computed from the profile: 3 members x 7 days.
  const railText = await page.locator('#compliance-panel').innerText();
  check('AC-1 requirements shown as 42 / 63 / 63 / 84', /42/.test(railText) && /63/.test(railText) && /84/.test(railText));
  check('AC-1 cap shown as $285.00', /\$285\.00/.test(railText));
  check('empty order does not qualify', /does not qualify/i.test(railText));

  // Add one item, confirm the panel moves.
  const addButtons = page.locator('.tile .qty button[aria-label^="Add"]');
  await addButtons.first().click();
  await page.waitForTimeout(900);
  const afterAdd = await page.locator('#compliance-panel').innerText();
  check('panel updates after adding an item', afterAdd !== railText);

  // FR-16: take the suggestions until the order qualifies.
  for (let round = 0; round < 40; round++) {
    const panel = await page.locator('#compliance-panel').innerText();
    if (/This order qualifies/i.test(panel)) break;
    const suggestion = page.locator('.sug .sug-item .btn:has-text("Add")').first();
    if ((await suggestion.count()) === 0) break;
    await suggestion.click();
    await page.waitForTimeout(450);
  }

  const qualified = await page.locator('#compliance-panel').innerText();
  check('AC-2 suggestions drive the order to qualifying', /This order qualifies/i.test(qualified));

  // AC-9: the customer finalizes with no staff involvement.
  await page.click('#compliance-panel button:has-text("Finalize order")');
  await page.waitForTimeout(2500);
  check('AC-9 customer finalizes unaided', await page.locator('text=Meal plan').first().isVisible());

  // AC-4: a 7-day plan with three meals a day.
  const planText = await page.locator('app-plan').innerText();
  check('AC-4 plan covers 7 days', /Day 7/i.test(planText));
  check("AC-4 plan has all three meals", /breakfast/i.test(planText) && /lunch/i.test(planText) && /supper/i.test(planText));
  check('AC-4 no unfilled meals', !/Not enough food for this meal/i.test(planText));

  // AC-6: the compliance sheet carries the reimbursement figures.
  check('AC-6 compliance sheet present', /Compliance sheet/i.test(planText));
  check('AC-6 sheet shows the referral id', /SCN-2026-SMOKE/i.test(planText));
  check('AC-6 sheet shows cap and total', /Budget cap/i.test(planText) && /Order total/i.test(planText));
  check('AC-6 sheet shows required vs purchased', /Required/i.test(planText) && /Purchased/i.test(planText));

  // FR-30: a reroll produces a different arrangement.
  const before = await page.locator('.days').innerText();
  await page.click('button:has-text("Try a different plan")');
  await page.waitForTimeout(2000);
  const after = await page.locator('.days').innerText();
  check('FR-30 reroll produces a different plan', before !== after);

  // AC-8: every customer screen available in Spanish.
  await page.click('.seg button:has-text("Español")');
  await page.waitForTimeout(700);
  const spanish = await page.locator('app-plan').innerText();
  check("AC-8 meal plan in Spanish", /desayuno/i.test(spanish) && /almuerzo/i.test(spanish) && /cena/i.test(spanish));
  check('AC-8 compliance sheet in Spanish', /Hoja de cumplimiento/i.test(spanish));

  await page.click('nav.tabs button:has-text("Pedido")');
  await page.waitForTimeout(600);
  const orderEs = await page.locator('app-order').innerText();
  check('AC-8 order screen in Spanish', /Porciones requeridas|En este pedido/i.test(orderEs));

  await page.screenshot({ path: '/tmp/scn-order-es.png', fullPage: false });
  await context.close();
}

// --------------------------------------------------- AC-10 cross-customer
{
  const { context, page } = await newPage();
  await signIn(page, CUSTOMER);
  // Ask the server directly, from the signed-in browser, for an id we do not own.
  const probe = await page.evaluate(async () => {
    const r = await fetch('/api/orders/order_someone_else', { credentials: 'same-origin' });
    return { status: r.status, body: await r.text() };
  });
  check('AC-10 cross-customer fetch refused', probe.status === 404, `status ${probe.status}`);

  const admin = await page.evaluate(async () => {
    const r = await fetch('/api/admin/audit', { credentials: 'same-origin' });
    return r.status;
  });
  check('AC-11 customer refused the audit log', admin === 403, `status ${admin}`);
  await context.close();
}


// ------------------------------------------------- AC-7 offline resilience
{
  const { context, page } = await newPage();
  await signIn(page, CUSTOMER);
  await page.click('button:has-text("Start a new order")').catch(() => {});
  await page.waitForTimeout(1200);

  const orderId = await page.evaluate(async () => {
    const r = await fetch('/api/me/orders', { credentials: 'same-origin' });
    const j = await r.json();
    return (j.orders.find((o) => o.status === 'draft') ?? j.orders[0]).id;
  });

  const before = await page.evaluate(async (id) => {
    const r = await fetch('/api/orders/' + id, { credentials: 'same-origin' });
    return (await r.json()).order.lines.length;
  }, orderId);

  // --- pull the cable ---
  await context.setOffline(true);
  await page.waitForTimeout(400);
  check('AC-7 offline is announced to the user',
    /offline/i.test(await page.locator('body').innerText()));

  // Keep working: three more items added with no connection at all.
  const adders = page.locator('.tile .qty button[aria-label^="Add"]');
  for (let i = 0; i < 3; i++) {
    await adders.nth(i).click();
    await page.waitForTimeout(350);
  }
  const offlineLines = await page.locator('#cart-count, .data tbody tr').count().catch(() => 0);
  check('AC-7 the order keeps updating while offline', offlineLines > before, `${offlineLines} rows`);

  // The edit is on disk, not merely in memory.
  const staged = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('scn-drafts');
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('pending').objectStore('pending').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      }),
  );
  check('AC-7 the pending edit is written to IndexedDB', staged.length > 0,
    `${staged.length} staged`);

  // The server has not seen it yet — nothing was silently sent.
  await context.setOffline(false);
  await page.waitForTimeout(2500);

  const after = await page.evaluate(async (id) => {
    const r = await fetch('/api/orders/' + id, { credentials: 'same-origin' });
    return (await r.json()).order.lines.length;
  }, orderId);
  check('AC-7 the queued edit syncs when the connection returns', after > before,
    `${before} lines before, ${after} after`);

  const drained = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('scn-drafts');
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('pending').objectStore('pending').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      }),
  );
  check('AC-7 the queue is cleared once acknowledged', drained.length === 0,
    `${drained.length} left`);

  await context.close();
}

// -------------------------------- AC-7 the edit survives closing the tab
{
  // Same browser context throughout: closing the *page* is closing the tab.
  // A new context would get a fresh IndexedDB and prove nothing.
  const { context, page } = await newPage();
  await signIn(page, CUSTOMER);
  await page.waitForTimeout(1000);

  const orderId = await page.evaluate(async () => {
    const r = await fetch('/api/me/orders', { credentials: 'same-origin' });
    const j = await r.json();
    const d = j.orders.find((o) => o.status === 'draft');
    return d ? d.id : null;
  });

  if (!orderId) {
    check('AC-7 an edit made offline survives closing the tab', false, 'no draft order found');
  } else {
    const before = await page.evaluate(async (id) => {
      const r = await fetch('/api/orders/' + id, { credentials: 'same-origin' });
      return (await r.json()).order.lines.length;
    }, orderId);

    await context.setOffline(true);
    await page.waitForTimeout(300);
    await page.locator('.tile .qty button[aria-label^="Add"]').nth(5).click();
    await page.waitForTimeout(700);

    const staged = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('scn-drafts');
          req.onsuccess = () => {
            const all = req.result.transaction('pending').objectStore('pending').getAll();
            all.onsuccess = () => resolve(all.result.length);
            all.onerror = () => resolve(0);
          };
          req.onerror = () => resolve(0);
        }),
    );
    check('AC-7 the edit is on disk before the tab closes', staged > 0, `${staged} staged`);

    // Slam the tab shut while still offline.
    await page.close();

    // Reopen in the same profile; the session cookie is still there.
    const reopened = await context.newPage();
    await context.setOffline(false);
    await reopened.goto(BASE, { waitUntil: 'networkidle' });
    await reopened.waitForTimeout(3500);

    const after = await reopened.evaluate(async (id) => {
      const r = await fetch('/api/orders/' + id, { credentials: 'same-origin' });
      return (await r.json()).order.lines.length;
    }, orderId);
    check('AC-7 an edit made offline survives closing the tab', after > before,
      `${before} lines before, ${after} after reopening`);
    await context.close();
  }
}


// -------------------------------------- admin rules and catalogue (FR-1..4)
{
  const { context, page } = await newPage();
  await signIn(page, ADMIN);

  await page.click('nav.tabs button:has-text("Admin")');
  await page.waitForTimeout(1200);
  const rules = await page.locator('app-admin').innerText();
  check('FR-1 admin can see the program rules editor', /servings per member per day/i.test(rules));
  check('FR-25 meal splits total 100%', /100%/.test(rules));

  // Change the cap and save as a new version (FR-2).
  await page.fill('#p-cap', '110.00');
  await page.click('app-admin button:has-text("Save as new version")');
  await page.waitForTimeout(2000);
  const saved = await page.locator('app-admin').innerText();
  check('FR-2 saving creates a new version', /version 2/i.test(saved), saved.split('\n').find((l) => /version/i.test(l)) ?? '');

  // A completed order must not move (AC-5 / FR-2).
  const unchanged = await page.evaluate(async () => {
    const r = await fetch('/api/staff/records?status=final', { credentials: 'same-origin' });
    const j = await r.json();
    return j.orders.length === 0 ? null : j.orders[0].order.rulesSnapshot.capTotalCents;
  });
  check('FR-2 an existing order keeps its original cap', unchanged === null || unchanged === 28500,
    `cap on file: ${unchanged}`);

  // Catalogue item editing (FR-4, FR-6).
  await page.click('app-admin nav.tabs button:has-text("Catalogue")');
  await page.waitForTimeout(800);
  await page.click('app-admin button:has-text("Add item")');
  await page.waitForTimeout(400);
  await page.fill('#i-name', 'Smoke Test Lentils');
  await page.fill('#i-price', '3.25');
  await page.fill('#i-serv', '12');
  await page.fill('#i-sku', 'SMOKE-1');
  await page.click('app-admin form button[type=submit]');
  await page.waitForTimeout(1600);
  const afterItem = await page.locator('app-admin').innerText();
  check('FR-4 admin can add a catalogue item', /Smoke Test Lentils/.test(afterItem));

  const stored = await page.evaluate(async () => {
    const r = await fetch('/api/items', { credentials: 'same-origin' });
    const j = await r.json();
    const i = j.items.find((x) => x.name === 'Smoke Test Lentils');
    return i ? { price: i.priceCents, units: i.servingsPerPackageUnits } : null;
  });
  check('FR-4 the item stores integer cents and quarter servings',
    stored !== null && stored.price === 325 && stored.units === 48,
    JSON.stringify(stored));

  await context.close();
}

// ------------------------------------------- customer history (FR-A8, FR-35)
{
  const { context, page } = await newPage();
  await signIn(page, CUSTOMER);
  await page.click('nav.tabs button:has-text("My orders")');
  await page.waitForTimeout(1500);
  const history = await page.locator('app-history').innerText();
  check('FR-A8 the customer sees their own past orders', /\$/.test(history) && !/no orders/i.test(history));

  await page.click('app-history button:has-text("Reprint")').catch(() => {});
  await page.waitForTimeout(1800);
  const reprinted = await page.locator('app-plan').innerText().catch(() => '');
  check('FR-35 a past order reprints its compliance sheet',
    /compliance sheet/i.test(reprinted) && /SCN-2026-SMOKE/.test(reprinted));

  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('Failures:');
  for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
  process.exit(1);
}
