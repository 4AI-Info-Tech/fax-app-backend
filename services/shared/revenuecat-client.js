/**
 * Shared RevenueCat API client for backend services.
 *
 * Uses RevenueCat API v2:
 * - GET  /projects/{project_id}/customers/{customer_id}/virtual_currencies
 * - GET  /projects/{project_id}/customers/{customer_id}/active_entitlements
 * - POST /projects/{project_id}/customers/{customer_id}/virtual_currencies/transactions
 */

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_FREE_CURRENCY_CODES = ['FreeCredit', 'free_credits'];
const DEFAULT_PRO_CURRENCY_CODES = ['ProCredit', 'pro_credits'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCurrencyCodes(rawValue, defaults) {
	if (!rawValue || typeof rawValue !== 'string') {
		return [...defaults];
	}

	const parsed = rawValue
		.split(',')
		.map((code) => code.trim())
		.filter(Boolean);

	return parsed.length > 0 ? parsed : [...defaults];
}

function extractItems(payload) {
	if (Array.isArray(payload?.items)) return payload.items;
	if (Array.isArray(payload?.data?.items)) return payload.data.items;
	if (Array.isArray(payload?.data)) return payload.data;
	return [];
}

function toInteger(value, fallback = 0) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return fallback;
	}
	return Math.trunc(numeric);
}

function normalizeCustomerId(customerId) {
	if (!customerId) return customerId;
	const asString = String(customerId);
	if (UUID_REGEX.test(asString)) {
		return asString.toUpperCase();
	}
	return asString;
}

class RevenueCatApiError extends Error {
	constructor(message, status, body) {
		super(message);
		this.name = 'RevenueCatApiError';
		this.status = status;
		this.body = body;
	}
}

export class RevenueCatClient {
	constructor(env, logger) {
		this.env = env || {};
		this.logger = logger;
		this.baseUrl = (this.env.REVENUECAT_API_BASE_URL || 'https://api.revenuecat.com/v2').replace(/\/+$/, '');
		this.projectId = this.env.REVENUECAT_PROJECT_ID || this.env.REVENUECAT_PROJECT || this.env.RC_PROJECT_ID || '';
		this.apiKey = this.env.REVENUECAT_SECRET_API_KEY || this.env.REVENUECAT_API_KEY || this.env.REVENUECAT_SECRET_KEY || '';
		this.timeoutMs = Number(this.env.REVENUECAT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
		this.freeCurrencyCodes = parseCurrencyCodes(
			this.env.REVENUECAT_FREE_CURRENCY_CODES || this.env.REVENUECAT_FREE_CURRENCY_CODE,
			DEFAULT_FREE_CURRENCY_CODES
		);
		this.proCurrencyCodes = parseCurrencyCodes(
			this.env.REVENUECAT_PRO_CURRENCY_CODES || this.env.REVENUECAT_PRO_CURRENCY_CODE,
			DEFAULT_PRO_CURRENCY_CODES
		);
	}

	isConfigured() {
		return Boolean(this.projectId && this.apiKey);
	}

	getConfigurationError() {
		const missing = [];
		if (!this.projectId) missing.push('REVENUECAT_PROJECT_ID');
		if (!this.apiKey) missing.push('REVENUECAT_SECRET_API_KEY');
		if (missing.length === 0) return null;
		return `Missing RevenueCat configuration: ${missing.join(', ')}`;
	}

	buildCustomerPath(customerId, suffix) {
		const normalizedCustomerId = normalizeCustomerId(customerId);
		return `/projects/${encodeURIComponent(this.projectId)}/customers/${encodeURIComponent(normalizedCustomerId)}${suffix}`;
	}

	async request(path, options = {}) {
		if (!this.isConfigured()) {
			throw new RevenueCatApiError(this.getConfigurationError() || 'RevenueCat not configured', 500, null);
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				method: options.method || 'GET',
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
					Accept: 'application/json',
					...(options.headers || {})
				},
				body: options.body ? JSON.stringify(options.body) : undefined,
				signal: controller.signal
			});

			const raw = await response.text();
			let parsed = null;
			if (raw) {
				try {
					parsed = JSON.parse(raw);
				} catch {
					parsed = { raw };
				}
			}

			if (!response.ok) {
				throw new RevenueCatApiError(
					`RevenueCat request failed (${response.status})`,
					response.status,
					parsed
				);
			}

			return parsed || {};
		} finally {
			clearTimeout(timeout);
		}
	}

	async listVirtualCurrencies(customerId) {
		const payload = await this.request(this.buildCustomerPath(customerId, '/virtual_currencies'));
		const items = extractItems(payload);
		return items.map((item) => ({
			currencyCode: item?.currency_code || item?.code || null,
			balance: toInteger(item?.balance ?? item?.current_balance ?? 0, 0)
		})).filter((item) => item.currencyCode);
	}

	async listActiveEntitlements(customerId) {
		try {
			const payload = await this.request(this.buildCustomerPath(customerId, '/active_entitlements'));
			return extractItems(payload);
		} catch (error) {
			if (error instanceof RevenueCatApiError && error.status === 404) {
				return [];
			}
			throw error;
		}
	}

	resolveCurrencyCode(balanceMap, preferredCodes, fallbackToFirstPreferred = false) {
		for (const code of preferredCodes) {
			if (balanceMap.has(code)) {
				return code;
			}
		}

		const lowered = new Map();
		for (const [code] of balanceMap.entries()) {
			lowered.set(code.toLowerCase(), code);
		}
		for (const code of preferredCodes) {
			const matched = lowered.get(code.toLowerCase());
			if (matched) {
				return matched;
			}
		}

		return fallbackToFirstPreferred ? preferredCodes[0] || null : null;
	}

	resolveBalance(balanceMap, preferredCodes) {
		const code = this.resolveCurrencyCode(balanceMap, preferredCodes, false);
		if (!code) return 0;
		return toInteger(balanceMap.get(code), 0);
	}

	buildSnapshotFromData(customerId, entitlements, currencies) {
		const isSubscriber = Array.isArray(entitlements) && entitlements.length > 0;
		const balanceMap = new Map();
		for (const currency of currencies || []) {
			balanceMap.set(currency.currencyCode, currency.balance);
		}

		const freeCredits = this.resolveBalance(balanceMap, this.freeCurrencyCodes);
		const proCredits = this.resolveBalance(balanceMap, this.proCurrencyCodes);
		const activeCurrencyCode = isSubscriber
			? this.resolveCurrencyCode(balanceMap, this.proCurrencyCodes, true)
			: this.resolveCurrencyCode(balanceMap, this.freeCurrencyCodes, true);
		const activeCredits = isSubscriber ? proCredits : freeCredits;

		return {
			customerId,
			isSubscriber,
			freeCredits,
			proCredits,
			activeCredits,
			activeCurrencyCode,
			balances: Object.fromEntries(balanceMap.entries())
		};
	}

	async fetchCustomerSnapshot(customerId) {
		const [entitlements, currencies] = await Promise.all([
			this.listActiveEntitlements(customerId),
			this.listVirtualCurrencies(customerId)
		]);
		return this.buildSnapshotFromData(customerId, entitlements, currencies);
	}

	async getCreditSnapshot(customerId) {
		const normalizedCustomerId = normalizeCustomerId(customerId);
		return this.fetchCustomerSnapshot(normalizedCustomerId);
	}

	async applyAdjustments(customerId, adjustments) {
		const normalized = Object.entries(adjustments || {})
			.map(([currencyCode, amount]) => [currencyCode, toInteger(amount, 0)])
			.filter(([currencyCode, amount]) => Boolean(currencyCode) && amount !== 0);

		if (normalized.length === 0) {
			return { success: true, skipped: true, balances: {} };
		}

		const payload = {
			adjustments: Object.fromEntries(normalized)
		};

		try {
			const result = await this.request(
				this.buildCustomerPath(customerId, '/virtual_currencies/transactions'),
				{
					method: 'POST',
					body: payload
				}
			);

			return {
				success: true,
				data: result
			};
		} catch (error) {
			if (error instanceof RevenueCatApiError && error.status === 422) {
				return {
					success: false,
					insufficientCredits: true,
					status: 422,
					error: error.body?.message || 'Insufficient credits'
				};
			}

			throw error;
		}
	}

	async grantCredits(customerId, currencyCode, amount) {
		const granted = Math.max(0, toInteger(amount, 0));
		if (granted <= 0) {
			return { success: true, skipped: true };
		}
		return this.applyAdjustments(customerId, { [currencyCode]: granted });
	}

	async consumeCredits(customerId, currencyCode, amount) {
		const consumed = Math.max(0, toInteger(amount, 0));
		if (consumed <= 0) {
			return { success: true, skipped: true };
		}
		return this.applyAdjustments(customerId, { [currencyCode]: -consumed });
	}
}

export { RevenueCatApiError };
