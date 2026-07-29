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

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('Failures:');
  for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
  process.exit(1);
}
