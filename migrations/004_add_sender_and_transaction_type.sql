ALTER TABLE slips
  ADD COLUMN sender_prefix TEXT,
  ADD COLUMN sender_first_name TEXT,
  ADD COLUMN sender_last_name TEXT,
  ADD COLUMN transaction_type TEXT NOT NULL DEFAULT 'other'
    CHECK (transaction_type IN ('transfer', 'bill_payment', 'receive', 'other'));

CREATE INDEX slips_user_date_type_confirmed_idx
  ON slips (line_user_id, transaction_date, transaction_type)
  WHERE status = 'confirmed';
