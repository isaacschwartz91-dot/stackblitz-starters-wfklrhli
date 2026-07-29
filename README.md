# SCN Food Order Builder

A point-of-service tool for a grocery store that is an approved provider of
nutrition services under a New York State Social Care Network. Staff or the
customer build a food order that must meet per-member serving minimums across
configurable food categories, stay under a dollar cap, and produce a
breakfast/lunch/supper meal plan for the benefit period.

## Running it

```bash
npm install
npm run build:client          # builds the Angular app into dist/demo/browser
npm run serve:api             # serves the API and the built client on :4000
```

On first run the server creates the database, seeds an example program
profile and starter catalogue, and prints a generated admin password **once**:

```
[setup] Created the first admin account: admin@store.local
[setup] Temporary password: <generated>
```

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to choose your own. Other environment
variables: `PORT`, `DB_PATH`, `STATIC_DIR`, `SECURE_COOKIES=1` (set this
whenever the app is served over TLS), `TRUST_PROXY=1` (only when a reverse
proxy sits in front, otherwise clients can spoof their IP past the rate
limiter).

## Deploying it

The app is a single Node process serving both the API and the built client,
with SQLite on disk. It needs **a persistent disk** — the database is a file,
and without one every restart wipes the orders.

A `Dockerfile` and a Render blueprint (`render.yaml`) are included. The
runtime image carries no `node_modules` at all: the server imports only Node
built-ins, and Node strips the TypeScript types itself.

### Render (no command line needed)

1. Push this branch to GitHub.
2. Render dashboard → **New** → **Blueprint** → pick this repository.
3. Render reads `render.yaml` and prompts for two values:
   - `ADMIN_EMAIL` — the first admin sign-in
   - `ADMIN_PASSWORD` — 10+ characters
4. **Apply**. First build takes a few minutes.
5. Open the URL Render gives you and sign in with those credentials.

The blueprint asks for the Starter plan because the free plan has no
persistent disk. On free, the database resets on every restart — fine for a
look, not for real records.

### Any Docker host

```bash
docker build -t scn-food-order-builder .
docker run -d -p 4000:4000 \
  -v scn-data:/data \
  -e ADMIN_EMAIL=you@store.example \
  -e ADMIN_PASSWORD='choose-a-long-one' \
  -e SECURE_COOKIES=0 \
  scn-food-order-builder
```

Set `SECURE_COOKIES=1` once it is behind HTTPS — with it on, the session
cookie is refused over plain HTTP and sign-in will appear to silently fail.
Set `TRUST_PROXY=1` only when a reverse proxy sits in front; otherwise clients
can spoof their IP past the rate limiter.

### What will not work

Netlify, Vercel static, GitHub Pages, and StackBlitz cannot host this. They
serve static files or short-lived functions; this needs a long-running process
and a disk that survives restarts. The old `netlify.toml` has been removed
because it pointed at a static publish directory that would have deployed a
site with no working API.

## Tests

```bash
npm test          # 131 unit and API tests, no test dependencies
npm run test:e2e  # 38 checks driven through a real browser (server must be up)
```

`npm test` uses Node's built-in test runner and TypeScript support. There is
no Jest, Vitest, or Karma. The end-to-end suite uses Playwright and drives the
built client against the real server.

## How it is put together

```
src/shared/    pure domain code — runs in the browser AND on the server
  units.ts       integer money and serving arithmetic
  compliance/    the pass/fail engine
  mealplan/      the meal-plan allocator
server/        zero-dependency API (node:sqlite, node:crypto)
src/app/       Angular client
```

The compliance engine is shared deliberately. The browser runs it so the panel
is instant on every tap; the server runs it again at finalize so the record
never depends on arithmetic the browser did.

### Numbers

Money is integer cents. Servings are integer quarter-servings. Meal splits are
integer basis points. No floating-point value ever reaches a comparison that
decides whether an order qualifies.

### What the server does not trust

Line prices, serving counts, and categories are read from the catalogue
server-side — a client that posts its own price is ignored. Ownership is
resolved from the database on every request; an `accountId` in a request body
does nothing. A customer asking for another customer's order gets `404` with a
body identical to a genuinely missing id, so ids cannot be used to enumerate
who is on the program.

## Configuration, not code

Everything the SCN contract dictates is entered in **Admin → Program rules**:
categories, servings per member per day, days covered, cap amount, whether the
cap is per member or per order, meal splits, and shelf-life horizons. None of
it is a constant in the source.

Editing the arithmetic of a profile creates a **new version**. Orders already
completed keep the version they were built against, so their totals and
printed records never move.

## Decisions still open

These are live settings with a documented default, not guesses baked into
code. The store owner should confirm each one:

| Question | Where it lives | Default |
|---|---|---|
| Which categories exist, and their crediting unit | Admin → Categories | fruit / vegetable / protein / starch, cup-eq and oz-eq |
| Per-category maximum, minimum-variety rule | Admin → Program rules | both off |
| Are non-creditable items (cooking oil) allowed | Admin → Program rules | allowed, budget only |
| Hide or flag items conflicting with a restriction | order builder | flag, so staff can explain why |
| Is a barcode scanner at the counter | order builder | shown |
| Password or emailed/texted code at sign-in | both are built | both offered |
| Languages beyond English and Spanish | `src/app/core/i18n.ts` | English, Spanish |
| Record retention period | server | follow the contract |

## Before this handles real member data

- **One-time code delivery is a stub.** Codes are printed to the server log.
  The sign-in and password-reset flows are complete and tested end to end, but
  a real email/SMS provider must be wired into `deliverCode` in
  `server/index.ts` first.
- **Serve over TLS** and set `SECURE_COOKIES=1`.
- **Have the SCN agreement reviewed.** Whether this arrangement is subject to
  HIPAA depends on the store's agreement with the SCN lead entity. The tool
  stores only a sign-in identifier, a referral ID, and a member count — no
  address, date of birth, diagnosis, or referral reason — but that scoping
  decision is not a substitute for legal advice.
- **Write the credential-compromise process** (NFR-9). The mechanics exist:
  staff can revoke every session for an account, force a password reset, and
  clear a lockout. The written procedure is a store decision.

## Known gaps

- The plan is a list of component servings, not named dishes. A recipe layer
  is out of scope for the first version (spec section 9).
- Suggestions rank purely by servings per dollar, as specified. On a thin
  catalogue that produces a cheap but monotonous basket. Turning on the
  minimum-variety rule per category is the intended remedy.
