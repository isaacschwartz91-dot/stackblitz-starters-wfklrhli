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

### The walking order

**The row order of your sheet is the walking order.** Row 1 is the first thing you pick,
row 2 the second, all the way down. Upload the sheet, press Import, and the pick list
follows it — no checkbox, no second sheet, no per-item setup.

That means the smallest sheet that works is a **single column of product names, listed in
the order they sit on the shelf**:

| `item_name` |
|---|
| Bananas |
| Apples Gala |
| Rye Bread |
| Milk Whole Gallon |
| … |

Add more columns whenever you want more out of it — none are required:

- an **aisle / section / department** column breaks the walk into named stretches with
  step numbers, instead of one continuous run;
- an **item ID / SKU** column makes later re-uploads update products cleanly even when a
  name changes;
- **brand**, **size**, **unit**, **price** and **barcode** all sharpen matching and fill
  in the pick list and the estimated total.

**If your sheet already has a shelf sequence column**, that column wins and the row order
is ignored — the import screen says which one it is using, and offers a checkbox to
override it. You never have to touch that unless you want to.

**Aisles in the order you walk them**, as a separate sheet, if you prefer to state it
explicitly:

| `sequence` | `aisle` | `aisle_name` |
|---|---|---|
| 1 | 1 | Produce |
| 2 | 2 | Bakery |
| 3 | 3 | Dairy |

The `sequence` column is optional here too; without it the row order is the walking order.
An explicit sheet like this always overrides the order worked out from your item sheet.

When the shelves change, correct the sheet and upload it again. The sheet is the source of
truth, so a re-upload re-sets every position in one go.

### Re-uploading

Rows are matched by `item_id` and updated in place; genuinely new rows are added. Nothing
is duplicated. The walking order is replaced wholesale by whatever you upload. The import
summary says exactly how many were added, updated and skipped.

Ready-made examples of all of the above are in [`sample-data/`](sample-data/), including
one workbook that deliberately uses a different store's column names.

### Customers

**Customers → Upload customer list** reads a customer sheet the same way. Only the name is
required; `phone`, `email`, `address` and `notes` are all picked up when present, under
whatever your own headers call them.

| `name` | `phone` | `email` | `address` | `notes` |
|---|---|---|---|---|
| John Cohen | (555) 214-8890 | jcohen@example.com | 14 Elm Street, Apt 3 | Leave with the doorman |

Re-uploading updates the people you already have rather than duplicating them: rows are
tied to existing customers by an ID column if your sheet has one, and otherwise by name.
That matters, because a customer's learned shorthand and their whole order history hang
off their record — updating John Cohen's phone number must not create a second John Cohen.

**Customers → Export CSV** writes the list back out, which doubles as a template.

### Keeping a sheet and the app in step automatically

If your spreadsheet lives online, the app can re-read it for you instead of waiting for an
upload. **Settings → Sheets that update themselves** takes one or more links, each marked
as products, walking order, or customers. They are re-read every time the app is opened,
and on demand with **Read them now**. Edit the sheet, reload the app, and the change is
there.

For Google Sheets use **File → Share → Publish to web → CSV** and paste that address. A
plain `docs.google.com/spreadsheets/…/edit` link is rewritten to its CSV export
automatically, but Google only lets a browser fetch sheets that are actually published, so
the published address is the reliable one. Any other link works too — OneDrive, Dropbox,
your own server — as long as it returns `.xlsx` or `.csv` and permits cross-origin reads.
If a link cannot be read, the screen says so and names the likely reason rather than
failing quietly.

For a linked products sheet, **"Hide products that have been taken off the sheet"** keeps
the catalog honest: anything you delete from the sheet stops matching new orders, while
past orders still show exactly what was picked. Nothing is ever deleted outright.

### Fixing things without a re-upload

**Catalog** is a searchable, editable table — fix a typo or a wrong aisle in place, add a
product, deactivate one, or export the whole catalog to CSV. **Walking order** lets you
reorder aisles with ↑ ↓, rename them, and add any aisle code that products use but the
sheet forgot (the app tells you which ones those are).

---

## Who can get in

Worth understanding before you put the address anywhere, because the honest answer differs
depending on how you have it set up.

**With browser storage (the default), there are no accounts.** Anyone who has the web
address can open the app. What they *cannot* do is see your data: the catalog, customers,
shorthand and orders live in each person's own browser, so a stranger who opens your
address gets an empty copy of the software with none of your store in it. Nothing of yours
travels anywhere.

Two things follow from that, and **Settings → Who can get in** now says both plainly
instead of leaving you to discover them:

- **A passcode on the device.** Set one and this phone, tablet or computer asks for it
  before showing anything — which is what stops a passer-by reading the order history off
  the till tablet. Only a PBKDF2 hash of it is stored, never the passcode. It is per
  device, and it does not restrict the address: a visitor who has never been here has
  nothing to check against, and would just get the same empty copy.
- **Staff accounts, which do restrict the data.** Connect Supabase (below) and the app
  requires a real email-and-password login, with the database itself refusing to hand any
  row to someone who is not signed in. This is the only option here enforced by a server
  rather than by the browser in front of you, and it is the one to use if staff share a
  catalog and an order history.

If you also want the *address* itself private — a gate before the app even loads — that
belongs to your host rather than to this app. Netlify offers site-level password
protection and Netlify Identity; check which is on your plan.

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

### Connecting Supabase at deploy time

Set these in the host's environment settings (Netlify: **Site configuration →
Environment variables**) and every device that opens the site is connected already, with
nothing to type in:

| Variable | |
|---|---|
| `SUPABASE_URL` | also accepted as `VITE_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | also accepted as `VITE_SUPABASE_ANON_KEY`. The **anon public** key — never the service-role key |
| `STORE_NAME` | optional; names the app and its login screen |

The build turns them into a `config.json` published next to the app, which the app reads
at start-up. Anyone can still override it on their own device from Settings, in either
direction, and that choice sticks.

### If the deployed site shows "Page not found"

The build succeeding and the site 404ing at the same time almost always means the host
published a folder with no `index.html` in it. Check, in this order:

1. **Which repository and branch the site is building.** A site pointed at a repository
   that does not hold this code, or at a branch that does not have it, builds something
   else entirely — or nothing.
2. **The deploy took under ten seconds.** A real build here takes roughly 15–30 seconds.
   Anything much faster did not run one, so the publish directory never appeared.
3. **Base directory.** Leave it empty unless the app genuinely lives in a sub-folder.
4. **Publish directory** is `dist/demo/browser` — the `browser` part matters. Angular's
   application builder puts the site one level below the `outputPath` in `angular.json`.

`netlify.toml` in this repository already sets the build command, the publish directory,
the Node version and the SPA redirect, so a correctly connected site needs no settings in
the host's UI at all.


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
after every known aisle. Products with no aisle but a known shelf position form their own
*In shelf order* run after the named aisles; only products with no position at all land in
*Location unknown — fix me*. An incomplete Sheet B degrades; it never scrambles the walk.

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
- **Watching a spreadsheet on your own computer.** Linked sheets have to live at a URL —
  a browser cannot re-read a file sitting on your desktop without you handing it over each
  time. Put the sheet in Google Sheets, OneDrive or Dropbox and link it there.
- **Multiple store locations / multiple shelf layouts.** The schema would need a store ID
  on `items`, `aisles` and `orders`.
- **PDF export** is the browser's *Print → Save as PDF*, not a generated file.
