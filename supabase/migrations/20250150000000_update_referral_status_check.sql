-- Update referral_invites status check constraint to include new statuses
ALTER TABLE referral_invites 
    DROP CONSTRAINT IF EXISTS referral_invites_status_check;

ALTER TABLE referral_invites 
    ADD CONSTRAINT referral_invites_status_check 
    CHECK (status IN ('invited', 'signed_up', 'reward_pending', 'reward_granted', 'ineligible', 'already_registered', 'disposable_email'));
