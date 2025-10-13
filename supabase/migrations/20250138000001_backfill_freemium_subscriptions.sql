-- Backfill Freemium Subscriptions for Existing Users
-- This script creates freemium subscriptions for all existing users who don't have any active subscriptions
-- Run this after creating the freemium product and trigger
-- 
-- This replaces the Node.js backfill script since we don't keep keys locally

-- First, let's see what we're working with
DO $$
DECLARE
    total_users INTEGER;
    users_with_active_subs INTEGER;
    users_needing_freemium INTEGER;
    created_count INTEGER := 0;
    user_record RECORD;
BEGIN
    -- Get statistics
    SELECT COUNT(*) INTO total_users FROM auth.users;
    
    SELECT COUNT(DISTINCT us.user_id) INTO users_with_active_subs
    FROM user_subscriptions us
    WHERE us.is_active = true 
      AND us.expires_at > NOW();
    
    -- Count users who need freemium subscriptions
    SELECT COUNT(*) INTO users_needing_freemium
    FROM auth.users u
    LEFT JOIN user_subscriptions us ON u.id = us.user_id 
        AND us.is_active = true 
        AND us.expires_at > NOW()
    WHERE us.user_id IS NULL;
    
    -- Log the analysis
    RAISE NOTICE 'Freemium Backfill Analysis:';
    RAISE NOTICE '  Total users: %', total_users;
    RAISE NOTICE '  Users with active subscriptions: %', users_with_active_subs;
    RAISE NOTICE '  Users needing freemium: %', users_needing_freemium;
    
        -- Create freemium subscriptions for users who need them using the function
        FOR user_record IN
            SELECT u.id, u.created_at, u.email
            FROM auth.users u
            LEFT JOIN user_subscriptions us ON u.id = us.user_id 
                AND us.is_active = true 
                AND us.expires_at > NOW()
            WHERE us.user_id IS NULL
            ORDER BY u.created_at
        LOOP
            BEGIN
                -- Use the function to create freemium subscription
                PERFORM create_freemium_subscription_for_user(user_record.id);
                
                created_count := created_count + 1;
                RAISE NOTICE '  ✅ Created freemium subscription for user % (%)', 
                    user_record.id, 
                    COALESCE(user_record.email, 'no email');
                    
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE '  ❌ Failed to create subscription for user %: %', 
                    user_record.id, 
                    SQLERRM;
            END;
        END LOOP;
    
    -- Final statistics
    RAISE NOTICE 'Backfill Results:';
    RAISE NOTICE '  ✅ Successfully created: % freemium subscriptions', created_count;
    RAISE NOTICE '  ❌ Failed: % subscriptions', (users_needing_freemium - created_count);
    
    -- Verify final count
    SELECT COUNT(*) INTO created_count
    FROM user_subscriptions
    WHERE product_id = 'freemium_monthly' 
      AND is_active = true;
    
    RAISE NOTICE '  📊 Total active freemium subscriptions: %', created_count;
    RAISE NOTICE '🎉 Freemium backfill completed!';
END $$;
