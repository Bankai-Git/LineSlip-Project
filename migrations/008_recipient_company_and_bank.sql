ALTER TABLE slips
  ADD COLUMN recipient_company_name TEXT,
  ADD COLUMN bank_name TEXT;

ALTER TABLE slips DROP COLUMN recipient_name;
