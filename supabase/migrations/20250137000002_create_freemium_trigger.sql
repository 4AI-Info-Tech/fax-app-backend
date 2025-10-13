-- Create function to create freemium subscription for a specific user
-- This function can be called manually or from application code

CREATE OR REPLACE FUNCTION create_freemium_subscription_for_user(user_uuid UUID)
RETURNS TABLE(
    subscription_id UUID,
    user_id UUID,
    created BOOLEAN
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    existing_count INTEGER;
    new_subscription_id UUID;
BEGIN
    -- Check if user already has any active subscriptions
    SELECT COUNT(*)
    INTO existing_count
    FROM user_subscriptions
    WHERE user_subscriptions.user_id = user_uuid 
      AND is_active = true 
      AND expires_at > NOW();

    -- Only create freemium if user has no active subscriptions
    IF existing_count = 0 THEN
        INSERT INTO user_subscriptions (
            user_id,
            product_id,
            subscription_id,
            entitlement_id,
            purchased_at,
            expires_at,
            page_limit,
            pages_used,
            is_active
        ) VALUES (
            user_uuid,
            'freemium_monthly',
            NULL, -- Not from RevenueCat
            'freemium',
            NOW(),
            NOW() + INTERVAL '30 days',
            5,
            0,
            true
        ) RETURNING id INTO new_subscription_id;
        
        RETURN QUERY SELECT new_subscription_id, user_uuid, true;
    ELSE
        RETURN QUERY SELECT NULL::UUID, user_uuid, false;
    END IF;
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION create_freemium_subscription_for_user(UUID) IS 'Creates a freemium subscription (5 pages/month) for a specific user if they have no active subscriptions';
