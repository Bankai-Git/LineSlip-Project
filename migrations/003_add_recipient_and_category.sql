ALTER TABLE slips ADD COLUMN recipient_name TEXT;
ALTER TABLE slips ADD COLUMN ai_category TEXT NOT NULL DEFAULT 'other'
  CHECK (ai_category IN ('food', 'groceries', 'transport', 'bills', 'shopping', 'transfer', 'health', 'other'));

CREATE INDEX slips_user_date_confirmed_idx
  ON slips (line_user_id, transaction_date, status);
