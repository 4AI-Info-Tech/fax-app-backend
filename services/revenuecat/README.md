# RevenueCat Service

This service handles RevenueCat webhook events and subscription management for the Send Fax Pro application.

## Features

- **Webhook Processing**: Handles RevenueCat webhook events for subscription lifecycle management
- **Event Storage**: Stores webhook events in the database for audit and debugging
- **User Subscription Updates**: Updates user subscription status based on webhook events
- **Health Checks**: Provides health check endpoints for monitoring

## Supported Event Types

- `INITIAL_PURCHASE`: First-time subscription purchase
- `RENEWAL`: Subscription renewal
- `CANCELLATION`: Subscription cancellation
- `UNCANCELLATION`: Subscription reactivation
- `NON_RENEWING_PURCHASE`: One-time purchase
- `EXPIRATION`: Subscription expiration
- `BILLING_ISSUE`: Billing problems
- `PRODUCT_CHANGE`: Product/plan changes

## API Endpoints

### Webhook Endpoint
- **POST** `/v1/revenuecat/webhook`
- Handles RevenueCat webhook events
- Requires webhook secret verification (optional)
- Exposed through API Gateway only (`https://api-staging.sendfax.pro` / `https://api.sendfax.pro`)

### Health Check Endpoints
- **GET** `/v1/revenuecat/health` - Public health check
- **GET** `/v1/revenuecat/health/protected` - Protected health check

## Environment Variables

- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key for admin access
- `REVENUECAT_WEBHOOK_SECRET`: Secret for webhook signature verification (optional)
- `LOG_LEVEL`: Logging level (DEBUG, INFO, WARN, ERROR)

## Database Schema

The service expects the following database tables:

### `revenuecat_webhook_events`
Stores all webhook events for audit and debugging purposes.

### `profiles`
User profiles table with subscription-related fields:
- `subscription_status`: Current subscription status
- `subscription_product_id`: Product ID
- `subscription_expires_at`: Expiration date
- `subscription_purchased_at`: Purchase date
- `subscription_store`: Store (App Store, Play Store, etc.)
- `subscription_environment`: Environment (production, sandbox)

## Development

### Local Development
```bash
npm run dev
```

### Testing
```bash
npm test
```

### Deployment
```bash
npm run deploy
```

## Security

- Webhook signature verification (when secret is provided)
- Input validation and sanitization
- Secure logging (sensitive data is masked)
- Database access through service role key

## Monitoring

The service provides comprehensive logging for:
- Webhook event processing
- Database operations
- Error handling
- Performance metrics

## Integration

This service integrates with:
- **Supabase**: For data storage and user management
- **RevenueCat**: For subscription webhook events
- **Serverless API Gateway**: For request routing and authentication

Direct public invocation of this worker is not supported; configure RevenueCat to call the API endpoint.
