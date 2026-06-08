# Form Assistant Service

Cloudflare Worker backing the Send Fax Pro AI form-filling flow.

The service receives form metadata, PDF widget field names, and the current
conversation. PDF files and PDF URLs are never sent to the model.

Required Worker secrets:

- `OPENAI_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `REVENUECAT_SECRET_API_KEY`

Non-secret Worker variables are configured in `wrangler.toml` for default,
staging, and production:

- `ENVIRONMENT`
- `SUPABASE_URL`
- `REVENUECAT_PROJECT_ID`
- `AI_FORM_FREE_COMPLETIONS`
- `OPENAI_MODEL`
- `OPENAI_API_BASE_URL`
- `REVENUECAT_API_BASE_URL`
- `REVENUECAT_TIMEOUT_MS`
- `REVENUECAT_FREE_CURRENCY_CODES`
- `REVENUECAT_PRO_CURRENCY_CODES`

Set secrets independently for staging and production before deployment.

```bash
wrangler secret put OPENAI_API_KEY --env staging
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
wrangler secret put REVENUECAT_SECRET_API_KEY --env staging

wrangler secret put OPENAI_API_KEY --env prod
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env prod
wrangler secret put REVENUECAT_SECRET_API_KEY --env prod
```

Deploy from this service directory:

```bash
cd fax-app-backend/services/form-assistant
npm run deploy:staging
npm run deploy:prod
```

Or deploy from `fax-app-backend` with an explicit config path:

```bash
npx wrangler deploy --config services/form-assistant/wrangler.toml --env staging
npx wrangler deploy --config services/form-assistant/wrangler.toml --env prod
```

Running `wrangler deploy --env staging` from the repo root will fail because
the root directory does not contain this Worker's `wrangler.toml`.
