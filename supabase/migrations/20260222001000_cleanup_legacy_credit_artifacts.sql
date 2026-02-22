-- Cleanup legacy Supabase credit-accounting artifacts after migration to RevenueCat
-- virtual currencies as the source of truth.

-- 1) Drop legacy SQL routines that are no longer called by backend services.
DROP FUNCTION IF EXISTS public.transfer_user_data_transaction(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.transfer_anonymous_user(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.record_rewarded_video_completion(UUID, VARCHAR, VARCHAR);
DROP FUNCTION IF EXISTS public.can_watch_rewarded_video(UUID);
DROP FUNCTION IF EXISTS public.get_monthly_completion_count(UUID, VARCHAR);
DROP FUNCTION IF EXISTS public.consume_subscription_credits(UUID, INTEGER, UUID);
DROP FUNCTION IF EXISTS public.get_current_user_subscription(UUID);
DROP FUNCTION IF EXISTS public.is_user_paid_subscriber(UUID);
DROP FUNCTION IF EXISTS public.consume_credits(UUID, INTEGER, UUID, JSONB);
DROP FUNCTION IF EXISTS public.grant_credits(UUID, INTEGER, VARCHAR, UUID, JSONB);
DROP FUNCTION IF EXISTS public.get_user_credit_balance(UUID);

-- 2) Remove legacy DB ledger table.
DROP TABLE IF EXISTS public.users_credit_ledger;

-- 3) Remove obsolete products table and FK coupling from webhook events.
ALTER TABLE IF EXISTS public.revenuecat_webhook_events
    DROP CONSTRAINT IF EXISTS fk_revenuecat_webhook_events_product_id;

DROP TABLE IF EXISTS public.products;
