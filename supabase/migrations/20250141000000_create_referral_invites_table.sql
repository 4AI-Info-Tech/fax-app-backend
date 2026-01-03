-- Create referral_invites table for referral tracking with state management
-- This table tracks referral invitations and their progression through states
CREATE TABLE IF NOT EXISTS referral_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inviter_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    invite_code VARCHAR(20) UNIQUE NOT NULL,
    invitee_email_hash VARCHAR(64) NOT NULL, -- SHA-256 hash for uniqueness checking
    invitee_display_email VARCHAR(100) NOT NULL, -- Masked email for display (e.g., j***@example.com)
    invitee_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'signed_up', 'reward_pending', 'reward_granted', 'ineligible')),
    invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    signed_up_at TIMESTAMP WITH TIME ZONE,
    reward_granted_at TIMESTAMP WITH TIME ZONE,
    ineligible_reason VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_referral_invites_inviter_user_id ON referral_invites(inviter_user_id);
CREATE INDEX IF NOT EXISTS idx_referral_invites_invite_code ON referral_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_referral_invites_email_hash ON referral_invites(invitee_email_hash);
CREATE INDEX IF NOT EXISTS idx_referral_invites_invitee_user_id ON referral_invites(invitee_user_id) WHERE invitee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referral_invites_status ON referral_invites(status);
CREATE INDEX IF NOT EXISTS idx_referral_invites_created_at ON referral_invites(created_at);

-- Create unique constraint to prevent duplicate referrals
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_invites_unique_email_hash ON referral_invites(invitee_email_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_invites_unique_invitee_user ON referral_invites(invitee_user_id) WHERE invitee_user_id IS NOT NULL;

-- Enable Row Level Security
ALTER TABLE referral_invites ENABLE ROW LEVEL SECURITY;

-- Users can view referrals they created
CREATE POLICY "Users can view own referrals" 
ON referral_invites 
FOR SELECT 
TO authenticated 
USING (auth.uid() = inviter_user_id);

-- Users can create referral invites
CREATE POLICY "Users can create referrals" 
ON referral_invites 
FOR INSERT 
TO authenticated 
WITH CHECK (auth.uid() = inviter_user_id);

-- Users can update their own referrals (for signup processing)
CREATE POLICY "Users can update own referrals" 
ON referral_invites 
FOR UPDATE 
TO authenticated 
USING (auth.uid() = inviter_user_id OR auth.uid() = invitee_user_id);

-- Allow full access only to service role
CREATE POLICY "Service role full access" 
ON referral_invites 
FOR ALL 
TO service_role 
USING (true) WITH CHECK (true);

-- Create function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_referral_invites_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER trigger_update_referral_invites_updated_at
    BEFORE UPDATE ON referral_invites
    FOR EACH ROW
    EXECUTE FUNCTION update_referral_invites_updated_at();

-- Create function to generate unique invite code
CREATE OR REPLACE FUNCTION generate_invite_code()
RETURNS VARCHAR(20) AS $$
DECLARE
    code VARCHAR(20);
    exists BOOLEAN;
BEGIN
    LOOP
        -- Generate 8-character alphanumeric code
        code := upper(substring(md5(random()::text) from 1 for 8));
        
        -- Check if code already exists
        SELECT EXISTS(SELECT 1 FROM referral_invites WHERE invite_code = code) INTO exists;
        
        -- Exit loop if code is unique
        IF NOT exists THEN
            EXIT;
        END IF;
    END LOOP;
    
    RETURN code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to mask email for display
CREATE OR REPLACE FUNCTION mask_email(email TEXT)
RETURNS VARCHAR(100) AS $$
DECLARE
    local_part TEXT;
    domain_part TEXT;
    masked_local TEXT;
    at_pos INTEGER;
BEGIN
    -- Find @ position
    at_pos := position('@' in email);
    
    IF at_pos = 0 THEN
        -- No @ found, return masked version
        RETURN substring(email from 1 for 1) || '***';
    END IF;
    
    -- Split email into local and domain parts
    local_part := substring(email from 1 for at_pos - 1);
    domain_part := substring(email from at_pos);
    
    -- Mask local part
    IF length(local_part) <= 2 THEN
        masked_local := local_part || '***';
    ELSE
        masked_local := substring(local_part from 1 for 1) || '***' || substring(local_part from length(local_part));
    END IF;
    
    RETURN masked_local || domain_part;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create function to process referral signup
CREATE OR REPLACE FUNCTION process_referral_signup(
    p_invite_code VARCHAR(20),
    p_invitee_user_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
    referral_record RECORD;
    inviter_referral_count INTEGER;
BEGIN
    -- Find the referral invite
    SELECT * INTO referral_record 
    FROM referral_invites 
    WHERE invite_code = p_invite_code AND status = 'invited';
    
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Check if invitee is already referred by someone else
    IF EXISTS(SELECT 1 FROM referral_invites WHERE invitee_user_id = p_invitee_user_id) THEN
        -- Mark as ineligible
        UPDATE referral_invites 
        SET status = 'ineligible', 
            ineligible_reason = 'Already referred by another user',
            updated_at = NOW()
        WHERE id = referral_record.id;
        RETURN FALSE;
    END IF;
    
    -- Check if inviter is trying to refer themselves
    IF referral_record.inviter_user_id = p_invitee_user_id THEN
        -- Mark as ineligible
        UPDATE referral_invites 
        SET status = 'ineligible', 
            ineligible_reason = 'Self-referral not allowed',
            updated_at = NOW()
        WHERE id = referral_record.id;
        RETURN FALSE;
    END IF;
    
    -- Count inviter's successful referrals
    SELECT COUNT(*) INTO inviter_referral_count
    FROM referral_invites 
    WHERE inviter_user_id = referral_record.inviter_user_id 
    AND status IN ('reward_granted');
    
    -- Check if inviter has reached limit
    IF inviter_referral_count >= 10 THEN
        -- Mark as ineligible
        UPDATE referral_invites 
        SET status = 'ineligible', 
            ineligible_reason = 'Inviter reached referral limit',
            updated_at = NOW()
        WHERE id = referral_record.id;
        RETURN FALSE;
    END IF;
    
    -- Update referral to signed_up status
    UPDATE referral_invites 
    SET status = 'signed_up',
        invitee_user_id = p_invitee_user_id,
        signed_up_at = NOW(),
        updated_at = NOW()
    WHERE id = referral_record.id;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;