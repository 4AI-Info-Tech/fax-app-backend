-- Trigger to handle referral rewards upon new user registration
-- Requirement: Grant 5 free credits to both inviter and invited user upon successful registration
-- Update: A user can only earn credits from invite 10 times a year.

-- Ensure pgcrypto is available for hashing
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Function to process referral matching and value granting
CREATE OR REPLACE FUNCTION handle_new_user_referral()
RETURNS TRIGGER AS $$
DECLARE
    v_email_hash VARCHAR(64);
    v_invite_record RECORD;
    v_inviter_bonus INTEGER := 5;
    v_invitee_bonus INTEGER := 5;
    v_inviter_yearly_count INTEGER;
BEGIN
    -- 1. Create hash of the new user's email (lowercase, trimmed)
    v_email_hash := encode(digest(lower(trim(NEW.email)), 'sha256'), 'hex');

    -- 2. Check if there is a pending invite for this email
    SELECT * INTO v_invite_record
    FROM referral_invites
    WHERE invitee_email_hash = v_email_hash
    AND status = 'invited';

    -- If no invite found, exit
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- 3. Update the referral invite status
    UPDATE referral_invites
    SET 
        invitee_user_id = NEW.id,
        status = 'reward_granted', -- Implicitly successful upon signup per requirement
        signed_up_at = NOW(),
        reward_granted_at = NOW(),
        updated_at = NOW()
    WHERE id = v_invite_record.id;

    -- 4. Check Inviter's yearly referral count (rolling 1 year window)
    SELECT COUNT(*) INTO v_inviter_yearly_count
    FROM referral_invites
    WHERE inviter_user_id = v_invite_record.inviter_user_id
    AND status = 'reward_granted'
    AND reward_granted_at > (NOW() - INTERVAL '1 year');

    -- 5. Grant credits to Inviter (ONLY if under the yearly cap of 10)
    IF v_inviter_yearly_count < 10 THEN
        PERFORM grant_credits(
            v_invite_record.inviter_user_id,
            v_inviter_bonus,
            'referral',
            v_invite_record.id,
            jsonb_build_object(
                'role', 'inviter',
                'invitee_email', v_invite_record.invitee_display_email,
                'invitee_user_id', NEW.id
            )
        );
    END IF;

    -- 6. Grant credits to Invitee (the new user) - Always grant to encourage new users
    -- Note: NEW.id is the new user's UUID
    PERFORM grant_credits(
        NEW.id,
        v_invitee_bonus,
        'referral',
        v_invite_record.id,
        jsonb_build_object(
            'role', 'invitee',
            'inviter_user_id', v_invite_record.inviter_user_id
        )
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger on auth.users
-- Drop if exists to avoid errors on repeated runs
DROP TRIGGER IF EXISTS on_auth_user_created_referral_check ON auth.users;

CREATE TRIGGER on_auth_user_created_referral_check
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION handle_new_user_referral();
