-- Update cost column in faxes table to be non-null INTEGER with default 0
-- This column stores the credit cost for each fax

-- First, set all NULL values to 0
UPDATE faxes SET cost = 0 WHERE cost IS NULL;

-- Alter the column to be INTEGER (if it's not already) and set default to 0
ALTER TABLE faxes 
    ALTER COLUMN cost TYPE INTEGER USING COALESCE(cost::INTEGER, 0),
    ALTER COLUMN cost SET DEFAULT 0,
    ALTER COLUMN cost SET NOT NULL;

-- Add comment
COMMENT ON COLUMN faxes.cost IS 'Credit cost for this fax (non-null, default 0)';
