-- Create users_page_ledger table for ledger-based page accounting
-- This table maintains a complete audit trail of all page transactions
CREATE TABLE IF NOT EXISTS users_page_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN ('grant', 'consume')),
    page_source VARCHAR(50) NOT NULL CHECK (page_source IN ('onboarding', 'referral', 'rewarded_video', 'subscription', 'fax_send')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
    reference_id UUID, -- Links to referral, fax job, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_users_page_ledger_user_id ON users_page_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_users_page_ledger_created_at ON users_page_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_users_page_ledger_transaction_type ON users_page_ledger(transaction_type);
CREATE INDEX IF NOT EXISTS idx_users_page_ledger_page_source ON users_page_ledger(page_source);
CREATE INDEX IF NOT EXISTS idx_users_page_ledger_reference_id ON users_page_ledger(reference_id) WHERE reference_id IS NOT NULL;

-- Enable Row Level Security
ALTER TABLE users_page_ledger ENABLE ROW LEVEL SECURITY;

-- Users can only read their own ledger entries
CREATE POLICY "Users can view own page ledger" 
ON users_page_ledger 
FOR SELECT 
TO authenticated 
USING (auth.uid() = user_id);

-- Deny direct insert/update/delete to authenticated users (enforced through stored procedures)
CREATE POLICY "Deny direct modifications to users" 
ON users_page_ledger 
FOR ALL 
TO authenticated 
USING (false);

-- Allow full access only to service role
CREATE POLICY "Service role full access" 
ON users_page_ledger 
FOR ALL 
TO service_role 
USING (true) WITH CHECK (true);

-- Create function to get current page balance for a user
CREATE OR REPLACE FUNCTION get_user_page_balance(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
    current_balance INTEGER;
BEGIN
    SELECT COALESCE(
        (SELECT balance_after 
         FROM users_page_ledger 
         WHERE user_id = p_user_id 
         ORDER BY created_at DESC, id DESC 
         LIMIT 1), 
        0
    ) INTO current_balance;
    
    RETURN current_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to safely consume pages (atomic operation)
CREATE OR REPLACE FUNCTION consume_pages(
    p_user_id UUID,
    p_amount INTEGER,
    p_reference_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    current_balance INTEGER;
    new_balance INTEGER;
BEGIN
    -- Get current balance
    current_balance := get_user_page_balance(p_user_id);
    
    -- Check if sufficient balance
    IF current_balance < p_amount THEN
        RETURN FALSE;
    END IF;
    
    -- Calculate new balance
    new_balance := current_balance - p_amount;
    
    -- Insert consumption record
    INSERT INTO users_page_ledger (
        user_id, 
        transaction_type, 
        page_source, 
        amount, 
        balance_after, 
        reference_id, 
        metadata
    ) VALUES (
        p_user_id,
        'consume',
        'fax_send',
        p_amount,
        new_balance,
        p_reference_id,
        p_metadata
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to grant pages
CREATE OR REPLACE FUNCTION grant_pages(
    p_user_id UUID,
    p_amount INTEGER,
    p_source VARCHAR(50),
    p_reference_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    current_balance INTEGER;
    new_balance INTEGER;
BEGIN
    -- Validate page source
    IF p_source NOT IN ('onboarding', 'referral', 'rewarded_video', 'subscription') THEN
        RAISE EXCEPTION 'Invalid page source: %', p_source;
    END IF;
    
    -- Get current balance
    current_balance := get_user_page_balance(p_user_id);
    
    -- Calculate new balance
    new_balance := current_balance + p_amount;
    
    -- Insert grant record
    INSERT INTO users_page_ledger (
        user_id, 
        transaction_type, 
        page_source, 
        amount, 
        balance_after, 
        reference_id, 
        metadata
    ) VALUES (
        p_user_id,
        'grant',
        p_source,
        p_amount,
        new_balance,
        p_reference_id,
        p_metadata
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;