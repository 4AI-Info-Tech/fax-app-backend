-- Add metadata column to rewarded_video_completions table for storing additional SSV callback data
ALTER TABLE rewarded_video_completions 
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Add index for metadata queries if needed
CREATE INDEX IF NOT EXISTS idx_rewarded_video_completions_metadata ON rewarded_video_completions USING gin(metadata);

-- Add comment
COMMENT ON COLUMN rewarded_video_completions.metadata IS 'Additional data from AdMob SSV callback (ad_network, reward_item, original_timestamp, source)';
