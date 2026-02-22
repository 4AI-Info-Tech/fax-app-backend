# RevenueCat Service Setup Guide

This guide explains how to set up and configure the RevenueCat service for handling subscription webhooks.

## Prerequisites

1. **RevenueCat Account**: You need a RevenueCat account with a project set up
2. **Supabase Project**: Ensure your Supabase project is configured with the required tables
3. **Cloudflare Workers**: Make sure you have access to deploy Cloudflare Workers

## Environment Variables

Set the following environment variables in your Cloudflare Workers environment:

### Required Variables
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key for admin access

### Optional Variables
- `REVENUECAT_WEBHOOK_SECRET`: Secret for webhook signature verification
- `LOG_LEVEL`: Logging level (DEBUG, INFO, WARN, ERROR) - defaults to DEBUG

## Database Setup

Run the database migration to create the required tables:

```sql
-- Run the migration file: 20250120000000_create_revenuecat_webhook_events_table.sql
```

This will create:
1. `revenuecat_webhook_events` table for storing webhook events
2. Add subscription-related columns to the `profiles` table
3. Set up appropriate indexes and RLS policies

## RevenueCat Configuration

### 1. Create Webhook Endpoint

In your RevenueCat dashboard:

1. Go to **Project Settings** > **Webhooks**
2. Click **Add Webhook**
3. Set the webhook URL to the API Gateway endpoint:
   - Staging: `https://api-staging.sendfax.pro/v1/revenuecat/webhook`
   - Production: `https://api.sendfax.pro/v1/revenuecat/webhook`
   - Do not point RevenueCat to the internal `revenuecat-service-*` worker directly
4. Select the events you want to receive:
   - `INITIAL_PURCHASE`
   - `RENEWAL`
   - `CANCELLATION`
   - `UNCANCELLATION`
   - `NON_RENEWING_PURCHASE`
   - `EXPIRATION`
   - `BILLING_ISSUE`
   - `PRODUCT_CHANGE`

### 2. Configure Webhook Secret (Optional)

For enhanced security:

1. Generate a webhook secret
2. Add it to your Cloudflare Workers environment as `REVENUECAT_WEBHOOK_SECRET`
3. Configure the secret in RevenueCat webhook settings

## Deployment

### 1. Install Dependencies

```bash
cd fax-app-backend/services/revenuecat
npm install
```

### 2. Deploy to Cloudflare Workers

```bash
# Deploy to staging
npm run deploy -- --env staging

# Deploy to production
npm run deploy -- --env prod
```

### 3. Update API Gateway Configuration

Ensure the service binding is configured in your API gateway:

```json
{
  "serviceBindings": [
    {
      "alias": "revenuecat_service",
      "binding": "REVENUECAT_SERVICE"
    }
  ]
}
```

## Testing

### 1. Health Check

Test the service health endpoints:

```bash
# Public health check
curl https://your-api-domain.com/v1/revenuecat/health

# Protected health check (requires authentication)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  https://your-api-domain.com/v1/revenuecat/health/protected
```

### 2. Webhook Testing

You can test webhooks using RevenueCat's webhook testing feature or by sending test payloads:

```bash
curl -X POST https://your-api-domain.com/v1/revenuecat/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "type": "INITIAL_PURCHASE",
      "id": "test-event-id",
      "app_user_id": "test-user-id",
      "product_id": "test-product",
      "environment": "sandbox"
    }
  }'
```

## Monitoring

### Logs

The service provides comprehensive logging:
- Webhook event processing
- Database operations
- Error handling
- Performance metrics

### Database Queries

Monitor webhook events:

```sql
-- View recent webhook events
SELECT event_type, user_id, processed_at 
FROM revenuecat_webhook_events 
ORDER BY processed_at DESC 
LIMIT 10;

-- Check user subscription status
SELECT id, subscription_status, subscription_product_id 
FROM profiles 
WHERE subscription_status IS NOT NULL;
```

## Troubleshooting

### Common Issues

1. **Webhook not received**: Check the webhook URL and ensure it's publicly accessible
   - Use API Gateway URL (`/v1/revenuecat/webhook`) instead of service worker URL
2. **Database errors**: Verify Supabase configuration and service role key
3. **Authentication errors**: Ensure JWT tokens are valid for protected endpoints
4. **Signature verification failures**: Check webhook secret configuration

### Debug Mode

Enable debug logging by setting `LOG_LEVEL=DEBUG` in your environment variables.

## Security Considerations

1. **Webhook Secret**: Always use a webhook secret in production
2. **HTTPS**: Ensure all webhook endpoints use HTTPS
3. **Rate Limiting**: Consider implementing rate limiting for webhook endpoints
4. **Input Validation**: The service validates all incoming webhook data
5. **Database Access**: Uses service role key for admin access with RLS policies

## Integration with Frontend

The service automatically updates user subscription status in the `profiles` table, which can be accessed by your frontend application to show subscription status and features. 
