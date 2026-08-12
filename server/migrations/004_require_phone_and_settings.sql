-- 1. Every order must carry a phone number.
--
-- Replaces the phone-or-email rule: SMS is now the guaranteed channel and email
-- is a bonus. Added NOT VALID on purpose — it enforces the rule on every insert
-- and update from here on, without failing the migration on historical rows
-- created under the old rule. To adopt those rows, backfill their phone numbers
-- and then run:
--
--   ALTER TABLE orders VALIDATE CONSTRAINT orders_phone_present;
--
-- To find them:
--
--   SELECT id, order_ref, customer_email FROM orders WHERE customer_phone IS NULL;

ALTER TABLE orders DROP CONSTRAINT orders_contact_present;

ALTER TABLE orders
  ADD CONSTRAINT orders_phone_present CHECK (customer_phone IS NOT NULL) NOT VALID;

-- 2. Admin-editable application settings.
--
-- Key/value rather than a column per setting: the set of toggles will grow, and
-- a new one should not need a migration. Defaults live in code
-- (src/services/settingsService.js), so an empty table is a valid state and a
-- row only exists once an admin has changed something.

CREATE TABLE app_settings (
  key           text PRIMARY KEY,
  value         jsonb       NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_id uuid REFERENCES users (id) ON DELETE SET NULL
);

COMMENT ON TABLE app_settings IS
  'Admin-editable settings. Keys are validated against the registry in settingsService.js; unknown keys are rejected.';
