/**
 * Moves RevenueCat virtual currency balances between App User IDs.
 *
 * RevenueCat transfers subscriptions to the new App User ID on restore/login, but
 * in-app currencies are not transferable and stay with the original customer.
 * Without this, a user who buys a subscription while anonymous and then signs in
 * keeps the `pro` entitlement but ends up with 0 credits.
 *
 * Safe to retry: each source is drained to zero, so a repeated webhook finds
 * nothing left to move.
 *
 * `isAnonymousSource`, when given, limits moves to anonymous accounts so transfers
 * between two signed-in accounts keep their balances where they are.
 */
export async function transferVirtualCurrencyBalances({ rcClient, fromUserIds, toUserId, logger, isAnonymousSource }) {
	const result = { movedBalances: {}, sourcesMoved: 0, skippedSources: [] };
	if (!toUserId || !Array.isArray(fromUserIds)) {
		return result;
	}

	const normalizedTarget = String(toUserId).toLowerCase();

	for (const fromUserId of fromUserIds) {
		if (!fromUserId || String(fromUserId).toLowerCase() === normalizedTarget) {
			continue;
		}

		if (isAnonymousSource && !(await isAnonymousSource(fromUserId))) {
			logger.log('INFO', 'Skipping credit transfer from non-anonymous account', { fromUserId, toUserId });
			result.skippedSources.push(fromUserId);
			continue;
		}

		const currencies = await rcClient.listVirtualCurrencies(fromUserId);
		const balances = Object.fromEntries(
			currencies
				.filter((currency) => currency.balance > 0)
				.map((currency) => [currency.currencyCode, currency.balance])
		);

		if (Object.keys(balances).length === 0) {
			continue;
		}

		const debits = Object.fromEntries(
			Object.entries(balances).map(([currencyCode, amount]) => [currencyCode, -amount])
		);
		const debitResult = await rcClient.applyAdjustments(fromUserId, debits);
		if (!debitResult.success) {
			throw new Error(`Failed to debit virtual currencies from ${fromUserId}: ${debitResult.error || 'unknown error'}`);
		}

		try {
			const grantResult = await rcClient.applyAdjustments(toUserId, balances);
			if (!grantResult.success) {
				throw new Error(grantResult.error || 'Virtual currency grant failed');
			}
		} catch (error) {
			// Put the balance back on the source so a retried webhook can move it again.
			try {
				await rcClient.applyAdjustments(fromUserId, balances);
			} catch (rollbackError) {
				logger.log('ERROR', 'Failed to restore virtual currencies after a failed transfer', {
					fromUserId,
					toUserId,
					balances,
					error: rollbackError.message
				});
			}
			throw new Error(`Failed to grant virtual currencies to ${toUserId}: ${error.message}`);
		}

		for (const [currencyCode, amount] of Object.entries(balances)) {
			result.movedBalances[currencyCode] = (result.movedBalances[currencyCode] || 0) + amount;
		}
		result.sourcesMoved += 1;

		logger.log('INFO', 'Moved virtual currencies for transfer', { fromUserId, toUserId, balances });
	}

	return result;
}
