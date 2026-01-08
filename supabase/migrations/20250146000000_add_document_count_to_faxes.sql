-- Add document_count column to faxes table
-- This column tracks the number of documents sent in a fax

-- Add the column
ALTER TABLE faxes ADD COLUMN IF NOT EXISTS document_count INTEGER DEFAULT 1;

-- Create an index for better query performance
CREATE INDEX IF NOT EXISTS idx_faxes_document_count ON faxes(document_count);

-- Add comment
COMMENT ON COLUMN faxes.document_count IS 'Number of documents sent in this fax transmission';
