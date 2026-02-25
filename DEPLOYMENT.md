# 🚀 Deployment Guide

This guide explains how to use the deployment script for the Fax App Backend project, which includes the Serverless API Gateway and various microservices.

## 📋 Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Command Syntax](#command-syntax)
- [Command Options](#command-options)
- [Environment Configuration](#environment-configuration)
- [Testing Integration](#testing-integration)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

## 🎯 Overview

The deployment script (`scripts/deploy.sh`) is a comprehensive tool that:

- **Runs tests** for all services before deployment
- **Deploys the main API Gateway** worker
- **Deploys individual microservices** (optional)
- **Manages environment-specific configurations**
- **Provides detailed feedback** with colored output
- **Ensures deployment safety** through pre-deployment testing

## 📦 Prerequisites

Before using the deployment script, ensure you have:

1. **Wrangler CLI** installed and configured
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Node.js and npm** for running tests
   ```bash
   node --version  # Should be >= 18
   npm --version
   ```

3. **Required configuration files**:
   - `wrangler.<project>.toml` - Main worker configuration
   - `api-config.<project>.json` - API Gateway configuration
   - Individual service `wrangler.toml` files in service directories

4. **Environment variables** configured in Wrangler dashboard or `.env` files

## ⚡ Quick Start

```bash
# Deploy API Gateway with all services (runs tests first)
./scripts/deploy.sh api all

# Deploy to staging environment
./scripts/deploy.sh api all --env staging

# Deploy only the main API Gateway
./scripts/deploy.sh api
```

## 📖 Command Syntax

```bash
./scripts/deploy.sh <project> [all] [--env <environment>] [--skip-tests]
```

### Parameters

- **`<project>`** *(required)*: Project name used for configuration files
- **`all`** *(optional)*: Deploy all services in addition to the main worker
- **`--env <environment>`** *(optional)*: Target environment (staging, prod, etc.)
- **`--skip-tests`** *(optional)*: Skip running tests before deployment

## ⚙️ Command Options

### Core Options

| Option | Description | Example |
|--------|-------------|---------|
| `<project>` | Project identifier for config files | `api` |
| `all` | Deploy all services | `./scripts/deploy.sh api all` |
| `--env <env>` | Deploy to specific environment | `--env staging` |
| `--skip-tests` | Skip pre-deployment tests | `--skip-tests` |

### Environment Values

- **`staging`**: Deploy to staging environment
- **`prod`**: Deploy to production environment
- *(no env)*: Deploy to default/development environment

## 🌍 Environment Configuration

### Configuration Files

The script uses environment-specific configuration files:

```
├── wrangler.api.toml          # Main worker config
├── api-config.api.json        # API Gateway routes
└── services/
    ├── fax/
    │   └── wrangler.toml       # Fax service config
    └── other-service/
        └── wrangler.toml       # Other service config
```

### Environment Variables

Configure these in your Wrangler dashboard or environment:

```bash
# Auth0 Configuration
AUTH0_DOMAIN="your-domain.auth0.com"
AUTH0_CLIENT_ID="your-client-id"
AUTH0_CLIENT_SECRET="your-client-secret"
AUTH0_REDIRECT_URI="https://api.yourdomain.com/v1/auth/callback"

# Service Bindings
FAX_SERVICE="fax-service"          # Development
FAX_SERVICE="fax-service-staging"  # Staging
FAX_SERVICE="fax-service-prod"     # Production
```

## 🧪 Testing Integration

### Automatic Testing

The script automatically runs tests for all services before deployment:

1. **Service Discovery**: Scans `./services/*` directories
2. **Test Detection**: Checks for `package.json` and test scripts
3. **Test Execution**: Runs `npm test -- --run` for each service
4. **Validation**: Only proceeds if ALL tests pass

### Test Requirements

For a service to be tested, it must have:

```json
{
  "scripts": {
    "test": "vitest"
  }
}
```

### Test Output

```bash
===========================================
Running tests for all services...
===========================================
Running tests for service: fax
✓ Tests passed for fax
Running tests for service: analytics
✓ Tests passed for analytics

===========================================
Test Results Summary:
===========================================
Passed tests:
  ✓ fax
  ✓ analytics

===========================================
All tests passed! Proceeding with deployment...
===========================================
```

## 📚 Usage Examples

### Basic Deployment

```bash
# Deploy only the main API Gateway
./scripts/deploy.sh api

# Deploy API Gateway + all services
./scripts/deploy.sh api all
```

### Environment-Specific Deployment

```bash
# Deploy to staging
./scripts/deploy.sh api all --env staging

# Deploy to production
./scripts/deploy.sh api all --env prod
```

### Emergency Deployment

```bash
# Skip tests for urgent hotfix
./scripts/deploy.sh api all --skip-tests

# Deploy specific environment without tests
./scripts/deploy.sh api all --env prod --skip-tests
```

### Development Workflow

```bash
# 1. Run tests and deploy to development
./scripts/deploy.sh api all

# 2. Deploy to staging for testing
./scripts/deploy.sh api all --env staging

# 3. Deploy to production after approval
./scripts/deploy.sh api all --env prod
```

## 🎨 Output Examples

### Successful Deployment

```bash
===========================================
Deployment Configuration:
===========================================
Project: api
Config Path: wrangler.api.toml
API Config: api-config.api.json
Environment: staging
Deploy All Services: true
Skip Tests: false
===========================================

===========================================
Running tests for all services...
===========================================
✓ Tests passed for fax
✓ Tests passed for analytics

===========================================
Starting deployment process...
===========================================
✓ Main worker deployed successfully

===========================================
Deploying all services...
===========================================
✓ Service fax deployed successfully
✓ Service analytics deployed successfully

===========================================
🎉 All deployments completed successfully!
===========================================
```

### Failed Tests

```bash
===========================================
Test Results Summary:
===========================================
Passed tests:
  ✓ analytics

Failed tests:
  ✗ fax

===========================================
Deployment aborted due to test failures!
Please fix the failing tests before deploying.
===========================================
```

## 🔧 Troubleshooting

### Common Issues

#### 1. **Tests Failing**
```bash
# Check specific service tests
cd services/fax
npm test

# Fix issues and retry deployment
./scripts/deploy.sh api all
```

#### 2. **Missing Configuration Files**
```bash
# Error: wrangler.api.toml not found
ls -la wrangler.*.toml

# Error: api-config.api.json not found  
ls -la api-config.*.json
```

#### 3. **Service Binding Issues**
```bash
# Check service configuration
cat wrangler.api.toml | grep -A 5 "\[\[services\]\]"

# Verify service is deployed
wrangler deployments list --name fax-service
```

#### 4. **Authentication Issues**
```bash
# Re-authenticate with Wrangler
wrangler login

# Check current user
wrangler whoami
```

### Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `Tests failed for <service>` | Service tests failing | Fix failing tests in the service |
| `wrangler.toml not found` | Missing service config | Create `wrangler.toml` in service directory |
| `Main worker deployment failed` | Configuration or auth issue | Check `wrangler.api.toml` and authentication |
| `Service binding not found` | Service not deployed | Deploy the service first |

### 5. **Converter Service (Shared, Container-Based)**

The `converter` service is a **shared Cloudflare Container** (no `-staging` / `-prod` suffix). It is intentionally skipped during env-specific deployments (`--env staging`, `--env prod`) because:

- It uses a `Dockerfile` that Wrangler must build with Docker.
- It is not environment-specific — both staging and prod bind to the same `converter-service`.

**To update the converter**, run it separately **without `--env`** (requires Docker running):

```bash
cd services/converter && npx wrangler deploy
```

Or deploy only services in the default environment:

```bash
./scripts/deploy.sh api all --skip-tests  # deploys converter + other default-env services
```

### 1. **Always Run Tests**
```bash
# ✅ Good: Run tests before deployment
./scripts/deploy.sh api all

# ❌ Avoid: Skipping tests unless emergency
./scripts/deploy.sh api all --skip-tests
```

### 2. **Environment Progression**
```bash
# 1. Development
./scripts/deploy.sh api all

# 2. Staging
./scripts/deploy.sh api all --env staging

# 3. Production (after validation)
./scripts/deploy.sh api all --env prod
```

### 3. **Service Dependencies**
```bash
# Deploy dependencies first
./scripts/deploy.sh api        # Deploy API Gateway
./scripts/deploy.sh api all    # Then deploy services
```

### 4. **Configuration Management**
- Keep environment-specific configs separate
- Use environment variables for secrets
- Version control configuration files
- Test configuration changes in staging first

### 5. **Monitoring and Validation**
```bash
# After deployment, verify services
curl https://api.sendfax.pro/v1/health
curl https://api-staging.sendfax.pro/v1/fax/status

# Check Cloudflare dashboard for metrics
# Monitor logs for errors
```

## 🆘 Support

If you encounter issues:

1. **Check the logs** from the deployment output
2. **Verify configuration** files are correct
3. **Test locally** before deploying
4. **Check Cloudflare dashboard** for service status
5. **Review Wrangler documentation** for specific errors

## 📝 Notes

- The script requires bash shell (available on macOS, Linux, and WSL)
- All services are deployed in parallel for faster deployment
- Service bindings are automatically configured based on environment
- KV namespaces are only updated for the main worker, not individual services

---

*For more information about the Fax App Backend architecture, see the main README.md file.* 
