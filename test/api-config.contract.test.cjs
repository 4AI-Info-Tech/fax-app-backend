const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const configFiles = ['api-config.json', 'api-config.staging.json', 'api-config.prod.json'];
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function normalizeServiceSlug(bindingName) {
  return bindingName.toLowerCase().replace(/_service$/, '').replace(/_/g, '-');
}

function resolveServiceSourceFile(serviceSlug) {
  const serviceDir = path.join(repoRoot, 'services', serviceSlug, 'src');
  const candidates = [
    path.join(serviceDir, `${serviceSlug}.js`),
    path.join(serviceDir, 'index.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve source file for service "${serviceSlug}" in ${serviceDir}`);
}

const methodCache = new Map();
function getAsyncMethodSet(sourceFile) {
  if (methodCache.has(sourceFile)) {
    return methodCache.get(sourceFile);
  }

  const source = fs.readFileSync(sourceFile, 'utf8');
  const methodRegex = /^\s*async\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  const methods = new Set();
  let match = null;
  while ((match = methodRegex.exec(source)) !== null) {
    methods.add(match[1]);
  }

  methodCache.set(sourceFile, methods);
  return methods;
}

function extractWranglerServiceBindingsByEnv(wranglerTomlPath, envName) {
  const text = fs.readFileSync(wranglerTomlPath, 'utf8');
  const sectionRegex = new RegExp(`^\\[env\\.${envName}\\]\\n([\\s\\S]*?)(?=^\\[|\\Z)`, 'm');
  const sectionMatch = text.match(sectionRegex);
  if (!sectionMatch) {
    throw new Error(`Unable to find [env.${envName}] section in ${wranglerTomlPath}`);
  }

  const sectionBody = sectionMatch[1];
  const servicesMatch = sectionBody.match(/services\s*=\s*\[([\s\S]*?)\]/m);
  if (!servicesMatch) {
    return new Set();
  }

  const bindings = [...servicesMatch[1].matchAll(/binding\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  return new Set(bindings);
}

for (const configFile of configFiles) {
  test(`${configFile}: validates top-level contract`, () => {
    const config = readJson(configFile);

    assert.ok(Array.isArray(config.paths), `${configFile} should define a "paths" array`);
    assert.ok(config.paths.length > 0, `${configFile} should contain at least one route`);

    assert.ok(Array.isArray(config.serviceBindings), `${configFile} should define "serviceBindings"`);
    assert.ok(config.serviceBindings.length > 0, `${configFile} should contain at least one service binding`);

    assert.equal(typeof config.cors, 'object', `${configFile} should define "cors"`);
    assert.ok(Array.isArray(config.cors.allow_origins), `${configFile} should define cors.allow_origins`);
    assert.ok(Array.isArray(config.cors.allow_methods), `${configFile} should define cors.allow_methods`);
    assert.ok(Array.isArray(config.cors.allow_headers), `${configFile} should define cors.allow_headers`);
    assert.equal(typeof config.cors.allow_credentials, 'boolean', `${configFile} should define cors.allow_credentials as boolean`);
    assert.equal(typeof config.cors.max_age, 'number', `${configFile} should define cors.max_age as number`);

    const hasAuthProtectedRoute = config.paths.some((route) => route.auth === true);
    if (hasAuthProtectedRoute) {
      assert.equal(typeof config.authorizer, 'object', `${configFile} should define "authorizer"`);
      assert.ok(['jwt', 'auth0', 'supabase'].includes(config.authorizer.type), `${configFile} authorizer.type should be one of jwt|auth0|supabase`);

      if (config.authorizer.type === 'supabase') {
        assert.equal(typeof config.authorizer.issuer, 'string', `${configFile} should define authorizer.issuer`);
        assert.equal(typeof config.authorizer.audience, 'string', `${configFile} should define authorizer.audience`);
        assert.equal(typeof config.authorizer.jwt_secret, 'string', `${configFile} should define authorizer.jwt_secret`);
      }
    }
  });

  test(`${configFile}: each configured route resolves to a real handler`, () => {
    const config = readJson(configFile);
    const routeKeys = new Set();
    const usedBindingAliases = new Set();
    const serviceBindingAliases = new Set(config.serviceBindings.map((sb) => sb.alias));

    for (const route of config.paths) {
      assert.equal(typeof route.method, 'string', `${configFile} route is missing method`);
      assert.equal(typeof route.path, 'string', `${configFile} route is missing path`);
      assert.equal(typeof route.auth, 'boolean', `${configFile} route ${route.method} ${route.path} should define auth as boolean`);
      assert.equal(typeof route.integration, 'object', `${configFile} route ${route.method} ${route.path} should define integration`);

      assert.ok(allowedMethods.has(route.method), `${configFile} route ${route.method} ${route.path} uses unsupported HTTP method`);
      assert.ok(route.path.startsWith('/'), `${configFile} route ${route.method} ${route.path} should start with /`);

      const routeKey = `${route.method} ${route.path}`;
      assert.ok(!routeKeys.has(routeKey), `${configFile} contains duplicate route "${routeKey}"`);
      routeKeys.add(routeKey);

      if (route.integration.type !== 'service_binding') {
        continue;
      }

      const bindingAlias = route.integration.binding;
      const functionName = route.integration.function;

      assert.equal(typeof bindingAlias, 'string', `${configFile} route ${routeKey} should define integration.binding`);
      assert.equal(typeof functionName, 'string', `${configFile} route ${routeKey} should define integration.function`);
      assert.ok(serviceBindingAliases.has(bindingAlias), `${configFile} route ${routeKey} references unknown binding alias "${bindingAlias}"`);

      usedBindingAliases.add(bindingAlias);
      const bindingConfig = config.serviceBindings.find((sb) => sb.alias === bindingAlias);
      assert.ok(bindingConfig, `${configFile} missing serviceBinding for alias "${bindingAlias}"`);

      const serviceSlug = normalizeServiceSlug(bindingConfig.binding);
      const sourceFile = resolveServiceSourceFile(serviceSlug);
      const methods = getAsyncMethodSet(sourceFile);

      assert.ok(
        methods.has(functionName),
        `${configFile} route ${routeKey} points to missing handler "${functionName}" in ${sourceFile}`
      );
    }

    const unusedBindings = [...serviceBindingAliases].filter((alias) => !usedBindingAliases.has(alias));
    assert.equal(
      unusedBindings.length,
      0,
      `${configFile} has unused serviceBindings: ${unusedBindings.join(', ')}`
    );
  });
}

test('api-config.staging.json and api-config.prod.json: service bindings exist in wrangler.api.toml', () => {
  const wranglerPath = path.join(repoRoot, 'wrangler.api.toml');
  const stagingBindings = extractWranglerServiceBindingsByEnv(wranglerPath, 'staging');
  const prodBindings = extractWranglerServiceBindingsByEnv(wranglerPath, 'prod');

  const stagingConfig = readJson('api-config.staging.json');
  for (const serviceBinding of stagingConfig.serviceBindings) {
    assert.ok(
      stagingBindings.has(serviceBinding.binding),
      `wrangler.api.toml [env.staging] is missing binding ${serviceBinding.binding}`
    );
  }

  const prodConfig = readJson('api-config.prod.json');
  for (const serviceBinding of prodConfig.serviceBindings) {
    assert.ok(
      prodBindings.has(serviceBinding.binding),
      `wrangler.api.toml [env.prod] is missing binding ${serviceBinding.binding}`
    );
  }
});
