import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transferVirtualCurrencyBalances } from '../src/credit-transfer.js';

const ANON_USER = 'F2034C74-782E-4D8F-AAD3-E1FEBC3B5794';
const SIGNED_IN_USER = '89A5DB3A-8B19-4CB5-A17A-6F4AF334693D';

function createFakeClient(balancesByCustomer, { failGrantFor } = {}) {
	const balances = structuredClone(balancesByCustomer);
	return {
		balances,
		listVirtualCurrencies: vi.fn(async (customerId) =>
			Object.entries(balances[customerId] || {}).map(([currencyCode, balance]) => ({ currencyCode, balance }))
		),
		applyAdjustments: vi.fn(async (customerId, adjustments) => {
			if (customerId === failGrantFor && Object.values(adjustments).some((amount) => amount > 0)) {
				throw new Error('RevenueCat request failed (500)');
			}
			balances[customerId] = balances[customerId] || {};
			for (const [code, amount] of Object.entries(adjustments)) {
				balances[customerId][code] = (balances[customerId][code] || 0) + amount;
			}
			return { success: true };
		})
	};
}

describe('transferVirtualCurrencyBalances', () => {
	let logger;

	beforeEach(() => {
		logger = { log: vi.fn() };
	});

	it('moves subscription credits from the anonymous customer to the signed-in customer', async () => {
		const rcClient = createFakeClient({
			[ANON_USER]: { ProCredit: 40, FreeCredit: 3 },
			[SIGNED_IN_USER]: { ProCredit: 0 }
		});

		const result = await transferVirtualCurrencyBalances({
			rcClient,
			fromUserIds: [ANON_USER],
			toUserId: SIGNED_IN_USER,
			logger
		});

		expect(result).toEqual({ movedBalances: { ProCredit: 40, FreeCredit: 3 }, sourcesMoved: 1, skippedSources: [] });
		expect(rcClient.balances[ANON_USER]).toEqual({ ProCredit: 0, FreeCredit: 0 });
		expect(rcClient.balances[SIGNED_IN_USER]).toEqual({ ProCredit: 40, FreeCredit: 3 });
	});

	it('is a no-op when the webhook is retried after a successful move', async () => {
		const rcClient = createFakeClient({
			[ANON_USER]: { ProCredit: 40 },
			[SIGNED_IN_USER]: {}
		});
		const args = { rcClient, fromUserIds: [ANON_USER], toUserId: SIGNED_IN_USER, logger };

		await transferVirtualCurrencyBalances(args);
		const retry = await transferVirtualCurrencyBalances(args);

		expect(retry.sourcesMoved).toBe(0);
		expect(rcClient.balances[SIGNED_IN_USER]).toEqual({ ProCredit: 40 });
	});

	it('skips the target ID regardless of case', async () => {
		const rcClient = createFakeClient({ [SIGNED_IN_USER]: { ProCredit: 40 } });

		const result = await transferVirtualCurrencyBalances({
			rcClient,
			fromUserIds: [SIGNED_IN_USER.toLowerCase()],
			toUserId: SIGNED_IN_USER,
			logger
		});

		expect(result.sourcesMoved).toBe(0);
		expect(rcClient.applyAdjustments).not.toHaveBeenCalled();
	});

	it('restores the source balance and throws when the grant fails', async () => {
		const rcClient = createFakeClient(
			{ [ANON_USER]: { ProCredit: 40 }, [SIGNED_IN_USER]: {} },
			{ failGrantFor: SIGNED_IN_USER }
		);

		await expect(
			transferVirtualCurrencyBalances({
				rcClient,
				fromUserIds: [ANON_USER],
				toUserId: SIGNED_IN_USER,
				logger
			})
		).rejects.toThrow(/Failed to grant/);

		expect(rcClient.balances[ANON_USER]).toEqual({ ProCredit: 40 });
	});

	it('throws without granting when the debit is rejected', async () => {
		const rcClient = createFakeClient({ [ANON_USER]: { ProCredit: 40 } });
		rcClient.applyAdjustments.mockResolvedValueOnce({ success: false, insufficientCredits: true, error: 'Insufficient credits' });

		await expect(
			transferVirtualCurrencyBalances({
				rcClient,
				fromUserIds: [ANON_USER],
				toUserId: SIGNED_IN_USER,
				logger
			})
		).rejects.toThrow(/Failed to debit/);

		expect(rcClient.applyAdjustments).toHaveBeenCalledTimes(1);
	});

	it('leaves balances on non-anonymous sources', async () => {
		const rcClient = createFakeClient({
			[ANON_USER]: { ProCredit: 40 },
			[SIGNED_IN_USER]: { ProCredit: 5 }
		});
		const isAnonymousSource = vi.fn(async () => false);

		const result = await transferVirtualCurrencyBalances({
			rcClient,
			fromUserIds: [ANON_USER],
			toUserId: SIGNED_IN_USER,
			logger,
			isAnonymousSource
		});

		expect(isAnonymousSource).toHaveBeenCalledWith(ANON_USER);
		expect(result).toEqual({ movedBalances: {}, sourcesMoved: 0, skippedSources: [ANON_USER] });
		expect(rcClient.listVirtualCurrencies).not.toHaveBeenCalled();
		expect(rcClient.balances[ANON_USER]).toEqual({ ProCredit: 40 });
	});

	it('moves balances from sources the predicate marks anonymous', async () => {
		const rcClient = createFakeClient({
			[ANON_USER]: { ProCredit: 40 },
			[SIGNED_IN_USER]: {}
		});

		const result = await transferVirtualCurrencyBalances({
			rcClient,
			fromUserIds: [ANON_USER],
			toUserId: SIGNED_IN_USER,
			logger,
			isAnonymousSource: async () => true
		});

		expect(result.sourcesMoved).toBe(1);
		expect(rcClient.balances[SIGNED_IN_USER]).toEqual({ ProCredit: 40 });
	});
});
