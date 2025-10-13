# Usage Tracking Feature

## Overview

The usage tracking feature allows the system to monitor and record user resource consumption for billing and analytics purposes. This includes tracking fax pages sent, storage usage, and API calls.

## Freemium Model

The system now operates on a freemium pricing model:
- **Authenticated users**: Automatically receive 5 fax pages per month for free
- **Anonymous users**: Cannot send faxes (authentication required)
- **Paid subscriptions**: Additional pages beyond the free tier

## Database Schema

### Usage Table

The `usage` table stores all usage records with the following structure:

```sql
CREATE TABLE usage (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('fax', 'storage', 'api_call')),
    unit_type TEXT NOT NULL CHECK (unit_type IN ('page', 'byte', 'call')),
    usage_amount NUMERIC(10, 4) NOT NULL CHECK (usage_amount >= 0),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Columns

- `user_id`: Reference to the user who consumed the resource
- `type`: Type of resource consumed (`fax`, `storage`, `api_call`)
- `unit_type`: Unit of measurement (`page`, `byte`, `call`)
- `usage_amount`: Amount of resource consumed
- `timestamp`: When the usage occurred
- `metadata`: Additional context about the usage (JSON)

### Row Level Security (RLS)

- **Users**: Can only read their own usage data
- **Service Role**: Has full read/write access for backend operations

## Implementation

### Database Utilities

The `DatabaseUtils` class provides two main methods for usage tracking:

#### `recordUsage(usageData, env, logger)`

Records a new usage entry.

```javascript
await DatabaseUtils.recordUsage({
    userId: 'user-uuid',
    type: 'fax',
    unitType: 'page',
    usageAmount: 5,
    timestamp: '2024-01-25T10:00:00Z',
    metadata: {
        fax_id: 'fax-uuid',
        provider: 'telnyx',
        event_type: 'fax.delivered'
    }
}, env, logger);
```



### Webhook Integration

Usage is automatically recorded when faxes are successfully delivered through webhook handlers. **Failed faxes do not count as usage** - only successfully delivered faxes are recorded:

#### Telnyx Webhook

When a Telnyx fax is delivered (`status === 'delivered'`), the system records:

- Type: `fax`
- Unit: `page`
- Amount: Page count from webhook or fax record
- Metadata: Fax ID, provider, event type, status
- **Also updates**: User subscription's `pages_used` field

#### Notifyre Webhook

When a Notifyre fax is delivered (`status === 'delivered'`), the system records:
- Type: `fax`
- Unit: `page`
- Amount: Page count from webhook or fax record
- Metadata: Fax ID, provider, event type, status
- **Also updates**: User subscription's `pages_used` field

## Usage Recording Behavior

### When Usage is Recorded

- ✅ **Fax Submitted**: No usage recorded (only credit check performed)
- ✅ **Fax Delivered**: Usage recorded in both `usage` table and subscription's `pages_used`
- ❌ **Fax Failed**: No usage recorded (user's quota is preserved)
- ❌ **Fax Cancelled**: No usage recorded (user's quota is preserved)

### Why This Approach?

1. **Fair Billing**: Users only pay for successfully delivered faxes
2. **Provider Reliability**: Failed faxes due to provider issues don't count against users
3. **Network Issues**: Temporary network problems don't consume user quota
4. **Better UX**: Users don't lose pages for faxes that never reached the recipient

## Usage Examples

### Recording Fax Usage

```javascript
// Automatically recorded in webhook handlers when status === 'delivered'
await DatabaseUtils.recordUsage({
    userId: faxRecord.user_id,
    type: 'fax',
    unitType: 'page',
    usageAmount: pageCount,
    timestamp: new Date().toISOString(),
    metadata: {
        fax_id: faxId,
        provider: 'telnyx',
        event_type: 'fax.delivered'
    }
}, env, logger);

// Also updates subscription's pages_used field
await supabase
    .from('user_subscriptions')
    .update({ 
        pages_used: newPagesUsed,
        updated_at: new Date().toISOString()
    })
    .eq('id', subscriptionId);
```

### Recording Storage Usage

```javascript
// For file uploads or storage operations
await DatabaseUtils.recordUsage({
    userId: userId,
    type: 'storage',
    unitType: 'byte',
    usageAmount: fileSize,
    timestamp: new Date().toISOString(),
    metadata: {
        file_id: fileId,
        operation: 'upload'
    }
}, env, logger);
```

### Recording API Usage

```javascript
// For API call tracking
await DatabaseUtils.recordUsage({
    userId: userId,
    type: 'api_call',
    unitType: 'call',
    usageAmount: 1,
    timestamp: new Date().toISOString(),
    metadata: {
        endpoint: '/api/fax/send',
        method: 'POST'
    }
}, env, logger);
```



## Migration

To deploy the freemium pricing model:

1. Run the freemium product migration: `20250137000000_create_freemium_product.sql`
2. Run the function migration: `20250137000002_create_freemium_trigger.sql`
3. Run the backfill migration: `20250138000001_backfill_freemium_subscriptions.sql`
4. The system will automatically create freemium subscriptions for existing users
5. For new users, freemium subscriptions will be created when they first try to send a fax
6. No cron service changes needed - expiration is handled automatically by the credit checking logic

## Testing

Run the usage tracking tests:

```bash
cd services/fax
npm test usage.spec.js
```

## Freemium Subscription Management

### Automatic Creation
- New users receive freemium subscriptions when they first try to send a fax (if they have no active subscriptions)
- Freemium subscriptions provide 5 pages per month
- Rolling 30-day expiration from creation
- Existing users are backfilled with freemium subscriptions via migration
- Application automatically calls `create_freemium_subscription_for_user()` function when needed

### Automatic Expiration Handling
- The credit checking system automatically ignores expired subscriptions (`expires_at < NOW()`)
- No manual reset needed - expired freemium subscriptions are simply not counted
- New freemium subscriptions are created automatically when needed via application logic

## Future Enhancements

- Usage aggregation functions for billing calculations
- Usage limits and quota enforcement
- Usage analytics and reporting endpoints
- Integration with subscription management for usage-based billing 
