# AdMob Service

Server-side verification (SSV) service for AdMob rewarded ads.

## Overview

This service handles AdMob SSV callbacks to validate rewarded ad views and grant page rewards to users. It implements Google's recommended verification process using ECDSA signature verification.

## Endpoints

### SSV Callback
- **Path**: `GET /v1/admob/ssv`
- **Auth**: None (verified via signature)
- **Description**: Receives callbacks from Google when users complete watching rewarded ads

### Health Check
- **Path**: `GET /v1/admob/health`
- **Auth**: None
- **Description**: Service health check

## SSV Callback Parameters

Google sends the following query parameters:

| Parameter | Description |
|-----------|-------------|
| `ad_network` | Ad source identifier |
| `ad_unit` | AdMob ad unit ID |
| `custom_data` | Custom data string (optional) |
| `key_id` | Key ID for signature verification |
| `reward_amount` | Reward amount from ad unit settings |
| `reward_item` | Reward item name |
| `signature` | ECDSA signature |
| `timestamp` | Epoch timestamp in ms |
| `transaction_id` | Unique transaction identifier |
| `user_id` | User identifier (set in app) |

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `ADMOB_SKIP_VERIFICATION` | Skip signature verification (dev only) |
| `LOG_LEVEL` | Logging level (DEBUG, INFO, WARN, ERROR) |

### AdMob Console Setup

1. Go to AdMob Console > Apps > Your App > Ad Units
2. Select your rewarded ad unit
3. Enable "Server-side verification"
4. Set callback URL: `https://api.sendfax.pro/v1/admob/ssv`
5. Optionally set a custom user ID for testing

## Security

- Signatures are verified using Google's public keys
- Public keys are cached for 24 hours
- Transaction IDs are checked for idempotency
- Monthly cap of 15 rewarded videos per user

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Run tests
npm test

# Deploy
npm run deploy
```
