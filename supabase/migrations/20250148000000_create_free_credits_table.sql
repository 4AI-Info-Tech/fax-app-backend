-- Create free_credits table for managing non-subscription credits
-- Credits can come from: signup bonus, referrals, watching ads, promotions, etc.
CREATE TABLE IF NOT EXISTS free_credits (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('signup', 'referral', 'ad', 'promotion', 'manual')),
    credit_limit INTEGER NOT NULL CHECK (credit_limit > 0),
    credits_used INTEGER NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    reference_id UUID,
    metadata JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_free_credits_user_id ON free_credits(user_id);
CREATE INDEX IF NOT EXISTS idx_free_credits_type ON free_credits(type);
CREATE INDEX IF NOT EXISTS idx_free_credits_expires_at ON free_credits(expires_at);
CREATE INDEX IF NOT EXISTS idx_free_credits_is_active ON free_credits(is_active);
CREATE INDEX IF NOT EXISTS idx_free_credits_user_active_expiry ON free_credits(user_id, is_active, expires_at);

-- Enable Row Level Security
ALTER TABLE free_credits ENABLE ROW LEVEL SECURITY;

-- Users can only read their own free credits
CREATE POLICY "Users can view own free credits" 
ON free_credits 
FOR SELECT 
TO authenticated 
USING (auth.uid() = user_id);

-- Deny direct modifications to authenticated users
CREATE POLICY "Deny direct modifications to users" 
ON free_credits 
FOR ALL 
TO authenticated 
USING (false);

-- Allow full access only to service role
CREATE POLICY "Service role full access" 
ON free_credits 
FOR ALL 
TO service_role 
USING (true) WITH CHECK (true);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_free_credits_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_free_credits_updated_at
    BEFORE UPDATE ON free_credits
    FOR EACH ROW
    EXECUTE FUNCTION public.update_free_credits_updated_at();

-- ============================================================================
-- Function: Get user's available free credits
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_user_free_credits(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
    total_available INTEGER;
BEGIN
    SELECT COALESCE(SUM(credit_limit - credits_used), 0)
    INTO total_available
    FROM public.free_credits
    WHERE user_id = p_user_id
      AND is_active = true
      AND expires_at > NOW()
      AND credits_used < credit_limit;
    
    RETURN total_available;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

-- ============================================================================
-- Function: Grant free credits to a user
-- ============================================================================
CREATE OR REPLACE FUNCTION public.grant_free_credits(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_amount INTEGER,
    p_expires_at TIMESTAMPTZ DEFAULT NULL,
    p_reference_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    new_id UUID;
    default_expiry TIMESTAMPTZ;
BEGIN
    IF p_type NOT IN ('signup', 'referral', 'ad', 'promotion', 'manual') THEN
        RAISE EXCEPTION 'Invalid credit type: %', p_type;
    END IF;
    
    default_expiry := COALESCE(p_expires_at, NOW() + INTERVAL '1 year');
    
    INSERT INTO public.free_credits (
        user_id, type, credit_limit, credits_used, expires_at, reference_id, metadata, is_active
    ) VALUES (
        p_user_id, p_type, p_amount, 0, default_expiry, p_reference_id, p_metadata, true
    ) RETURNING id INTO new_id;
    
    RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

-- ============================================================================
-- Function: Consume free credits (FIFO by expiry date)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.consume_free_credits(
    p_user_id UUID,
    p_amount INTEGER,
    p_reference_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
    available_credits INTEGER;
    remaining_to_consume INTEGER;
    credit_record RECORD;
    credits_to_use INTEGER;
BEGIN
    available_credits := public.get_user_free_credits(p_user_id);
    
    IF available_credits < p_amount THEN
        RETURN FALSE;
    END IF;
    
    remaining_to_consume := p_amount;
    
    FOR credit_record IN
        SELECT id, credit_limit, credits_used
        FROM public.free_credits
        WHERE user_id = p_user_id
          AND is_active = true
          AND expires_at > NOW()
          AND credits_used < credit_limit
        ORDER BY expires_at ASC, created_at ASC
    LOOP
        IF remaining_to_consume <= 0 THEN
            EXIT;
        END IF;
        
        credits_to_use := LEAST(
            remaining_to_consume,
            credit_record.credit_limit - credit_record.credits_used
        );
        
        UPDATE public.free_credits
        SET credits_used = credits_used + credits_to_use, updated_at = NOW()
        WHERE id = credit_record.id;
        
        remaining_to_consume := remaining_to_consume - credits_to_use;
    END LOOP;
    
    -- Record in credit ledger for audit trail (skip if table doesn't exist)
    BEGIN
        INSERT INTO public.users_credit_ledger (
            user_id, transaction_type, credit_source, amount, balance_after, reference_id, metadata
        ) VALUES (
            p_user_id, 'consume', 'fax_send', p_amount, public.get_user_free_credits(p_user_id),
            p_reference_id, COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('source', 'free_credits')
        );
    EXCEPTION WHEN undefined_table THEN
        NULL;
    END;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

-- ============================================================================
-- Function: Check if user has a paid subscription (not freemium)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_user_paid_subscriber(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    has_paid_subscription BOOLEAN;
BEGIN
    SELECT EXISTS(
        SELECT 1 
        FROM public.user_subscriptions us
        JOIN public.products p ON us.product_id = p.product_id
        WHERE us.user_id = p_user_id
          AND us.is_active = true
          AND (us.expires_at IS NULL OR us.expires_at > NOW())
          AND p.type = 'subscription'
          AND us.product_id != 'freemium_monthly'
    ) INTO has_paid_subscription;
    
    RETURN has_paid_subscription;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

-- ============================================================================
-- Function: Grant signup bonus (5 credits, expires in 1 year)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.grant_signup_bonus(p_user_id UUID)
RETURNS UUID AS $$
DECLARE
    new_credit_id UUID;
BEGIN
    IF EXISTS(
        SELECT 1 FROM public.free_credits 
        WHERE user_id = p_user_id AND type = 'signup'
    ) THEN
        RETURN NULL;
    END IF;
    
    new_credit_id := public.grant_free_credits(
        p_user_id,
        'signup',
        5,
        NOW() + INTERVAL '1 year',
        NULL,
        jsonb_build_object('granted_at', NOW(), 'reason', 'New user signup bonus')
    );
    
    RETURN new_credit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

-- ============================================================================
-- Trigger: Auto-grant signup bonus on new user creation
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user_signup_credits()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM public.grant_signup_bonus(NEW.id);
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to grant signup bonus: %', SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trigger_grant_signup_bonus ON auth.users;
CREATE TRIGGER trigger_grant_signup_bonus
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user_signup_credits();

-- Comments
COMMENT ON TABLE free_credits IS 'Free credits from signup, referrals, ads. Consumed FIFO by expiry.';
COMMENT ON FUNCTION public.get_user_free_credits(UUID) IS 'Returns total available free credits';
COMMENT ON FUNCTION public.grant_free_credits(UUID, VARCHAR, INTEGER, TIMESTAMPTZ, UUID, JSONB) IS 'Grants free credits';
COMMENT ON FUNCTION public.consume_free_credits(UUID, INTEGER, UUID, JSONB) IS 'Consumes free credits FIFO';
COMMENT ON FUNCTION public.is_user_paid_subscriber(UUID) IS 'Checks if user has paid subscription';
COMMENT ON FUNCTION public.grant_signup_bonus(UUID) IS 'Grants 5 signup bonus credits';
COMMENT ON FUNCTION public.handle_new_user_signup_credits() IS 'Trigger function for signup bonus';
