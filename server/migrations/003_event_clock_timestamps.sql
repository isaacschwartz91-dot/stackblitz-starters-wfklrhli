-- Event logs must order correctly *within* a transaction.
--
-- now() returns the transaction start time, so two status events written by one
-- request (e.g. a driver self-assigning and picking up in a single scan) shared
-- a timestamp and came back from an ORDER BY created_at in arbitrary order.
-- clock_timestamp() reads the actual wall clock at statement time, which is what
-- an append-only log wants.
--
-- Only the event tables change. orders.created_at / updated_at deliberately keep
-- now(): a row updated twice in one transaction should show one consistent time.

ALTER TABLE order_status_events     ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE scan_events             ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE order_assignment_events ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE notifications           ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE proof_of_delivery       ALTER COLUMN captured_at SET DEFAULT clock_timestamp();
