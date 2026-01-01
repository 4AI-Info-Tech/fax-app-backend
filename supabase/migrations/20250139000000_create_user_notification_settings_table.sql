-- Create user_notification_settings table for storing user push notification preferences
-- This table stores OneSignal player ID and notification preferences for each user
CREATE TABLE IF NOT EXISTS user_notification_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    fax_delivered_enabled BOOLEAN DEFAULT true,
    fax_failed_enabled BOOLEAN DEFAULT true,
    low_credits_enabled BOOLEAN DEFAULT true,
    onesignal_player_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id)
);

-- Create index for user_id lookups
CREATE INDEX IF NOT EXISTS idx_user_notification_settings_user_id ON user_notification_settings(user_id);

-- Enable Row Level Security
ALTER TABLE user_notification_settings ENABLE ROW LEVEL SECURITY;

-- Allow users to view their own notification settings
CREATE POLICY "Users can view own notification settings"
    ON user_notification_settings FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Allow users to update their own notification settings
CREATE POLICY "Users can update own notification settings"
    ON user_notification_settings FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id);

-- Allow users to insert their own notification settings
CREATE POLICY "Users can insert own notification settings"
    ON user_notification_settings FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Allow service role full access
CREATE POLICY "Service role full access on notification settings"
    ON user_notification_settings FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_notification_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER trigger_update_user_notification_settings_updated_at
    BEFORE UPDATE ON user_notification_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_user_notification_settings_updated_at();

-- Add comment to table
COMMENT ON TABLE user_notification_settings IS 'Stores user push notification preferences and OneSignal player IDs';
