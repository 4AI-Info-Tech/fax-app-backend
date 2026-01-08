-- Migration: Convert page-based counting to credit-based counting
-- This migration renames all page-related columns, tables, and functions to use credit terminology

-- ============================================================================
-- STEP 1: Rename columns in user_subscriptions table
-- ============================================================================

ALTER TABLE user_subscriptions 
RENAME COLUMN page_limit TO credit_limit;

ALTER TABLE user_subscriptions 
RENAME COLUMN pages_used TO credits_used;

-- ============================================================================
-- STEP 2: Rename columns in products table
-- ============================================================================

ALTER TABLE products 
RENAME COLUMN page_limit TO credit_limit;

-- ============================================================================
-- STEP 3: Rename columns in rewarded_video_completions table
-- ============================================================================

ALTER TABLE rewarded_video_completions 
RENAME COLUMN pages_granted TO credits_granted;

-- ============================================================================
-- STEP 4: Rename users_page_ledger table to users_credit_ledger
-- ============================================================================

-- First, drop existing indexes that reference the old table name
DROP INDEX IF EXISTS idx_users_page_ledger_user_id;
DROP INDEX IF EXISTS idx_users_page_ledger_created_at;
DROP INDEX IF EXISTS idx_users_page_ledger_transaction_type;
DROP INDEX IF EXISTS idx_users_page_ledger_page_source;
DROP INDEX IF EXISTS idx_users_page_ledger_reference_id;

-- Drop old policies before renaming table
DROP POLICY IF EXISTS "Users can view own page ledger" ON users_page_ledger;
DROP POLICY IF EXISTS "Deny direct modifications to users" ON users_page_ledger;
DROP POLICY IF EXISTS "Service role full access" ON users_page_ledger;

-- Rename the table
ALTER TABLE users_page_ledger RENAME TO users_credit_ledger;

-- Rename the page_source column to credit_source
ALTER TABLE users_credit_ledger 
RENAME COLUMN page_source TO credit_source;

-- Recreate indexes with new names
CREATE INDEX IF NOT EXISTS idx_users_credit_ledger_user_id ON users_credit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_users_credit_ledger_created_at ON users_credit_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_users_credit_ledger_transaction_type ON users_credit_ledger(transaction_type);
CREATE INDEX IF NOT EXISTS idx_users_credit_ledger_credit_source ON users_credit_ledger(credit_source);
CREATE INDEX IF NOT EXISTS idx_users_credit_ledger_reference_id ON users_credit_ledger(reference_id) WHERE reference_id IS NOT NULL;

-- ============================================================================
-- STEP 5: Update RLS policies for users_credit_ledger
-- ============================================================================

-- Create new policies with updated names (policies were dropped before table rename)
CREATE POLICY "Users can view own credit ledger" 
ON users_credit_ledger 
FOR SELECT 
TO authenticated 
USING (auth.uid() = user_id);

CREATE POLICY "Deny direct modifications to users" 
ON users_credit_ledger 
FOR ALL 
TO authenticated 
USING (false);

CREATE POLICY "Service role full access" 
ON users_credit_ledger 
FOR ALL 
TO service_role 
USING (true) WITH CHECK (true);

-- ============================================================================
-- STEP 6: Update function: get_user_page_balance -> get_user_credit_balance
-- ============================================================================

CREATE OR REPLACE FUNCTION get_user_credit_balance(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
    current_balance INTEGER;
BEGIN
    SELECT COALESCE(
        (SELECT balance_after 
         FROM users_credit_ledger 
         WHERE user_id = p_user_id 
         ORDER BY created_at DESC, id DESC 
         LIMIT 1), 
        0
    ) INTO current_balance;
    
    RETURN current_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop old function
DROP FUNCTION IF EXISTS get_user_page_balance(UUID);

-- ============================================================================
-- STEP 7: Update function: consume_pages -> consume_credits
-- ============================================================================

CREATE OR REPLACE FUNCTION consume_credits(
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
    current_balance := get_user_credit_balance(p_user_id);
    
    -- Check if sufficient balance
    IF current_balance < p_amount THEN
        RETURN FALSE;
    END IF;
    
    -- Calculate new balance
    new_balance := current_balance - p_amount;
    
    -- Insert consumption record
    INSERT INTO users_credit_ledger (
        user_id, 
        transaction_type, 
        credit_source, 
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

-- Drop old function
DROP FUNCTION IF EXISTS consume_pages(UUID, INTEGER, UUID, JSONB);

-- ============================================================================
-- STEP 8: Update function: grant_pages -> grant_credits
-- ============================================================================

CREATE OR REPLACE FUNCTION grant_credits(
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
    -- Validate credit source
    IF p_source NOT IN ('onboarding', 'referral', 'rewarded_video', 'subscription') THEN
        RAISE EXCEPTION 'Invalid credit source: %', p_source;
    END IF;
    
    -- Get current balance
    current_balance := get_user_credit_balance(p_user_id);
    
    -- Calculate new balance
    new_balance := current_balance + p_amount;
    
    -- Insert grant record
    INSERT INTO users_credit_ledger (
        user_id, 
        transaction_type, 
        credit_source, 
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

-- Drop old function
DROP FUNCTION IF EXISTS grant_pages(UUID, INTEGER, VARCHAR, UUID, JSONB);

-- ============================================================================
-- STEP 9: Update function: get_current_user_subscription
-- ============================================================================

-- Drop old function first since return type is changing
DROP FUNCTION IF EXISTS get_current_user_subscription(UUID);

CREATE OR REPLACE FUNCTION get_current_user_subscription(p_user_id UUID)
RETURNS TABLE(
    id UUID,
    user_id UUID,
    product_id TEXT,
    subscription_id TEXT,
    entitlement_id TEXT,
    purchased_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    credit_limit INTEGER,
    credits_used INTEGER,
    available_credits INTEGER,
    billing_period_start DATE,
    billing_period_end DATE,
    is_active BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        us.id,
        us.user_id,
        us.product_id,
        us.subscription_id,
        us.entitlement_id,
        us.purchased_at,
        us.expires_at,
        us.credit_limit,
        us.credits_used,
        GREATEST(0, us.credit_limit - us.credits_used) as available_credits,
        us.billing_period_start,
        us.billing_period_end,
        us.is_active
    FROM user_subscriptions us
    WHERE us.user_id = p_user_id
    AND us.is_active = true
    AND (us.expires_at IS NULL OR us.expires_at > NOW())
    ORDER BY us.created_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- STEP 10: Update function: consume_subscription_pages -> consume_subscription_credits
-- ============================================================================

CREATE OR REPLACE FUNCTION consume_subscription_credits(
    p_user_id UUID,
    p_amount INTEGER,
    p_reference_id UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    current_subscription RECORD;
    available_credits INTEGER;
BEGIN
    -- Get current active subscription
    SELECT * INTO current_subscription
    FROM get_current_user_subscription(p_user_id)
    LIMIT 1;
    
    -- Check if user has active subscription
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Calculate available credits
    available_credits := current_subscription.credit_limit - current_subscription.credits_used;
    
    -- Check if sufficient credits available
    IF available_credits < p_amount THEN
        RETURN FALSE;
    END IF;
    
    -- Update consumed credits
    UPDATE user_subscriptions
    SET credits_used = credits_used + p_amount,
        updated_at = NOW()
    WHERE id = current_subscription.id;
    
    -- Record in credit ledger (consumption as positive amount with consume type)
    INSERT INTO users_credit_ledger (
        user_id, 
        transaction_type, 
        credit_source, 
        amount, 
        balance_after, 
        reference_id, 
        metadata
    ) VALUES (
        p_user_id,
        'consume',
        'subscription',
        p_amount, -- Positive amount for consumption
        get_user_credit_balance(p_user_id) - p_amount,
        p_reference_id,
        jsonb_build_object(
            'subscription_id', current_subscription.subscription_id,
            'product_id', current_subscription.product_id
        )
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop old function
DROP FUNCTION IF EXISTS consume_subscription_pages(UUID, INTEGER, UUID);

-- ============================================================================
-- STEP 11: Update function: reset_subscription_pages -> reset_subscription_credits
-- ============================================================================

CREATE OR REPLACE FUNCTION reset_subscription_credits(
    p_user_id UUID,
    p_new_credit_limit INTEGER,
    p_billing_start DATE DEFAULT NULL,
    p_billing_end DATE DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    current_subscription RECORD;
BEGIN
    -- Get current active subscription
    SELECT * INTO current_subscription
    FROM get_current_user_subscription(p_user_id)
    LIMIT 1;
    
    -- Check if user has active subscription
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Reset credits_used and update billing period
    UPDATE user_subscriptions
    SET credits_used = 0,
        credit_limit = p_new_credit_limit,
        billing_period_start = COALESCE(p_billing_start, CURRENT_DATE),
        billing_period_end = COALESCE(p_billing_end, CURRENT_DATE + INTERVAL '1 month'),
        updated_at = NOW()
    WHERE id = current_subscription.id;
    
    -- Record subscription reset in credit ledger
    PERFORM grant_credits(
        p_user_id,
        p_new_credit_limit,
        'subscription',
        current_subscription.id,
        jsonb_build_object(
            'subscription_id', current_subscription.subscription_id,
            'product_id', current_subscription.product_id,
            'billing_reset', true,
            'previous_limit', current_subscription.credit_limit
        )
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop old function
DROP FUNCTION IF EXISTS reset_subscription_pages(UUID, INTEGER, DATE, DATE);

-- ============================================================================
-- STEP 12: Update function: record_rewarded_video_completion
-- ============================================================================

CREATE OR REPLACE FUNCTION record_rewarded_video_completion(
    p_user_id UUID,
    p_completion_token VARCHAR(100),
    p_ad_unit_id VARCHAR(100)
)
RETURNS BOOLEAN AS $$
DECLARE
    current_month VARCHAR(7);
    completion_count INTEGER;
    can_watch BOOLEAN;
BEGIN
    -- Check if user can watch rewarded video
    can_watch := can_watch_rewarded_video(p_user_id);
    
    IF NOT can_watch THEN
        RETURN FALSE;
    END IF;
    
    -- Get current UTC month
    current_month := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM');
    
    -- Check for duplicate completion token
    IF EXISTS(SELECT 1 FROM rewarded_video_completions WHERE completion_token = p_completion_token) THEN
        RETURN FALSE;
    END IF;
    
    -- Insert completion record
    INSERT INTO rewarded_video_completions (
        user_id,
        completion_token,
        ad_unit_id,
        completed_at,
        credits_granted,
        month_year
    ) VALUES (
        p_user_id,
        p_completion_token,
        p_ad_unit_id,
        NOW(),
        1,
        current_month
    );
    
    -- Grant credits to user
    PERFORM grant_credits(
        p_user_id,
        1,
        'rewarded_video',
        (SELECT id FROM rewarded_video_completions WHERE completion_token = p_completion_token),
        jsonb_build_object('ad_unit_id', p_ad_unit_id, 'completion_token', p_completion_token)
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- STEP 13: Update function: can_watch_rewarded_video (update comment)
-- ============================================================================

-- The function itself doesn't need changes, but we'll recreate it to ensure consistency
CREATE OR REPLACE FUNCTION can_watch_rewarded_video(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    current_month VARCHAR(7);
    completion_count INTEGER;
    is_subscribed BOOLEAN;
BEGIN
    -- Get current UTC month
    current_month := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM');
    
    -- Check if user is subscribed (simplified check - in real implementation would check RevenueCat)
    -- For now, assume user is free if they have any credit ledger entries
    SELECT EXISTS(
        SELECT 1 FROM user_subscriptions 
        WHERE user_id = p_user_id 
        AND is_active = true 
        AND (expires_at IS NULL OR expires_at > NOW())
    ) INTO is_subscribed;
    
    -- Subscribed users cannot watch rewarded videos
    IF is_subscribed THEN
        RETURN FALSE;
    END IF;
    
    -- Get completion count for current month
    completion_count := get_monthly_completion_count(p_user_id, current_month);
    
    -- Check if under monthly cap (15 completions)
    RETURN completion_count < 15;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- STEP 14: Update function: create_freemium_subscription_for_user
-- ============================================================================

CREATE OR REPLACE FUNCTION create_freemium_subscription_for_user(user_uuid UUID)
RETURNS TABLE(
    subscription_id UUID,
    user_id UUID,
    created BOOLEAN
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    existing_count INTEGER;
    new_subscription_id UUID;
BEGIN
    -- Check if user already has any active subscriptions
    SELECT COUNT(*)
    INTO existing_count
    FROM user_subscriptions
    WHERE user_subscriptions.user_id = user_uuid 
      AND is_active = true 
      AND expires_at > NOW();

    -- Only create freemium if user has no active subscriptions
    IF existing_count = 0 THEN
        INSERT INTO user_subscriptions (
            user_id,
            product_id,
            subscription_id,
            entitlement_id,
            purchased_at,
            expires_at,
            credit_limit,
            credits_used,
            is_active
        ) VALUES (
            user_uuid,
            'freemium_monthly',
            NULL, -- Not from RevenueCat
            'freemium',
            NOW(),
            NOW() + INTERVAL '30 days',
            5,
            0,
            true
        ) RETURNING id INTO new_subscription_id;
        
        RETURN QUERY SELECT new_subscription_id, user_uuid, true;
    ELSE
        RETURN QUERY SELECT NULL::UUID, user_uuid, false;
    END IF;
END;
$$;

COMMENT ON FUNCTION create_freemium_subscription_for_user(UUID) IS 'Creates a freemium subscription (5 credits/month) for a specific user if they have no active subscriptions';

-- ============================================================================
-- STEP 15: Add comments to document the migration
-- ============================================================================

COMMENT ON TABLE users_credit_ledger IS 'Ledger-based credit accounting table. Maintains a complete audit trail of all credit transactions. Migrated from users_page_ledger.';
COMMENT ON COLUMN users_credit_ledger.credit_source IS 'Source of the credit transaction. Migrated from page_source.';
COMMENT ON COLUMN user_subscriptions.credit_limit IS 'Maximum credits allowed for this subscription. Migrated from page_limit.';
COMMENT ON COLUMN user_subscriptions.credits_used IS 'Number of credits consumed. Migrated from pages_used.';
COMMENT ON COLUMN products.credit_limit IS 'Credit limit for this product. Migrated from page_limit.';
COMMENT ON COLUMN rewarded_video_completions.credits_granted IS 'Number of credits granted for this completion. Migrated from pages_granted.';

