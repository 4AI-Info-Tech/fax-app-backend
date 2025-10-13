# Credit Checking Implementation

## Overview

This document describes the implementation of credit checking for fax sending in the Send Fax Pro application. The system now validates user credits before allowing fax transmission and tracks usage after successful fax delivery.

## Freemium Model

The system operates on a freemium pricing model:
- **All authenticated users** automatically receive 5 fax pages per month for free
- **Anonymous users** cannot send faxes (authentication required)
- **Paid subscriptions** provide additional pages beyond the free tier
- **Freemium subscriptions** are automatically created for new users and expire after 30 days (rolling monthly)

## Features

### 1. Pre-Send Credit Validation
- **Credit Check**: Validates user has sufficient credits before sending fax
- **Multi-Subscription Support**: Handles users with both subscriptions and consumables
- **Priority Ordering**: Uses subscriptions first, then consumables
- **Expiration Handling**: Only considers active, non-expired subscriptions

### 2. Usage Tracking
- **Page Deduction**: Deducts pages from user's subscription only when fax is successfully delivered
- **Analytics Recording**: Records usage in the `usage` table for analytics
- **Failed Fax Protection**: Failed faxes do not count against user's quota
- **Webhook-Based**: Usage is recorded via webhook handlers when delivery is confirmed

### 3. Database Integration
- **Direct Supabase Access**: Uses service role for direct database operations
- **Real-time Validation**: Checks credits in real-time before fax transmission
- **Atomic Updates**: Ensures consistent credit deduction

## Implementation Details

### Credit Checking Logic

The credit checking process follows these steps:

1. **User Identification**: Extract user ID from JWT payload
2. **Subscription Query**: Fetch active, non-expired subscriptions
3. **Priority Sorting**: Order by subscription type (subscription first, then consumables)
4. **Credit Calculation**: Sum available pages across all subscriptions
5. **Validation**: Compare required pages with available credits

### Database Schema Usage

#### User Subscriptions Table
```sql
SELECT 
    us.id,
    us.product_id,
    us.page_limit,
    us.pages_used,
    (us.page_limit - us.pages_used) as available_pages,
    us.expires_at,
    us.is_active,
    p.type,
    p.display_name
FROM user_subscriptions us
JOIN products p ON us.product_id = p.product_id
WHERE us.user_id = ?
    AND us.is_active = true
    AND us.expires_at > NOW()
ORDER BY p.type ASC, us.created_at DESC;
```

#### Usage Tracking Table
```sql
INSERT INTO usage (
    user_id,
    type,
    unit_type,
    usage_amount,
    metadata
) VALUES (
    ?,
    'fax',
    'page',
    ?,
    '{"subscription_id": ?, "action": "fax_sent"}'
);
```

### API Response Codes

#### Success (200)
```json
{
    "statusCode": 200,
    "message": "Fax submitted successfully",
    "data": {
        "id": "fax-id",
        "friendlyId": "friendly-id",
        "status": "queued",
        "message": "Fax is now queued for processing",
        "timestamp": "2025-07-29T20:00:00.000Z",
        "recipient": "+1234567890",
        "pages": 1,
        "apiProvider": "notifyre"
    }
}
```

#### Insufficient Credits (402) - Generic
```json
{
    "statusCode": 402,
    "error": "Insufficient credits",
    "message": "You don't have enough credits to send this fax",
    "data": {
        "pagesRequired": 5,
        "availablePages": 3,
        "subscriptionId": "sub-123",
        "isFreemiumUser": false,
        "upgradeRequired": false
    },
    "timestamp": "2025-07-29T20:00:00.000Z"
}
```

#### Freemium User - Page Limit Exceeded (402)
```json
{
    "statusCode": 402,
    "error": "Page limit exceeded",
    "message": "Your free plan allows up to 5 pages per month. You're trying to send 10 pages. Please upgrade to a paid plan for higher limits.",
    "data": {
        "pagesRequired": 10,
        "availablePages": 5,
        "subscriptionId": "freemium-sub-123",
        "isFreemiumUser": true,
        "upgradeRequired": true
    },
    "timestamp": "2025-07-29T20:00:00.000Z"
}
```

#### Freemium User - Monthly Limit Reached (402)
```json
{
    "statusCode": 402,
    "error": "Monthly limit reached",
    "message": "You've used all 5 free pages for this month. Your limit will reset in 30 days from when you signed up, or upgrade to a paid plan for more pages.",
    "data": {
        "pagesRequired": 1,
        "availablePages": 0,
        "subscriptionId": "freemium-sub-123",
        "isFreemiumUser": true,
        "upgradeRequired": true
    },
    "timestamp": "2025-07-29T20:00:00.000Z"
}
```

## Code Implementation

### FaxDatabaseUtils Class

The `FaxDatabaseUtils` class provides three main methods:

#### 1. checkUserCredits(userId, pagesRequired, env, logger)
- Validates user has sufficient credits
- Returns credit check result with available pages and subscription ID
- Handles multiple subscription types and priorities

#### 2. updatePageUsage(userId, pagesUsed, subscriptionId, env, logger)
- Updates subscription's `pages_used` field (now only called from webhook handlers)
- Records usage in analytics table
- Only called when fax is confirmed delivered via webhook
- Handles errors gracefully without failing fax operation

#### 3. getUserFaxUsage(userId, env, logger)
- Retrieves user's fax usage statistics
- Counts successful (non-failed) faxes
- Calculates total pages used

### Integration in Fax Service

The credit checking is integrated into the `sendFax` method with automatic freemium subscription creation:

```javascript
// 1. Extract user ID
const userId = sagContextObj.jwtPayload?.sub || sagContextObj.jwtPayload?.user_id || sagContextObj.user?.id || null;

// 2. Check credits before sending
const pagesRequired = faxRequest.pages || 1;
let creditCheck = await FaxDatabaseUtils.checkUserCredits(userId, pagesRequired, this.env, this.logger);

// 3. Auto-create freemium subscription for new users
if (!creditCheck.hasCredits && creditCheck.error === 'No active subscriptions found' && userId) {
    const { data: freemiumResult, error: freemiumError } = await supabase
        .rpc('create_freemium_subscription_for_user', { user_uuid: userId });
    
    if (freemiumResult && freemiumResult[0].created) {
        // Re-check credits after creating freemium subscription
        creditCheck = await FaxDatabaseUtils.checkUserCredits(userId, pagesRequired, this.env, this.logger);
    }
}

// 4. Check credits with freemium-specific error messages
if (!creditCheck.hasCredits) {
    const isFreemiumUser = creditCheck.subscriptions?.some(sub => sub.product_id === 'freemium_monthly');
    
    let errorMessage = creditCheck.error || "You don't have enough credits to send this fax";
    let errorTitle = "Insufficient credits";
    
    if (isFreemiumUser) {
        if (pagesRequired > 5) {
            errorTitle = "Page limit exceeded";
            errorMessage = `Your free plan allows up to 5 pages per month. You're trying to send ${pagesRequired} pages. Please upgrade to a paid plan for higher limits.`;
        } else {
            errorTitle = "Monthly limit reached";
            errorMessage = `You've used all 5 free pages for this month. Your limit will reset in 30 days from when you signed up, or upgrade to a paid plan for more pages.`;
        }
    }
    
    return {
        statusCode: 402,
        error: errorTitle,
        message: errorMessage,
        data: {
            pagesRequired: pagesRequired,
            availablePages: creditCheck.availablePages,
            subscriptionId: creditCheck.subscriptionId,
            isFreemiumUser: isFreemiumUser,
            upgradeRequired: isFreemiumUser
        }
    };
}

// 5. Send fax
const faxResult = await faxProvider.sendFax(providerPayload);

// 6. Usage will be recorded when fax is delivered via webhook handlers
// This ensures failed faxes don't count against user's quota
```

## Usage Examples

### User with Freemium Only
- **Freemium**: 5 pages/month
- **Used**: 2 pages
- **Available**: 3 pages
- **Fax Request**: 2 pages
- **Result**: ✅ Approved (1 page remaining)

### User with Freemium + Paid Subscription
- **Freemium**: 5 pages/month (2 used)
- **Paid Subscription**: 250 pages/month (100 used)
- **Total Available**: 153 pages
- **Fax Request**: 10 pages
- **Result**: ✅ Approved (143 pages remaining)

### User with Consumable
- **Consumable**: 10 pages
- **Used**: 0 pages
- **Available**: 10 pages
- **Fax Request**: 15 pages
- **Result**: ❌ Denied (insufficient credits)

### User with Freemium Only (Exceeded)
- **Freemium**: 5 pages/month
- **Used**: 5 pages
- **Available**: 0 pages
- **Fax Request**: 1 page
- **Result**: ❌ Denied (insufficient credits)

## Error Handling

### Database Errors
- Credit check failures return 402 status
- Usage tracking failures don't affect fax operation
- All errors are logged for debugging

### Missing Configuration
- Supabase configuration errors are handled gracefully
- Service continues to function with proper error responses

### Edge Cases
- Users without subscriptions get clear error messages
- Expired subscriptions are automatically excluded
- Zero or negative page requests are handled

## Monitoring and Analytics

### Usage Tracking
- All fax usage is recorded in the `usage` table
- Metadata includes subscription ID and action type
- Enables detailed analytics and reporting

### Logging
- Credit check results are logged at INFO level
- Usage updates are logged with success/failure status
- Error conditions are logged at ERROR level

### Metrics Available
- Total pages used per user
- Subscription utilization rates
- Failed credit check attempts
- Usage patterns over time

## Security Considerations

### Access Control
- Service role access for database operations
- User ID validation from JWT payload
- Row-level security maintained

### Data Integrity
- Atomic credit deduction operations
- Consistent state between subscriptions and usage
- Audit trail for all credit operations

## Future Enhancements

### Planned Features
- **Credit Pooling**: Allow users to combine multiple subscriptions
- **Usage Alerts**: Notify users when credits are low
- **Auto-Renewal**: Automatic subscription renewal
- **Usage Analytics**: Detailed usage reports and insights
- **Freemium Analytics**: Track freemium usage patterns and conversion rates

### Performance Optimizations
- **Caching**: Cache user credit information
- **Batch Updates**: Optimize usage tracking for high-volume users
- **Connection Pooling**: Improve database connection efficiency 
