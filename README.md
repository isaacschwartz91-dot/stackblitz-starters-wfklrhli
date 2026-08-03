# Grocery order picking

Takes a messy incoming order — phoned in, or forwarded by email — and turns it into a
**pick list sorted in shelf walking order**, so one person collects everything in a single
pass from the front of the store to the back. It **learns** what each customer means by
their shorthand, so "milk" only has to be explained once.

```
2 milk                 ┌─ 1  Produce ─────────────────┐
dozen eggs             │  ☐ 3 lb   Apples Gala        │
3 lb apples     ───▶   │  ☐ 1      Bananas            │
rye bread              ├─ 2  Bakery ──────────────────┤
pnut butter            │  ☐ 1      Rye Bread Sliced   │
bananas                ├─ 3  Dairy & Eggs ────────────┤
                       │  ☐ 2      Milk 2% Half Gallon│
                       │  ☐ 1 dz   Eggs Large Grade A │
                       ├─ 4  Pantry ──────────────────┤
                       │  ☐ 1      Peanut Butter Creamy│
                       └──────────────────────────────┘
```

---

## Try it in two minutes

```bash
npm install
npm start          # http://localhost:4200
```

Then: **Settings → Load demo store**. That fills the app with a small but realistic
store — 75 products across 8 aisles, three customers, and some shorthand already taught.
Settings also lists three example orders you can copy and paste straight into
**New order** (a phone order, a forwarded email, and one full of typos).

No account, no database and no configuration are needed to do this: everything is stored
in the browser until you connect a cloud database (see [Going multi-user](#going-multi-user)).

---

## How the day-to-day work goes

**Take an order.** *New order* → pick the customer → paste the whole thing into the
box, or type products one at a time in the search box. Both can be mixed on one order.

Quantities and units are read off each line, so all of these do the right thing:

| They said | Quantity | Unit | Product looked up |
|---|---|---|---|
| `2 milk` | 2 | | milk |
| `milk x3` | 3 | | milk |
| `3 lb apples` | 3 | lb | apples |
| `dozen eggs` | 1 | dozen | eggs |
| `- 2 loaves rye bread` | 2 | loaf | rye bread |
| `1/2 lb turkey` | 0.5 | lb | turkey |
| `apples (ripe, not green)` | 1 | | apples, with the aside kept as a note |
| `12 oz sour cream` | 1 | | 12 oz sour cream — a size, not a count |

Email headers, bullets and numbering are stripped. The original line is never thrown
away; it stays next to the match and prints on the pick list as *they said "…"*.

**Check what it matched.** Each line shows the product it found and how it found it —
*Customer shorthand*, *Store shorthand*, *Exact match*, or *Best guess*. Anything the
software is not sure about is highlighted, and there is a **Fix** button next to it.

**Teach it.** Fixing a line offers to remember the correction:

- *Just this once* — no rule saved.
- *Always, for this customer* — `for John Cohen, "milk" = Farmland 2% Half Gallon`.
- *Always, for everyone* — `"pnut butter" = Peanut Butter Creamy`.

A customer's own shorthand always wins over the store-wide list. Every rule is listed,
searchable and editable under **Shorthand**.

**Pick it.** *Save & open pick list* produces the walk: aisles in walking order with the
step number and aisle name as a header, items in shelf order inside each aisle, a big
checkbox on every line, and a **Needs attention** block at the top for anything unmatched
or ambiguous — so nothing can go quietly missing. Tick items off on a phone while
walking, mark something out of stock and choose a substitute (the walk re-routes to the
substitute's shelf), then **Print**, **Copy as text** or **Email** it.

**Find it later.** Every order is kept. *Orders* searches by customer, note, status and
date; any order can be reopened, reprinted, or duplicated as the start of a new one.
A customer's last order can be pulled in with one click on the new-order screen.

---

## Loading your store's spreadsheets

**Catalog → Upload sheets** (or **Walking order → Upload sheet**) accepts `.xlsx`,
`.xls` and `.csv`. Your two sheets can arrive as two files, two tabs of one workbook, or
a single combined sheet — all three work.

Every sheet found is previewed before anything is written: what it thinks the sheet is
for, and which of your columns maps to which field. Both are dropdowns, so a wrong guess
costs one click.

### Sheet A — master item list

| Column | Required | Example | Notes |
|---|---|---|---|
| `item_id` | preferred | `1042` | If missing, a stable ID is generated from name + brand + size, so re-uploading still updates instead of duplicating. |
| `item_name` | **yes** | `Milk 2% Half Gallon` | |
| `brand` | no | `Farmland` | Helps tell similar products apart. |
| `size` | no | `1/2 gal` | |
| `department` | no | `Dairy` | |
| `aisle` | for sorting | `3` | Should match a code in Sheet B. |
| `shelf_sequence` | for sorting | `3.4` | Position within the aisle. |
| `unit` | no | `each` | |
| `price` | no | `3.49` | Used for the estimated total. |
| `barcode` | no | `07049…` | Also matchable. |

Your real column names do not have to look like this. `SKU`, `Description`,
`Manufacturer`, `Pack Size`, `Aisle #`, `Shelf Seq`, `UOM` and `Retail` are all
recognised, along with many other spellings — and anything unrecognised can be mapped by
hand in the preview.

### Sheet B — walking order

**Option 1** — list the aisles in the order you walk them:

| `sequence` | `aisle` | `aisle_name` |
|---|---|---|
| 1 | 1 | Produce |
| 2 | 2 | Bakery |
| 3 | 3 | Dairy |

The `sequence` column is optional; without it, the row order *is* the walking order.

**Option 2** — give one sheet with every item already in exact shelf order. Tick
**"These rows are already in exact shelf walking order"** in the import preview, and the
row position becomes each item's shelf sequence, with the aisle order taken from where
each aisle first appears.

### Re-uploading

Rows are matched by `item_id` and updated in place; genuinely new rows are added. Nothing
is duplicated. The walking order is replaced wholesale by whatever you upload. The import
summary says exactly how many were added, updated and skipped.

Ready-made examples of all of the above are in [`sample-data/`](sample-data/), including
one workbook that deliberately uses a different store's column names.

### Fixing things without a re-upload

**Catalog** is a searchable, editable table — fix a typo or a wrong aisle in place, add a
product, deactivate one, or export the whole catalog to CSV. **Walking order** lets you
reorder aisles with ↑ ↓, rename them, and add any aisle code that products use but the
sheet forgot (the app tells you which ones those are).

---

## Going multi-user

Out of the box everything lives in the browser (IndexedDB). That is genuinely usable for
one person on one machine, but staff will not share a catalog or an order history. To put
it in the cloud:

1. Create a project at [supabase.com](https://supabase.com) (the free tier is enough to
   start).
2. Open **SQL Editor → New query**, paste all of [`supabase/schema.sql`](supabase/schema.sql)
   and run it. That creates every table, the staff/admin roles, and row-level security
   rules — staff can run orders and teach shorthand; only admins can change the catalog
   and the shelf layout.
3. Add your staff under **Authentication → Users**. Then promote whoever should be an
   admin:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@yourstore.com';
   ```
4. In the app: **Settings → Where the data lives** → paste the project URL and the
   **anon public** key → *Test connection* → *Connect*.

The app then asks for a login, and every signed-in member of staff sees the same catalog,
shelf layout, customers, learned shorthand and order history.

Never paste the service-role key into the app — it belongs on a server, not in a browser.

**Backups.** Supabase takes daily backups on its paid plans. On any plan,
**Settings → Download backup** writes one JSON file holding the catalog, walking order,
customers, shorthand and every order; *Restore from file* puts it back. That same file is
how you move data from a browser to the cloud: download it in local mode, connect
Supabase, then restore.

---

## Deploying

The build is a static site, so any static host works. `netlify.toml` is already set up:

```toml
[build]
command = "npx ng build"
publish = "dist/demo/browser"
```

Point Netlify (or Vercel, Cloudflare Pages, GitHub Pages…) at this repository and it
deploys as-is. There is no server to run: the app talks to Supabase directly from the
browser, and row-level security is what keeps the data safe.

---

## How the matching works

Every order line is resolved in this order, highest priority first:

1. **Customer shorthand** — a rule taught for this customer.
2. **Store shorthand** — a rule taught for everyone.
3. **Exact / normalized match** — blind to case, spacing, punctuation, plurals, word
   order and `%` (`"2% Milk, Half-Gallon"` and `"half gallon 2 percent milk"` land on the
   same product). Bare item IDs and barcodes resolve too.
4. **Fuzzy match** — token coverage, character bigrams and edit distance, blended into a
   0–1 score. Above the confidence threshold the best candidate is accepted; below it, or
   when the top two candidates are neck and neck, the line is flagged and the top
   suggestions are offered.

Both thresholds are adjustable in **Settings → Matching** — raise the first if it guesses
too eagerly, lower it if you are confirming matches that were obviously right.

The catalog is indexed once and held in memory, so a 40-line order against a
20,000-product catalog resolves in a few milliseconds.

**Sorting** is `(aisle walking order, shelf_sequence, name)`. An aisle that appears on a
product but not in Sheet B still sorts sensibly — numerically where it can — but always
after every known aisle, and products with no aisle at all land in a clearly labelled
*Location unknown — fix me* group at the end. An incomplete Sheet B degrades; it never
scrambles the walk.

---

## Code layout

```
src/app/
  core/        models, storage backends, and the services that hold app state
    backend.ts          the storage contract both backends implement
    local-backend.ts    IndexedDB — the zero-setup default
    supabase-backend.ts hosted Postgres over plain fetch (no extra dependency)
    data.service.ts     single source of truth; signals in, writes through
    order.service.ts    raw order text -> matched order lines
  matching/    the engine, all pure functions and fully unit-tested
    normalize.ts    lowercase, de-plural, expand shorthand, strip punctuation
    parse-line.ts   "3 lb apples" -> { qty: 3, unit: 'lb', phrase: 'apples' }
    fuzzy.ts        similarity scoring
    matcher.ts      the priority order above
    pick-list.ts    grouping and walking-order sort
  import/      spreadsheet reading, column detection, and the upload screen
  pages/       one folder per screen
  ui/          shared pieces (product type-ahead, toasts)
supabase/schema.sql   tables, roles and row-level security
sample-data/          example spreadsheets and example orders
```

## Tests

```bash
npm test        # matching engine + spreadsheet importer
npm run build   # production build
```

The tests cover the parts that would be expensive to get wrong: quantity and unit
parsing, normalisation, the alias priority order, fuzzy matching and its ambiguity
handling, the walking-order sort (including missing aisles and substitutions), header
detection against unfamiliar column names, and the stable-ID rule that stops a re-upload
duplicating the catalog.

## Not built yet

- **Automatic email intake.** Pasting a forwarded email works today; polling a dedicated
  inbox would need a small server-side job.
- **Multiple store locations / multiple shelf layouts.** The schema would need a store ID
  on `items`, `aisles` and `orders`.
- **PDF export** is the browser's *Print → Save as PDF*, not a generated file.
