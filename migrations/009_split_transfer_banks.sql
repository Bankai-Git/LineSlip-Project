ALTER TABLE slips
  ADD COLUMN sender_bank_name TEXT,
  ADD COLUMN recipient_bank_name TEXT;
ALTER TABLE slips DROP COLUMN bank_name;
