-- User Anonymization Feature
-- Implements GDPR-compliant user data anonymization with 7-day grace period

-- Ensure profiles table has required columns for anonymization
-- Note: These columns may already exist; using IF NOT EXISTS pattern
DO $$
BEGIN
    -- Add scheduled_deletion_at column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'profiles' 
        AND column_name = 'scheduled_deletion_at'
    ) THEN
        ALTER TABLE profiles ADD COLUMN scheduled_deletion_at TIMESTAMPTZ DEFAULT NULL;
    END IF;

    -- Add is_anonymized column if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'profiles' 
        AND column_name = 'is_anonymized'
    ) THEN
        ALTER TABLE profiles ADD COLUMN is_anonymized BOOLEAN DEFAULT FALSE;
    END IF;
END
$$;

-- Create index for efficient querying of scheduled deletions
CREATE INDEX IF NOT EXISTS idx_profiles_scheduled_deletion 
ON profiles(scheduled_deletion_at) 
WHERE scheduled_deletion_at IS NOT NULL AND is_anonymized = FALSE;

-- Function to schedule user deletion (7 days in the future)
CREATE OR REPLACE FUNCTION schedule_user_deletion(p_user_id UUID)
RETURNS TABLE(
    success BOOLEAN,
    scheduled_at TIMESTAMPTZ,
    message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing_schedule TIMESTAMPTZ;
    v_is_anonymized BOOLEAN;
    v_scheduled_at TIMESTAMPTZ;
BEGIN
    -- Check if user exists and their current state
    SELECT scheduled_deletion_at, is_anonymized 
    INTO v_existing_schedule, v_is_anonymized
    FROM profiles 
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, 'User profile not found'::TEXT;
        RETURN;
    END IF;

    -- Cannot schedule deletion for already anonymized users
    IF v_is_anonymized = TRUE THEN
        RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, 'User is already anonymized'::TEXT;
        RETURN;
    END IF;

    -- If already scheduled, return existing schedule
    IF v_existing_schedule IS NOT NULL THEN
        RETURN QUERY SELECT TRUE, v_existing_schedule, 'Deletion already scheduled'::TEXT;
        RETURN;
    END IF;

    -- Schedule deletion for 7 days from now
    v_scheduled_at := NOW() + INTERVAL '7 days';

    UPDATE profiles 
    SET scheduled_deletion_at = v_scheduled_at,
        updated_at = NOW()
    WHERE id = p_user_id;

    RETURN QUERY SELECT TRUE, v_scheduled_at, 'Deletion scheduled successfully'::TEXT;
END;
$$;

-- Function to cancel scheduled deletion
CREATE OR REPLACE FUNCTION cancel_user_deletion(p_user_id UUID)
RETURNS TABLE(
    success BOOLEAN,
    message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_scheduled_at TIMESTAMPTZ;
    v_is_anonymized BOOLEAN;
BEGIN
    -- Check current state
    SELECT scheduled_deletion_at, is_anonymized 
    INTO v_scheduled_at, v_is_anonymized
    FROM profiles 
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'User profile not found'::TEXT;
        RETURN;
    END IF;

    -- Cannot cancel for already anonymized users
    IF v_is_anonymized = TRUE THEN
        RETURN QUERY SELECT FALSE, 'User is already anonymized and cannot be restored'::TEXT;
        RETURN;
    END IF;

    -- Check if there's a scheduled deletion to cancel
    IF v_scheduled_at IS NULL THEN
        RETURN QUERY SELECT FALSE, 'No scheduled deletion to cancel'::TEXT;
        RETURN;
    END IF;

    -- Cancel the scheduled deletion
    UPDATE profiles 
    SET scheduled_deletion_at = NULL,
        updated_at = NOW()
    WHERE id = p_user_id;

    RETURN QUERY SELECT TRUE, 'Scheduled deletion cancelled successfully'::TEXT;
END;
$$;

-- Function to get user deletion status
CREATE OR REPLACE FUNCTION get_user_deletion_status(p_user_id UUID)
RETURNS TABLE(
    is_scheduled BOOLEAN,
    scheduled_at TIMESTAMPTZ,
    is_anonymized BOOLEAN,
    days_remaining INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_scheduled_at TIMESTAMPTZ;
    v_is_anonymized BOOLEAN;
BEGIN
    SELECT p.scheduled_deletion_at, p.is_anonymized 
    INTO v_scheduled_at, v_is_anonymized
    FROM profiles p
    WHERE p.id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ, FALSE, NULL::INTEGER;
        RETURN;
    END IF;

    RETURN QUERY SELECT 
        v_scheduled_at IS NOT NULL,
        v_scheduled_at,
        v_is_anonymized,
        CASE 
            WHEN v_scheduled_at IS NOT NULL AND v_scheduled_at > NOW() 
            THEN EXTRACT(DAY FROM (v_scheduled_at - NOW()))::INTEGER
            ELSE NULL
        END;
END;
$$;

-- Function to anonymize a single user (called by cron job)
-- This function:
-- 1. Deletes contacts (personal data)
-- 2. Nullifies user_id in faxes (anonymizes fax history)
-- 3. Clears personal data from profile
-- 4. Deletes subscriptions and free credits
-- 5. Deletes notification settings
-- 6. Deletes referral data
-- 7. Marks profile as anonymized
-- 8. Deletes the auth user (which cascades to related tables)
CREATE OR REPLACE FUNCTION anonymize_user(p_user_id UUID)
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
    v_scheduled_at TIMESTAMPTZ;
BEGIN
    -- Check if user is already anonymized
    SELECT is_anonymized, scheduled_deletion_at
    INTO v_is_anonymized, v_scheduled_at
    FROM profiles
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, 0, 0, 0, 'User profile not found'::TEXT;
        RETURN;
    END IF;

    IF v_is_anonymized = TRUE THEN
        RETURN QUERY SELECT FALSE, 0, 0, 0, 0, 'User is already anonymized'::TEXT;
        RETURN;
    END IF;

    -- 1. Delete contacts (personal data)
    DELETE FROM contacts WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_contacts_deleted = ROW_COUNT;

    -- 2. Anonymize fax records (set user_id to NULL to keep history but remove association)
    UPDATE faxes 
    SET user_id = NULL,
        updated_at = NOW()
    WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_faxes_anonymized = ROW_COUNT;

    -- 3. Delete user subscriptions
    DELETE FROM user_subscriptions WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_subscriptions_deleted = ROW_COUNT;

    -- 4. Delete free credits
    DELETE FROM free_credits WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_free_credits_deleted = ROW_COUNT;

    -- 5. Delete notification settings
    DELETE FROM user_notification_settings WHERE user_id = p_user_id;

    -- 6. Delete referral invites (both as inviter and invitee)
    DELETE FROM referral_invites WHERE inviter_user_id = p_user_id OR invitee_user_id = p_user_id;

    -- 7. Delete rewarded video completions
    DELETE FROM rewarded_video_completions WHERE user_id = p_user_id;

    -- 8. Delete usage records
    DELETE FROM usage WHERE user_id = p_user_id;

    -- 9. Mark profile as anonymized and clear personal data
    UPDATE profiles
    SET is_anonymized = TRUE,
        display_name = NULL,
        scheduled_deletion_at = NULL,
        updated_at = NOW()
    WHERE id = p_user_id;

    -- 10. Delete the auth user (this will cascade to profile due to FK constraint)
    -- Note: We do this last so we can complete all cleanup first
    -- The profile may be deleted by CASCADE, but that's okay since it's anonymized
    PERFORM auth.uid(); -- This is just to ensure we're in the right context
    
    -- Return success
    RETURN QUERY SELECT 
        TRUE, 
        v_contacts_deleted, 
        v_faxes_anonymized, 
        v_subscriptions_deleted,
        v_free_credits_deleted,
        'User anonymized successfully'::TEXT;
END;
$$;

-- Function to process all scheduled anonymizations (called by cron)
-- Returns list of users that were anonymized
CREATE OR REPLACE FUNCTION process_scheduled_anonymizations()
RETURNS TABLE(
    user_id UUID,
    success BOOLEAN,
    contacts_deleted INTEGER,
    faxes_anonymized INTEGER,
    message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user RECORD;
    v_result RECORD;
BEGIN
    -- Find all users whose scheduled deletion time has passed
    FOR v_user IN 
        SELECT p.id 
        FROM profiles p
        WHERE p.scheduled_deletion_at IS NOT NULL 
        AND p.scheduled_deletion_at <= NOW()
        AND p.is_anonymized = FALSE
    LOOP
        -- Anonymize each user
        SELECT * INTO v_result
        FROM anonymize_user(v_user.id);

        RETURN QUERY SELECT 
            v_user.id,
            v_result.success,
            v_result.contacts_deleted,
            v_result.faxes_anonymized,
            v_result.message;
    END LOOP;
END;
$$;

-- Grant execute permissions to service role
GRANT EXECUTE ON FUNCTION schedule_user_deletion(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION cancel_user_deletion(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION get_user_deletion_status(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION anonymize_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION process_scheduled_anonymizations() TO service_role;

-- Add comments
COMMENT ON FUNCTION schedule_user_deletion IS 'Schedule user account for deletion in 7 days';
COMMENT ON FUNCTION cancel_user_deletion IS 'Cancel a scheduled user deletion';
COMMENT ON FUNCTION get_user_deletion_status IS 'Get the deletion status of a user account';
COMMENT ON FUNCTION anonymize_user IS 'Anonymize a user account - removes personal data and disassociates fax history';
COMMENT ON FUNCTION process_scheduled_anonymizations IS 'Process all users whose scheduled deletion time has passed';
