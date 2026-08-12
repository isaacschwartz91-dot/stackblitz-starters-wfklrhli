# Notes, assumptions and decisions

Written while building the system in one pass. Everything here was a judgement
call made without asking; each one is reversible, and the ones most worth a
second opinion are marked **worth confirming**.

## What needs your input

| Thing | Status | What to do |
| ----- | ------ | ---------- |
| Twilio (SMS) | Placeholder credentials in `.env.example` | Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, then `NOTIFICATIONS_DRIVER=live` |
| SendGrid (email) | Placeholder credentials | Set `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, then `NOTIFICATIONS_DRIVER=live` |
| Object storage | Defaults to local disk | Set `STORAGE_DRIVER=s3` plus the `S3_*` variables for any S3-compatible bucket |
| `JWT_SECRET` | Dev default | Required in production — the app refuses to start without it. `openssl rand -base64 48` |
| `PUBLIC_BASE_URL` / `API_BASE_URL` | localhost | Set to the real hostnames; they build the customer tracking links and proof-photo links |

Nothing is stubbed out behind a fake: the Twilio and SendGrid calls are real
HTTP requests, and the S3 driver is the real SDK. They are simply not exercised
until credentials exist. Until then `NOTIFICATIONS_DRIVER=log` prints each
message to the server log, which is genuinely useful for checking the copy.

Placeholder-shaped credentials are detected rather than trusted: a message sends
as `skipped` with a reason instead of failing at the provider. If you set real
keys and something is still skipped, `GET /api/notifications/status` says which
channel is missing.

## Ordering decision

You asked for the phases in order, starting with the schema. I built the six
**backend** phases in order, then the React frontend covering all of them in one
pass, rather than a full stack slice per phase. Scaffolding a React app six
times would have cost more than it taught, and the API for each phase was tested
against a real PostgreSQL database as it was written. Every phase is separately
committed.

## The existing Angular starter

The repo arrived as an empty StackBlitz **Angular** starter, and your stack
specified React. I left the Angular files (`src/`, `angular.json`,
`tsconfig*.json`, root `package.json`, `netlify.toml`) untouched rather than
deleting files I did not create. Nothing in the delivery system references them.

Note that the **root** `package.json` is still the Angular one, so `npm start`
at the repo root runs `ng serve`, not this app. Run the commands from `server/`
and `web/` as in the README. To remove the scaffold:

```bash
git rm -r src angular.json tsconfig.json tsconfig.app.json netlify.toml package.json package-lock.json
```

## Data model decisions

**The status log is separate from the scan log.** `order_status_events` is the
audit trail of what happened to a parcel; `scan_events` records every scan
including rejected ones. They answer different questions — "what happened to
this order" versus "what did this person scan" — and merging them would mean
either losing rejected scans or polluting the lifecycle with non-events. A
driver scanning the wrong parcel is exactly the event an operations lead needs
to see, so a rejection is written on its own connection before the error is
thrown (by then the request's transaction is being rolled back).

**The delivery clock is denormalised onto `orders`.** `ready_at`,
`picked_up_at` and `delivered_at` duplicate information in the status log, so
scan-to-delivery time is a single-row read rather than a self-join per order.
`ready_at` is only ever set once (`COALESCE`), so a redelivery does not restart
the clock — otherwise every reattempted order would under-report its true time.

**Proof of delivery is per attempt.** A failed attempt keeps its photo and
reason when the parcel is redelivered, which is the whole point of having
evidence.

**Event timestamps use `clock_timestamp()`, not `now()`.** Postgres `now()`
returns the transaction start time, so two events written by one request shared
a timestamp and came back from `ORDER BY created_at` in arbitrary order. This
was a real bug, caught by a test asserting the history sequence
(migration `003`).

**Assignment has its own log.** `order_status_events` rejects
`assigned → assigned` (its no-self-transition check is worth keeping), but who
handed which parcel to whom still needs an answer, so re-assignment is recorded
in `order_assignment_events` (migration `002`).

## Behaviour decisions

**Drivers may self-assign at pickup.** If a driver scans an unassigned parcel
that is ready to go, they take ownership of it, and the implicit `assigned` hop
is recorded rather than skipped. Small teams want this; a team with strict
dispatch control does not. Set `ALLOW_DRIVER_SELF_ASSIGN=false` to require a
dispatcher. **Worth confirming** — it depends on how your operation runs.

**Completing a drop-off and uploading the evidence are separable.** A driver
standing in the rain can close the job instantly with a scan and let a 3MB photo
upload (or retry) afterwards; or submit everything in one request. Both paths
land on the same proof row.

**Deleting an order is only possible before its label is scanned.** After that
the order is part of the delivery record and cancelling preserves the history.

**Orders require a phone number or an email address.** Enforced by both a check
constraint and the API. A customer who cannot be notified defeats step 7 of the
workflow, and discovering it at send time is too late. **Worth confirming** if
you have order sources with neither.

**Order reference and barcode value are separate fields.** The reference comes
from your order system; the barcode is generated from an alphabet with no
`0/O`, `1/I/L` so it can be read aloud or typed by hand off a damaged label.
Neither can be edited after creation — a physical label may already be on a
parcel.

**Notifications dedupe twice.** The `(status_event_id, channel)` unique index
makes a replayed transition a no-op, and a per-order template check stops an
un-assign / re-assign cycle from re-announcing dispatch. `out_for_delivery` and
`failed_attempt` are marked repeatable, because a second delivery attempt
genuinely is news.

## Security decisions

**The public tracking payload is an allow-list, not a filtered order.** The
token travels by SMS and gets forwarded and screenshotted, so the page withholds
street address, phone, email, delivery notes and internal IDs, shows a masked
customer name (`Dana W.`) and the destination town only, and shares the driver's
first name only while the parcel is actually out for delivery. A test asserts
these do not leak. **Worth confirming** — some operations do show the full
address; that is a one-line change in `trackingService.js`.

**Tracking tokens are 144 bits of randomness**, never derived from the order
reference, because the page has no login.

**Proof images are never public.** Storage keys never reach a client; reads go
through expiring HMAC-signed URLs. The default lifetime is 7 days
(`STORAGE_URL_TTL_SECONDS`), long enough for a customer to open an SMS link a
few days later. **Worth confirming** if your retention policy differs.

**Uploads are sniffed by magic bytes**, not by the client-supplied content type,
so an executable renamed `photo.png` is rejected.

**Login timing is constant** between "no such account" and "wrong password", and
both return the same message.

## Things I deliberately did not build

- **A queue for notification sending.** Messages are sent inline after the
  status change commits. At a few thousand deliveries a day this is fine; the
  rows are already modelled with `pending`/`failed`/`attempts` and a
  `retryFailed()` function, so moving to a worker is a small change.
- **Refresh tokens.** Sessions are a 12-hour JWT. Adding refresh is contained.
- **Offline scanning.** A driver in a lift with no signal cannot scan. Doing
  this properly means a client-side queue and conflict rules for scans that
  arrive out of order — a real project on its own. **Worth confirming** whether
  your drivers need it.
- **Route optimisation.** Auto-batch deals parcels round-robin by zone; it does
  not sequence a route or plan by distance.
- **Rate limiting** on the public tracking endpoint. Tokens are unguessable, but
  a reverse proxy limit is still worth adding before this faces the internet.

## Verification

- 191 API tests against a real PostgreSQL 16 database, covering the status
  machine, barcode generation, CSV import, scan ingestion and rejections,
  assignment and auto-batching, proof capture and signed URLs, notification
  dispatch and deduping, tracking-page leakage, and the reports.
- The proof-of-delivery suite was also run against the local-disk storage driver
  as well as the in-memory one.
- An 18-step browser test drove the real app end to end: sign-in, order
  creation, label rendering, scanning, dispatch auto-batching, the driver queue,
  pickup, proof capture with a drawn signature, the public tracking page, mobile
  layout, and dark mode. Screenshots were checked by eye.

Three bugs were found by that verification and fixed:

1. **Report counts were multiplied.** Both the per-driver totals and the daily
   volume chart joined two or three one-to-many tables in a single pass,
   producing a cartesian product — a day with 12 created, 10 delivered and 3
   failed reported 360 of each. Both now aggregate each series separately, and
   a regression test asserts the counts.
2. **Printing a label returned 401.** It was a plain `<a href>`, which cannot
   carry a bearer token. The document is now fetched with credentials and opened
   as a blob.
3. **The volume chart rendered as flat lines**, because percentage heights do
   not resolve against a parent with no definite height.
