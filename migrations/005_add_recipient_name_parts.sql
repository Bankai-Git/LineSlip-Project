ALTER TABLE slips
  ADD COLUMN recipient_prefix TEXT,
  ADD COLUMN recipient_first_name TEXT,
  ADD COLUMN recipient_last_name TEXT;

CREATE INDEX slips_user_confirmed_date_range_idx
  ON slips (line_user_id, transaction_date)
  WHERE status = 'confirmed';
