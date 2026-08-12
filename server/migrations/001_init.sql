-- Delivery tracking: initial schema.
--
-- Data model notes:
--  * `orders` holds current state only. Every transition is also appended to
--    `order_status_events`, which is the audit trail the admin reports read from.
--  * `scan_events` records every physical scan, including rejected ones (unknown
--    barcode, wrong status, wrong driver). Rejected scans never reach
--    `order_status_events`, so the two tables answer different questions:
--    "what happened to this order" vs "what did this person scan".
--  * Timestamps that reports depend on (`ready_at`, `picked_up_at`,
--    `delivered_at`) are denormalised onto `orders` so scan-to-delivery time is
--    a single-row read instead of a self-join over the event log.

CREATE TYPE user_role AS ENUM ('admin', 'dispatcher', 'driver');

-- The lifecycle. `ready_for_delivery` is only reachable through a label scan:
-- that scan is what starts the delivery clock.
CREATE TYPE order_status AS ENUM (
  'created',
  'ready_for_delivery',
  'assigned',
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'cancelled'
);

CREATE TYPE scan_type AS ENUM ('label_activation', 'pickup', 'dropoff');

CREATE TYPE delivery_outcome AS ENUM ('delivered', 'failed');

CREATE TYPE notification_channel AS ENUM ('sms', 'email');

CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed', 'skipped');

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  full_name     text        NOT NULL,
  password_hash text        NOT NULL,
  role          user_role   NOT NULL,
  phone         text,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without depending on the citext extension.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_role_idx ON users (role) WHERE is_active;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- CSV import batches
-- ---------------------------------------------------------------------------

CREATE TABLE order_import_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename       text,
  uploaded_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  total_rows     integer NOT NULL DEFAULT 0,
  created_count  integer NOT NULL DEFAULT 0,
  failed_count   integer NOT NULL DEFAULT 0,
  row_errors     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_import_batches_created_at_idx ON order_import_batches (created_at DESC);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Merchant-facing identifier supplied by staff (the "order ID" on the packing
  -- slip). Unique so a CSV re-upload cannot silently duplicate an order.
  order_ref    text NOT NULL,

  -- What is actually encoded on the label. Kept separate from order_ref so the
  -- label stays valid if a merchant ever renumbers their orders, and so the
  -- scannable value can be constrained to an unambiguous alphabet.
  barcode_value text NOT NULL,

  -- Unguessable token for the public tracking page (no login required, so the
  -- sequential order_ref must not be the key).
  tracking_token text NOT NULL,

  status       order_status NOT NULL DEFAULT 'created',

  customer_name  text NOT NULL,
  customer_phone text,
  customer_email text,

  address_line1 text NOT NULL,
  address_line2 text,
  city          text,
  region        text,
  postal_code   text,
  country       text,

  -- Free-form grouping key used by the dispatcher's auto-batch-by-zone flow.
  delivery_zone  text,
  delivery_notes text,

  assigned_driver_id uuid REFERENCES users (id) ON DELETE SET NULL,
  assigned_by_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  assigned_at        timestamptz,

  -- Delivery clock. ready_at is set by the label-activation scan and is the
  -- start point for the scan-to-delivery report.
  ready_at     timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,

  attempt_count integer NOT NULL DEFAULT 0,

  created_by_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  import_batch_id uuid REFERENCES order_import_batches (id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orders_order_ref_key      UNIQUE (order_ref),
  CONSTRAINT orders_barcode_value_key  UNIQUE (barcode_value),
  CONSTRAINT orders_tracking_token_key UNIQUE (tracking_token),

  -- A customer with no phone and no email cannot be notified at all; require at
  -- least one channel up front rather than discovering it at send time.
  CONSTRAINT orders_contact_present CHECK (
    customer_phone IS NOT NULL OR customer_email IS NOT NULL
  ),

  -- Guard the denormalised clock against impossible states.
  CONSTRAINT orders_delivered_has_ready CHECK (
    delivered_at IS NULL OR ready_at IS NOT NULL
  ),
  CONSTRAINT orders_picked_up_after_ready CHECK (
    picked_up_at IS NULL OR ready_at IS NULL OR picked_up_at >= ready_at
  )
);

CREATE INDEX orders_status_idx        ON orders (status);
CREATE INDEX orders_created_at_idx    ON orders (created_at DESC);
CREATE INDEX orders_zone_idx          ON orders (delivery_zone) WHERE delivery_zone IS NOT NULL;
CREATE INDEX orders_import_batch_idx  ON orders (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- Driver queue view: "my open orders, oldest first".
CREATE INDEX orders_driver_queue_idx
  ON orders (assigned_driver_id, status, ready_at)
  WHERE assigned_driver_id IS NOT NULL;

-- Dispatcher queue view: unassigned work waiting to be batched by zone.
CREATE INDEX orders_unassigned_idx
  ON orders (delivery_zone, ready_at)
  WHERE assigned_driver_id IS NULL AND status = 'ready_for_delivery';

-- Case-insensitive lookup by merchant order reference.
CREATE INDEX orders_order_ref_lower_idx ON orders (lower(order_ref));

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Scan events
-- ---------------------------------------------------------------------------

-- Every scan attempt, accepted or not. order_id is nullable because a scan of an
-- unknown barcode still deserves a row (it is how you catch mislabelled parcels).
CREATE TABLE scan_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid REFERENCES orders (id) ON DELETE CASCADE,
  scanned_value text      NOT NULL,
  scan_type     scan_type NOT NULL,
  scanned_by_id uuid      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  accepted         boolean NOT NULL,
  rejection_reason text,

  device_label text,
  latitude     numeric(9, 6),
  longitude    numeric(9, 6),

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scan_events_rejection_reason_present CHECK (
    accepted OR rejection_reason IS NOT NULL
  ),
  CONSTRAINT scan_events_accepted_has_order CHECK (
    NOT accepted OR order_id IS NOT NULL
  ),
  CONSTRAINT scan_events_latitude_range CHECK (
    latitude IS NULL OR latitude BETWEEN -90 AND 90
  ),
  CONSTRAINT scan_events_longitude_range CHECK (
    longitude IS NULL OR longitude BETWEEN -180 AND 180
  )
);

CREATE INDEX scan_events_order_idx   ON scan_events (order_id, created_at DESC);
CREATE INDEX scan_events_scanner_idx ON scan_events (scanned_by_id, created_at DESC);
CREATE INDEX scan_events_rejected_idx
  ON scan_events (created_at DESC) WHERE NOT accepted;

-- ---------------------------------------------------------------------------
-- Status log
-- ---------------------------------------------------------------------------

CREATE TABLE order_status_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  -- NULL on the row recorded at order creation.
  from_status order_status,
  to_status   order_status NOT NULL,

  -- NULL when the transition was made by a background job rather than a person.
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,

  -- How the transition was triggered: 'scan', 'manual', 'import', 'system'.
  source text NOT NULL,

  scan_event_id uuid REFERENCES scan_events (id) ON DELETE SET NULL,

  notes     text,
  latitude  numeric(9, 6),
  longitude numeric(9, 6),

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_status_events_source_valid CHECK (
    source IN ('scan', 'manual', 'import', 'system')
  ),
  CONSTRAINT order_status_events_no_self_transition CHECK (
    from_status IS NULL OR from_status <> to_status
  )
);

CREATE INDEX order_status_events_order_idx ON order_status_events (order_id, created_at);
CREATE INDEX order_status_events_actor_idx ON order_status_events (actor_id, created_at DESC);

-- Per-driver / per-day reporting reads this heavily.
CREATE INDEX order_status_events_to_status_idx
  ON order_status_events (to_status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Proof of delivery
-- ---------------------------------------------------------------------------

-- One row per drop-off attempt, so a failed attempt keeps its evidence when the
-- order is redelivered.
CREATE TABLE proof_of_delivery (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  attempt_number integer          NOT NULL,
  outcome        delivery_outcome NOT NULL,

  scan_event_id uuid REFERENCES scan_events (id) ON DELETE SET NULL,

  recipient_name text,
  failure_reason text,
  notes          text,

  -- Object-storage keys, not public URLs: links to proof images are handed out
  -- as short-lived signed URLs at read time.
  photo_key     text,
  signature_key text,

  captured_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  captured_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proof_of_delivery_attempt_key UNIQUE (order_id, attempt_number),
  CONSTRAINT proof_of_delivery_attempt_positive CHECK (attempt_number > 0),
  CONSTRAINT proof_of_delivery_failure_reason_present CHECK (
    outcome <> 'failed' OR failure_reason IS NOT NULL
  )
);

CREATE INDEX proof_of_delivery_order_idx ON proof_of_delivery (order_id, attempt_number DESC);

-- ---------------------------------------------------------------------------
-- Customer notifications
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  channel      notification_channel NOT NULL,
  recipient    text                 NOT NULL,
  template_key text                 NOT NULL,

  -- The status change that triggered this message.
  status_event_id uuid REFERENCES order_status_events (id) ON DELETE SET NULL,

  status       notification_status NOT NULL DEFAULT 'pending',
  provider     text,
  provider_ref text,
  error        text,
  attempts     integer NOT NULL DEFAULT 0,

  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,

  -- One message per channel per status change: replaying a status transition
  -- must not re-text the customer.
  CONSTRAINT notifications_dedupe_key UNIQUE (status_event_id, channel)
);

CREATE INDEX notifications_order_idx ON notifications (order_id, created_at DESC);
CREATE INDEX notifications_pending_idx
  ON notifications (created_at) WHERE status = 'pending';
