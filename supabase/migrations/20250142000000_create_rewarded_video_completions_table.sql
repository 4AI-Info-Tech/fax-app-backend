-- Create rewarded_video_completions table for tracking ad completions with monthly caps
-- This table tracks completed rewarded video ads and enforces monthly limits
CREATE TABLE IF NOT EXISTS rewarded_video_completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    completion_token VARCHAR(100) UNIQUE NOT NULL, -- Client-generated idempotency token
    ad_unit_id VARCHAR(100) NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    pages_granted INTEGER NOT NULL DEFAULT 1,
    month_year VARCHAR(7) NOT NULL, -- 'YYYY-MM' format for monthly cap tracking
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_rewarded_video_completions_user_id ON rewarded_video_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_rewarded_video_completions_completion_token ON rewarded_video_completions(completion_token);
CREATE INDEX IF NOT EXISTS idx_rewarded_video_completions_month_year ON rewarded_video_completions(month_year);
CREATE INDEX IF NOT EXISTS idx_rewarded_video_completions_user_month ON rewarded_video_completions(user_id, month_year);
CREATE INDEX IF NOT EXISTS idx_rewarded_video_completions_completed_at ON rewarded_video_completions(completed_at);

-- Enable Row Level Security
ALTER TABLE rewarded_video_completions ENABLE ROW LEVEL SECURITY;

-- Users can only read their own completions
CREATE POLICY "Users can view own completions" 
ON rewarded_video_completions 
FOR SELECT 
TO authenticated 
USING (auth.uid() = user_id);

-- Deny direct insert/update/delete to authenticated users (enforced through stored procedures)
CREATE POLICY "Deny direct modifications to users" 
ON rewarded_video_completions 
FOR ALL 
TO authenticated 
USING (false);

-- Allow full access only to service role
CREATE POLICY "Service role full access" 
ON rewarded_video_completions 
FOR ALL 
TO service_role 
USING (true) WITH CHECK (true);

-- Create function to get monthly completion count for a user
CREATE OR REPLACE FUNCTION get_monthly_completion_count(
    p_user_id UUID,
    p_month_year VARCHAR(7) DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    target_month VARCHAR(7);
    completion_count INTEGER;
BEGIN
    -- Use current month if not specified
    IF p_month_year IS NULL THEN
        target_month := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM');
    ELSE
        target_month := p_month_year;
    END IF;
    
    SELECT COUNT(*) INTO completion_count
    FROM rewarded_video_completions
    WHERE user_id = p_user_id AND month_year = target_month;
    
    RETURN completion_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to check if user can watch rewarded video
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
    -- For now, assume user is free if they have any page ledger entries
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

-- Create function to record rewarded video completion
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
        pages_granted,
        month_year
    ) VALUES (
        p_user_id,
        p_completion_token,
        p_ad_unit_id,
        NOW(),
        1,
        current_month
    );
    
    -- Grant pages to user
    PERFORM grant_pages(
        p_user_id,
        1,
        'rewarded_video',
        (SELECT id FROM rewarded_video_completions WHERE completion_token = p_completion_token),
        jsonb_build_object('ad_unit_id', p_ad_unit_id, 'completion_token', p_completion_token)
    );
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to get user's monthly rewarded video stats
CREATE OR REPLACE FUNCTION get_monthly_rewarded_video_stats(
    p_user_id UUID,
    p_month_year VARCHAR(7) DEFAULT NULL
)
RETURNS TABLE(
    month_year VARCHAR(7),
    completed_count INTEGER,
    remaining_count INTEGER,
    can_watch BOOLEAN
) AS $$
DECLARE
    target_month VARCHAR(7);
    completed INTEGER;
    remaining INTEGER;
    can_watch_now BOOLEAN;
BEGIN
    -- Use current month if not specified
    IF p_month_year IS NULL THEN
        target_month := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM');
    ELSE
        target_month := p_month_year;
    END IF;
    
    -- Get completion count
    completed := get_monthly_completion_count(p_user_id, target_month);
    
    -- Calculate remaining
    remaining := GREATEST(0, 15 - completed);
    
    -- Check if can watch now
    can_watch_now := can_watch_rewarded_video(p_user_id);
    
    RETURN QUERY SELECT target_month, completed, remaining, can_watch_now;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;