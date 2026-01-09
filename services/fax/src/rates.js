/**
 * Rate table utilities for number lookup and pricing
 * 
 * This module provides prefix matching and rate lookup functionality.
 * Rate tables should be provided as sorted arrays of prefixes and corresponding rates.
 */

const MAX_PREFIX_LEN = 15;

/**
 * Extract digits only from a string
 * @param {string} s - Input string
 * @returns {string} Digits only
 */
export function digitsOnly(s) {
	s = String(s || "");
	let o = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 48 && c <= 57) o += s[i];
	}
	// Remove leading "00" if present (international format)
	if (o.startsWith("00")) o = o.slice(2);
	return o;
}

/**
 * Binary search for exact prefix match in sorted array
 * @param {string[]} arr - Sorted array of prefixes
 * @param {string} key - Prefix to search for
 * @returns {number} Index if found, -1 otherwise
 */
export function bsearchExact(arr, key) {
	let lo = 0, hi = arr.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const v = arr[mid];
		if (v === key) return mid;
		if (v < key) lo = mid + 1;
		else hi = mid - 1;
	}
	return -1;
}

/**
 * Find the longest matching prefix rate
 * @param {string[]} prefixes - Sorted array of prefixes
 * @param {number[]} rates - Array of rates in microUSD per minute (corresponding to prefixes)
 * @param {string} digits - Phone number digits to match
 * @returns {Object|null} Rate match object with prefix and rate_usd_per_min, or null if no match
 */
export function longestPrefixRate(prefixes, rates, digits) {
	if (!digits || !prefixes || !rates || prefixes.length !== rates.length) {
		return null;
	}
	
	const L = Math.min(digits.length, MAX_PREFIX_LEN);
	for (let len = L; len >= 1; len--) {
		const pref = digits.slice(0, len);
		const idx = bsearchExact(prefixes, pref);
		if (idx !== -1) {
			return {
				prefix: pref,
				rate_usd_per_min: rates[idx] / 1_000_000
			};
		}
	}
	return null;
}

/**
 * Derive NANP LRN prefix for US/CA numbers
 * For US/CA, use LRN -> "1" + NPANXX (first 6 digits of LRN)
 * @param {Object} lookupData - Telnyx lookup response data
 * @returns {string|null} LRN prefix (e.g., "1234298") or null if not applicable
 */
export function deriveNANPLrnPrefix(lookupData) {
	const cc = lookupData?.country_code;
	if (cc !== "US" && cc !== "CA") return null;

	const lrnRaw = lookupData?.portability?.lrn;
	const lrnDigits = digitsOnly(lrnRaw);
	// LRN example like "234298XXXX" -> "234298"
	if (lrnDigits.length < 6) return null;

	return "1" + lrnDigits.slice(0, 6); // 1 + NPANXX
}

/**
 * Calculate rate using LRN-first pricing logic
 * For US/CA numbers, uses LRN-derived prefix if available, otherwise falls back to dialed prefix
 * @param {Object} lookupData - Telnyx lookup response data
 * @param {string} dialedDigits - Dialed phone number digits
 * @param {string[]} prefixes - Sorted array of prefixes
 * @param {number[]} rates - Array of rates in microUSD per minute (corresponding to prefixes)
 * @returns {Object} Rate calculation result with lrnPrefix, lrnMatch, dialedMatch, and billed rate
 */
export function calculateRate(lookupData, dialedDigits, prefixes, rates) {
	// LRN-first pricing logic
	// 1) If we can derive LRN prefix for NANP, price using that
	// 2) If no match found, fall back to dialed prefix
	const lrnPrefix = deriveNANPLrnPrefix(lookupData);
	const lrnMatch = lrnPrefix ? longestPrefixRate(prefixes, rates, lrnPrefix) : null;
	const dialedMatch = longestPrefixRate(prefixes, rates, dialedDigits);

	const billed = lrnMatch || dialedMatch; // LRN-first, dialed fallback

	return {
		lrnPrefix: lrnPrefix || null,
		lrnMatch,
		dialedMatch,
		billed
	};
}

// Import rate table JSON file
// Note: In Cloudflare Workers, static imports of JSON files are supported
// The file will be bundled at build time
import rateTableData from './rate-table.json';

/**
 * Get rate tables from rate-table.json file
 * @param {Object} callerEnvObj - Environment variables (not used currently, but kept for future extensibility)
 * @returns {Object} Rate tables with prefixes and rates arrays
 */
export function getRateTables(callerEnvObj) {
	try {
		return {
			prefixes: rateTableData.prefixes || [],
			rates: rateTableData.rates || []
		};
	} catch (error) {
		// Fallback to empty structure if file cannot be loaded
		// This could happen during development or if the file is missing
		console.warn('Failed to load rate-table.json, using empty rate table:', error.message);
		return {
			prefixes: [],
			rates: []
		};
	}
}
