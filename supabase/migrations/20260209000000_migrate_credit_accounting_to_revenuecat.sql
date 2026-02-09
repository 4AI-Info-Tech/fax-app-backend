-- Migrate credit accounting ownership from Supabase credit tables to RevenueCat virtual currencies.
-- This migration introduces an idempotency/audit table for backend-side RC credit adjustments
-- and disables legacy auth-user triggers that granted DB credits.

CREATE TABLE IF NOT EXISTS public.revenuecat_credit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL CHECK (event_type IN ('signup_bonus', 'referral_reward', 'ad_reward', 'manual_adjustment')),
    reference_id TEXT,
    credits INTEGER NOT NULL CHECK (credits > 0),
    currency_code VARCHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenuecat_credit_events_user_id
    ON public.revenuecat_credit_events(user_id);

CREATE INDEX IF NOT EXISTS idx_revenuecat_credit_events_event_type
    ON public.revenuecat_credit_events(event_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenuecat_credit_events_signup_unique
    ON public.revenuecat_credit_events(user_id, event_type)
    WHERE event_type = 'signup_bonus';

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenuecat_credit_events_referral_unique
    ON public.revenuecat_credit_events(user_id, event_type, reference_id)
    WHERE event_type = 'referral_reward' AND reference_id IS NOT NULL;

ALTER TABLE public.revenuecat_credit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.revenuecat_credit_events;
CREATE POLICY "Service role full access"
ON public.revenuecat_credit_events
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view own RC credit events" ON public.revenuecat_credit_events;
CREATE POLICY "Users can view own RC credit events"
ON public.revenuecat_credit_events
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Disable legacy trigger-based DB credit grants on auth user creation.
DROP TRIGGER IF EXISTS trigger_grant_signup_bonus ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user_signup_credits() CASCADE;
DROP FUNCTION IF EXISTS public.grant_signup_bonus(UUID) CASCADE;

DROP TRIGGER IF EXISTS on_auth_user_created_referral_check ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user_referral() CASCADE;

-- Remove obsolete DB-credit helpers no longer called by API services.
DROP FUNCTION IF EXISTS public.get_user_free_credits(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.grant_free_credits(UUID, VARCHAR, INTEGER, TIMESTAMPTZ, UUID, JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.consume_free_credits(UUID, INTEGER, UUID, JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.create_freemium_subscription_for_user(UUID) CASCADE;
