-- Create freemium product for the new pricing model
-- This product provides 5 pages per month for free to all authenticated users

INSERT INTO products (
    product_id,
    display_name,
    description,
    page_limit,
    expire_days,
    type,
    is_active
) VALUES (
    'freemium_monthly',
    'Free Monthly Plan',
    'Free plan with 5 fax pages per month',
    5,
    30,
    'subscription',
    true
) ON CONFLICT (product_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    page_limit = EXCLUDED.page_limit,
    expire_days = EXCLUDED.expire_days,
    type = EXCLUDED.type,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();
