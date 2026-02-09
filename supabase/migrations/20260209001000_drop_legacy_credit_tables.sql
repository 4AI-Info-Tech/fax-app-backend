-- Finalize migration away from legacy DB credit/subscription accounting.
-- RevenueCat virtual currencies are the source of truth for credits and subscription state.

-- Remove legacy credit/subscription tables.
DROP TABLE IF EXISTS public.free_credits CASCADE;
DROP TABLE IF EXISTS public.user_subscriptions CASCADE;

-- Tighten idempotency for rewarded-ad credit grants.
CREATE UNIQUE INDEX IF NOT EXISTS idx_revenuecat_credit_events_ad_reward_unique
    ON public.revenuecat_credit_events(user_id, event_type, reference_id)
    WHERE event_type = 'ad_reward' AND reference_id IS NOT NULL;

-- Recreate anonymize_user without dependencies on removed tables.
CREATE OR REPLACE FUNCTION public.anonymize_user(p_user_id UUID)
RETURNS TABLE(
    success BOOLEAN,
    contacts_deleted INTEGER,
    faxes_anonymized INTEGER,
    subscriptions_deleted INTEGER,
    free_credits_deleted INTEGER,
    message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_contacts_deleted INTEGER := 0;
    v_faxes_anonymized INTEGER := 0;
    v_subscriptions_deleted INTEGER := 0;
    v_free_credits_deleted INTEGER := 0;
    v_is_anonymized BOOLEAN;
BEGIN
    SELECT is_anonymized
    INTO v_is_anonymized
    FROM public.profiles
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, 0, 0, 0, 'User profile not found'::TEXT;
        RETURN;
    END IF;

    IF v_is_anonymized = TRUE THEN
        RETURN QUERY SELECT FALSE, 0, 0, 0, 0, 'User is already anonymized'::TEXT;
        RETURN;
    END IF;

    -- 1. Delete contacts (personal data).
    DELETE FROM public.contacts WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_contacts_deleted = ROW_COUNT;

    -- 2. Anonymize fax records (keep history, remove user linkage).
    UPDATE public.faxes
    SET user_id = NULL,
        updated_at = NOW()
    WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_faxes_anonymized = ROW_COUNT;

    -- 3. Remove notification settings and reward/usage traces tied to this user.
    DELETE FROM public.user_notification_settings WHERE user_id = p_user_id;
    DELETE FROM public.referral_invites WHERE inviter_user_id = p_user_id OR invitee_user_id = p_user_id;
    DELETE FROM public.rewarded_video_completions WHERE user_id = p_user_id;
    DELETE FROM public.usage WHERE user_id = p_user_id;

    -- 4. Remove RevenueCat credit event audit rows if the table exists.
    IF to_regclass('public.revenuecat_credit_events') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public.revenuecat_credit_events WHERE user_id = $1' USING p_user_id;
    END IF;

    -- 5. Mark profile as anonymized.
    UPDATE public.profiles
    SET is_anonymized = TRUE,
        display_name = NULL,
        scheduled_deletion_at = NULL,
        updated_at = NOW()
    WHERE id = p_user_id;

    RETURN QUERY SELECT
        TRUE,
        v_contacts_deleted,
        v_faxes_anonymized,
        v_subscriptions_deleted,
        v_free_credits_deleted,
        'User anonymized successfully'::TEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.anonymize_user(UUID) TO service_role;

COMMENT ON FUNCTION public.anonymize_user IS 'Anonymize a user account without legacy free_credits/user_subscriptions dependencies';
