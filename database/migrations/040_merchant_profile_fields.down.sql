ALTER TABLE merchants
  DROP COLUMN IF EXISTS webhook_url,
  DROP COLUMN IF EXISTS support_email,
  DROP COLUMN IF EXISTS description;