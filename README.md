# Delivery tracking

Barcode-driven delivery tracking: staff create orders and print labels, a scan
starts the delivery clock, drivers scan at pickup and drop-off, customers get
notified and can follow a public tracking link, and admins get reports.

```
server/   Node + Express + PostgreSQL API
web/      React (Vite) app — staff, driver and customer screens
```

## Requirements

- Node 20.11+
- PostgreSQL 13+ (uses `gen_random_uuid()`, built in since 13)

## Getting started

```bash
# 1. Database
createdb delivery_tracking
createdb delivery_tracking_test        # only needed to run the tests

# 2. API
cd server
cp .env.example .env                   # then edit DATABASE_URL and JWT_SECRET
npm install
npm run migrate                        # create the schema
npm run seed                           # one user per role + a few orders
npm run dev                            # http://localhost:4000

# 3. Web app (in a second terminal)
cd web
npm install
npm run dev                            # http://localhost:5173
```

Open http://localhost:5173 and sign in. `npm run seed` prints the accounts it
created:

| Role       | Email                  | Password        |
| ---------- | ---------------------- | --------------- |
| Admin      | `admin@example.com`    | `admin12345`    |
| Dispatcher | `dispatch@example.com` | `dispatch12345` |
| Driver     | `driver1@example.com`  | `driver12345`   |

For a fuller dataset — three weeks of deliveries across four zones, with failed
attempts and redeliveries, so the reports have something to show:

```bash
cd server && npm run demo      # clears existing orders first
```

## Commands

| Where    | Command                  | Does                                          |
| -------- | ------------------------ | --------------------------------------------- |
| `server` | `npm run dev`            | API with reload on change                     |
| `server` | `npm run migrate`        | Apply pending migrations                      |
| `server` | `npm run migrate:status`  | Show applied and pending migrations           |
| `server` | `npm run seed`           | Users and sample orders (idempotent)          |
| `server` | `npm run demo`           | Realistic demo dataset (destructive)          |
| `server` | `npm test`               | Full test suite against `TEST_DATABASE_URL`   |
| `web`    | `npm run dev`            | Vite dev server, proxies `/api` to port 4000  |
| `web`    | `npm run build`          | Production build into `web/dist`              |

## How the workflow maps to the app

1. **Create an order** — Orders → *New order*, or *Import CSV* for a batch.
   Every order needs a phone number (delivery updates go out by SMS); email is
   optional. Each order gets a unique barcode value and an unguessable tracking
   token.
2. **Print the label** — order detail → *Print label*. A 4×6in label with a
   Code 128 barcode, a QR code carrying the same value, and the tracking URL.
3. **Scan to start tracking** — Scan → camera or type the code → *Mark ready for
   delivery*. This scan is what starts the delivery clock.
4. **Assign** — Dispatch shows what is waiting per zone. Assign a zone to one
   driver, or tick several to split the round evenly between them.
5. **Driver scans** — the driver's queue lists their parcels. Scanning at pickup
   moves the parcel to *out for delivery*; at the door they complete it.
6. **Proof of delivery** — photo (rear camera on a phone), signature on the
   canvas, recipient name and notes. A failed attempt records a reason instead.
7. **Customer updates** — SMS/email at dispatch, out for delivery, delivered and
   failed attempt. The delivered message links to the proof photo.
8. **Public tracking** — `/track/<token>`, no login. Shows less than the internal
   view by default: town-level destination only, no street address, phone, email
   or delivery notes. An admin can reveal the street address, phone and notes
   individually under **Settings → Public tracking page**; email is never shown.
9. **Reports** — scan-to-delivery time (median and p90, not just the mean),
   deliveries per driver per day, failed and reattempted deliveries, all
   exportable as CSV.

## Roles

| Capability                        | Admin | Dispatcher | Driver         |
| --------------------------------- | :---: | :--------: | :------------: |
| Create / edit / import orders     |   ✓   |     ✓      |                |
| Activate a label by scanning      |   ✓   |     ✓      |                |
| Assign drivers, auto-batch a zone |   ✓   |     ✓      |                |
| Pickup and drop-off scans         |   ✓   |            | own parcels    |
| Capture proof of delivery         |   ✓   |     ✓      | own parcels    |
| Reports and CSV export            |   ✓   |     ✓      |                |
| View settings                     |   ✓   |  read-only |                |
| Change settings, manage users, delete orders | ✓ |      |                |

## Settings

Two kinds, deliberately separated:

- **Runtime settings** live in the database and are changed by an admin at
  **Settings** in the top nav. Today these are the three public-tracking
  visibility toggles, all off by default. Dispatchers see the page read-only.
- **Deployment configuration** lives in `server/.env` and is shown read-only on
  the same page — driver self-assignment, storage driver, and which notification
  providers are wired up — so it is visible without shell access.

## Configuration

Everything lives in `server/.env` — see `server/.env.example` for the full list
with comments. The defaults run the whole system with no third-party accounts:
proof images go to local disk and notifications are printed to the server log.

To go live, set real credentials for:

- **`STORAGE_DRIVER=s3`** plus `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, and `S3_ENDPOINT` for non-AWS providers (Cloudflare
  R2, MinIO, Backblaze B2).
- **`NOTIFICATIONS_DRIVER=live`** plus `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM_NUMBER` for SMS, and `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`
  for email.

Placeholder credentials are detected: a message is recorded as `skipped` with a
reason rather than failing at send time. `GET /api/notifications/status` reports
which channels are actually wired up.

In production `JWT_SECRET` is required and the app refuses to start with the
development default.

## Testing

```bash
cd server && npm test
```

191 tests covering the status machine, barcode generation and normalisation, CSV
import, scan ingestion including rejected scans, assignment and auto-batching,
proof-of-delivery capture and signed URLs, notification dispatch and deduping,
the public tracking payload, and the reports. They run against a real PostgreSQL
database (`TEST_DATABASE_URL`), which the suite truncates between cases — point
it at a throwaway database, never at your development one.

## Notes

See [NOTES.md](NOTES.md) for design decisions, assumptions, and what still needs
real credentials.
