/**
 * Logger utility for AdMob service
 */
export class Logger {
	constructor(env) {
		this.env = env;
		// Temporarily defaulting to DEBUG for troubleshooting SSV verification
		this.logLevel = env?.LOG_LEVEL || 'DEBUG';
	}

	log(level, message, data = null) {
		const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
		const currentLevelIndex = levels.indexOf(this.logLevel);
		const messageLevelIndex = levels.indexOf(level);

		if (messageLevelIndex >= currentLevelIndex) {
			const logEntry = {
				timestamp: new Date().toISOString(),
				level,
				service: 'admob',
				message,
				...(data && { data })
			};
			console.log(JSON.stringify(logEntry));
		}
	}
}

/**
 * AdMob SSV Key Manager - Fetches and caches Google's public keys
 */
export class AdMobKeyManager {
	static KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
	static cachedKeys = null;
	static cacheExpiry = null;
	static CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

	/**
	 * Fetch public keys from Google's key server
	 */
	static async fetchPublicKeys(logger) {
		// Check cache first
		if (this.cachedKeys && this.cacheExpiry && Date.now() < this.cacheExpiry) {
			logger?.log('DEBUG', 'Using cached AdMob public keys');
			return this.cachedKeys;
		}

		logger?.log('INFO', 'Fetching AdMob public keys from Google');

		const response = await fetch(this.KEYS_URL);
		if (!response.ok) {
			throw new Error(`Failed to fetch AdMob keys: ${response.status}`);
		}

		const data = await response.json();

		// Parse keys into a map
		const keys = {};
		for (const key of data.keys) {
			keys[key.keyId] = key;
		}

		// Cache the keys
		this.cachedKeys = keys;
		this.cacheExpiry = Date.now() + this.CACHE_DURATION_MS;

		logger?.log('INFO', `Fetched ${Object.keys(keys).length} AdMob public keys`);
		return keys;
	}
}
