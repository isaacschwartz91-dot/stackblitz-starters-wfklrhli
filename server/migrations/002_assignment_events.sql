-- Assignment audit.
--
-- order_status_events cannot carry a re-assignment (assigned -> assigned is
-- rejected by its no-self-transition check, and rightly so: the parcel's
-- lifecycle stage did not change). Who handed which parcel to whom is still
-- something a dispatcher has to be able to answer, so it gets its own log.

CREATE TABLE order_assignment_events (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  -- NULL from = the parcel was unassigned; NULL to = it was returned to the queue.
  from_driver_id uuid REFERENCES users (id) ON DELETE SET NULL,
  to_driver_id   uuid REFERENCES users (id) ON DELETE SET NULL,

  assigned_by_id uuid REFERENCES users (id) ON DELETE SET NULL,

  -- 'manual', 'auto_batch', 'self_assign'
  method text NOT NULL,
  notes  text,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_assignment_events_method_valid CHECK (
    method IN ('manual', 'auto_batch', 'self_assign')
  ),
  CONSTRAINT order_assignment_events_changes_something CHECK (
    from_driver_id IS DISTINCT FROM to_driver_id
  )
);

CREATE INDEX order_assignment_events_order_idx
  ON order_assignment_events (order_id, created_at DESC);
CREATE INDEX order_assignment_events_driver_idx
  ON order_assignment_events (to_driver_id, created_at DESC);
