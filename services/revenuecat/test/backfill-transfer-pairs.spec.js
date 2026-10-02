import { describe, it, expect } from 'vitest';
import { collectTransferPairs } from '../scripts/backfill-transfer-credits.mjs';

const ANON = '$RCAnonymousID:abc123';
const USER_A = 'F2034C74-782E-4D8F-AAD3-E1FEBC3B5794';
const USER_B = '89A5DB3A-8B19-4CB5-A17A-6F4AF334693D';

const row = (event) => ({ raw_data: { event } });

describe('collectTransferPairs', () => {
	it('pairs every transferred_from ID with the target', () => {
		const pairs = collectTransferPairs([
			row({ id: 'e1', event_timestamp_ms: 1, transferred_from: [ANON, USER_A], transferred_to: [USER_B] })
		]);

		expect(pairs.map((pair) => [pair.fromUserId, pair.toUserId])).toEqual([
			[ANON, USER_B],
			[USER_A, USER_B]
		]);
	});

	it('keeps the latest target when a source was transferred more than once', () => {
		const pairs = collectTransferPairs([
			row({ id: 'late', event_timestamp_ms: 20, transferred_from: [ANON], transferred_to: [USER_B] }),
			row({ id: 'early', event_timestamp_ms: 10, transferred_from: [ANON], transferred_to: [USER_A] })
		]);

		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({ eventId: 'late', toUserId: USER_B });
	});

	it('skips self-transfers and malformed rows', () => {
		const pairs = collectTransferPairs([
			row({ id: 'self', transferred_from: [USER_A.toLowerCase()], transferred_to: [USER_A] }),
			row({ id: 'no-target', transferred_from: [ANON], transferred_to: [] }),
			row({ id: 'no-arrays' }),
			{ raw_data: null }
		]);

		expect(pairs).toEqual([]);
	});
});
