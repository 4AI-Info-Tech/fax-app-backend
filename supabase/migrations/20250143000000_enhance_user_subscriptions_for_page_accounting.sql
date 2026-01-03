-- Enhance existing user_subscriptions table for page accounting system
-- Add missing columns and functions to work with the page accounting system

-- Add billing period tracking columns to existing user_subscriptions table
ALTER TABLE user_subscriptions 
ADD COLUMN IF NOT EXISTS billing_period_start DATE,
ADD COLUMN IF NOT EXISTS billing_period_end DATE;

-- Create indexes for efficient queries on new columns
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_billing_period 
ON user_subscriptions(billing_period_start, billing_period_end) 
WHERE billing_period_start IS NOT NULL AND billing_period_end IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_period 
ON user_subscriptions(user_id, billing_period_start, billing_period_end)
WHERE billing_period_start IS NOT NULL AND billing_period_end IS NOT NULL;

-- Create function to get current active subscription for a user
CREATE OR REPLACE FUNCTION get_current_user_subscription(p_user_id UUID)
RETURNS TABLE(
    id UUID,
    user_id UUID,
    product_id TEXT,
    subscription_id TEXT,
    entitlement_id TEXT,
    purchased_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    page_limit INTEGER,
    pages_used INTEGER,
    available_pages INTEGER,
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
        us.page_limit,
        us.pages_used,
        GREATEST(0, us.page_limit - us.pages_used) as available_pages,
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

-- Create function to consume subscription pages using existing table
CREATE OR REPLACE FUNCTION consume_subscription_pages(
    p_user_id UUID,
    p_amount INTEGER,
    p_reference_id UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    current_subscription RECORD;
    available_pages INTEGER;
BEGIN
    -- Get current active subscription
    SELECT * INTO current_subscription
    FROM get_current_user_subscription(p_user_id)
    LIMIT 1;
    
    -- Check if user has active subscription
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Calculate available pages
    available_pages := current_subscription.page_limit - current_subscription.pages_used;
    
    -- Check if sufficient pages available
    IF available_pages < p_amount THEN
        RETURN FALSE;
    END IF;
    
    -- Update consumed pages
    UPDATE user_subscriptions
    SET pages_used = pages_used + p_amount,
        updated_at = NOW()
    WHERE id = current_subscription.id;
    
    -- Record in page ledger (consumption as positive amount with consume type)
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
        'subscription',
        p_amount, -- Positive amount for consumption
        get_user_page_balance(p_user_id) - p_amount,
        p_reference_id,
        jsonb_build_object(
            'subscription_id', current_subscription.subscription_id,
            'product_id', current_subscription.product_id
        )
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to reset subscription pages for new billing period
CREATE OR REPLACE FUNCTION reset_subscription_pages(
    p_user_id UUID,
    p_new_page_limit INTEGER,
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
    
    -- Reset pages_used and update billing period
    UPDATE user_subscriptions
    SET pages_used = 0,
        page_limit = p_new_page_limit,
        billing_period_start = COALESCE(p_billing_start, CURRENT_DATE),
        billing_period_end = COALESCE(p_billing_end, CURRENT_DATE + INTERVAL '1 month'),
        updated_at = NOW()
    WHERE id = current_subscription.id;
    
    -- Record subscription reset in page ledger
    PERFORM grant_pages(
        p_user_id,
        p_new_page_limit,
        'subscription',
        current_subscription.id,
        jsonb_build_object(
            'subscription_id', current_subscription.subscription_id,
            'product_id', current_subscription.product_id,
            'billing_reset', true,
            'previous_limit', current_subscription.page_limit
        )
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;