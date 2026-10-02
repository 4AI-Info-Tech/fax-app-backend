#!/usr/bin/env node
/**
 * One-off backfill: move virtual currency balances that past RevenueCat TRANSFER events
 * left on anonymous accounts (before src/credit-transfer.js existed).
 *
 * Dry run (default, read-only):
 *   node --env-file=<private env file> scripts/backfill-transfer-credits.mjs
 * Apply:
 *   node --env-file=<private env file> scripts/backfill-transfer-credits.mjs --apply [--include-missing]
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REVENUECAT_SECRET_API_KEY,
 * REVENUECAT_PROJECT_ID. Values are never printed.
 *
 * Sources are eligible when they are a RevenueCat anonymous ID or an anonymous Supabase
 * user. Sources whose Supabase user no longer exists are reported as `missing` and only
 * moved with --include-missing, because a deleted account is not proof it was anonymous.
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RevenueCatClient } from '../../shared/revenuecat-client.js';
import { transferVirtualCurrencyBalances } from '../src/credit-transfer.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 1000;

/**
 * Reduce stored TRANSFER webhook rows to one (source → latest target) pair per source.
 * A source transferred more than once ends with whichever target received it last.
 */
export function collectTransferPairs(rows) {
	const events = (rows || [])
		.map((row) => row?.raw_data?.event)
		.filter((event) => event && Array.isArray(event.transferred_from) && Array.isArray(event.transferred_to))
		.sort((a, b) => Number(a.event_timestamp_ms || 0) - Number(b.event_timestamp_ms || 0));

	const latestBySource = new Map();
	for (const event of events) {
		const toUserId = event.transferred_to.find(Boolean);
		if (!toUserId) continue;

		for (const fromUserId of event.transferred_from) {
			if (!fromUserId || String(fromUserId).toLowerCase() === String(toUserId).toLowerCase()) {
				continue;
			}
			latestBySource.set(String(fromUserId).toLowerCase(), {
				eventId: event.id || null,
				eventTimestampMs: event.event_timestamp_ms || null,
				fromUserId,
				toUserId
			});
		}
	}

	return [...latestBySource.values()];
}

async function classifySource(supabase, userId) {
	if (String(userId).startsWith('$RCAnonymousID:')) return 'rc_anonymous';
	if (!UUID_REGEX.test(String(userId))) return 'custom';

	const { data, error } = await supabase.auth.admin.getUserById(String(userId).toLowerCase());
	if (!error && data?.user) {
		const isAnonymous = data.user.app_metadata?.is_anonymous === true || data.user.is_anonymous === true;
		return isAnonymous ? 'anonymous' : 'signed_in';
	}
	if (error && error.status !== 404) {
		throw new Error(`Supabase lookup failed for ${userId}: ${error.message}`);
	}
	return 'missing';
}

async function fetchTransferRows(supabase) {
	const rows = [];
	for (let from = 0; ; from += PAGE_SIZE) {
		const { data, error } = await supabase
			.from('revenuecat_webhook_events')
			.select('event_id, raw_data')
			.eq('event_type', 'TRANSFER')
			.order('processed_at', { ascending: true })
			.range(from, from + PAGE_SIZE - 1);
		if (error) throw new Error(`Failed to read TRANSFER events: ${error.message}`);
		rows.push(...(data || []));
		if (!data || data.length < PAGE_SIZE) return rows;
	}
}

function positiveBalances(currencies) {
	return Object.fromEntries(
		currencies.filter((currency) => currency.balance > 0).map((currency) => [currency.currencyCode, currency.balance])
	);
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const apply = args.has('--apply');
	const includeMissing = args.has('--include-missing');

	const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REVENUECAT_SECRET_API_KEY', 'REVENUECAT_PROJECT_ID'];
	const missingEnv = required.filter((name) => !process.env[name]);
	if (missingEnv.length > 0) {
		console.error(`Missing env: ${missingEnv.join(', ')}`);
		process.exit(2);
	}

	const logger = {
		log(level, message, data) {
			if (level !== 'DEBUG') console.error(`[${level}] ${message}`, data ? JSON.stringify(data) : '');
		}
	};
	const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
	const rcClient = new RevenueCatClient(process.env, logger);

	const rows = await fetchTransferRows(supabase);
	const pairs = collectTransferPairs(rows);
	console.log(`TRANSFER events: ${rows.length}, distinct sources: ${pairs.length}, mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

	const report = [];
	for (const pair of pairs) {
		const entry = { ...pair };
		try {
			entry.sourceKind = await classifySource(supabase, pair.fromUserId);
			entry.sourceBalances = positiveBalances(await rcClient.listVirtualCurrencies(pair.fromUserId));
			entry.targetBalancesBefore = positiveBalances(await rcClient.listVirtualCurrencies(pair.toUserId));
			entry.targetHasActiveEntitlement = (await rcClient.listActiveEntitlements(pair.toUserId)).length > 0;

			const eligibleKind = ['rc_anonymous', 'anonymous'].includes(entry.sourceKind)
				|| (includeMissing && entry.sourceKind === 'missing');
			const hasBalance = Object.keys(entry.sourceBalances).length > 0;
			entry.action = !hasBalance ? 'nothing_to_move' : eligibleKind ? 'move' : `skip_${entry.sourceKind}`;

			if (apply && entry.action === 'move') {
				const result = await transferVirtualCurrencyBalances({
					rcClient,
					fromUserIds: [pair.fromUserId],
					toUserId: pair.toUserId,
					logger
				});
				entry.moved = result.movedBalances;
				entry.targetBalancesAfter = positiveBalances(await rcClient.listVirtualCurrencies(pair.toUserId));
				entry.sourceBalancesAfter = positiveBalances(await rcClient.listVirtualCurrencies(pair.fromUserId));
			}
		} catch (error) {
			entry.action = 'error';
			entry.error = error.message;
		}
		report.push(entry);
		console.log(
			`${entry.action.padEnd(16)} ${pair.fromUserId} -> ${pair.toUserId} `
			+ `kind=${entry.sourceKind ?? '?'} source=${JSON.stringify(entry.sourceBalances ?? {})} `
			+ `targetPro=${entry.targetHasActiveEntitlement ?? '?'}`
			+ (entry.moved ? ` moved=${JSON.stringify(entry.moved)}` : '')
			+ (entry.error ? ` error=${entry.error}` : '')
		);
	}

	const totals = {};
	for (const entry of report.filter((item) => item.action === 'move')) {
		for (const [code, amount] of Object.entries(entry.sourceBalances)) {
			totals[code] = (totals[code] || 0) + amount;
		}
	}
	const summary = {
		mode: apply ? 'apply' : 'dry_run',
		includeMissing,
		transferEvents: rows.length,
		sources: pairs.length,
		byAction: report.reduce((acc, item) => ({ ...acc, [item.action]: (acc[item.action] || 0) + 1 }), {}),
		totalsToMove: totals
	};
	console.log(JSON.stringify(summary, null, 2));

	const logDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backfill-logs');
	mkdirSync(logDir, { recursive: true });
	const logFile = path.join(logDir, `backfill-${new Date().toISOString().replace(/[:.]/g, '-')}-${summary.mode}.json`);
	writeFileSync(logFile, JSON.stringify({ summary, report }, null, 2));
	console.log(`Log written to ${logFile}`);

	if (report.some((item) => item.action === 'error')) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`Backfill failed: ${error.message}`);
		process.exit(1);
	});
}
