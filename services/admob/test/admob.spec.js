import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAdMobCallback } from '../src/verifier.js';

describe('AdMob SSV Service', () => {
	describe('parseAdMobCallback', () => {
		it('should parse all SSV callback parameters', () => {
			const url = '/v1/admob/ssv?ad_network=5450213213286189855&ad_unit=ca-app-pub-1234567890123456/1234567890&custom_data=user123&key_id=1234567890&reward_amount=1&reward_item=pages&signature=MEUCIQD&timestamp=1507770365237823&transaction_id=abc123def456&user_id=user-uuid-123';
			
			const params = parseAdMobCallback(url);
			
			expect(params.adNetwork).toBe('5450213213286189855');
			expect(params.adUnit).toBe('ca-app-pub-1234567890123456/1234567890');
			expect(params.customData).toBe('user123');
			expect(params.keyId).toBe('1234567890');
			expect(params.rewardAmount).toBe(1);
			expect(params.rewardItem).toBe('pages');
			expect(params.signature).toBe('MEUCIQD');
			expect(params.timestamp).toBe('1507770365237823');
			expect(params.transactionId).toBe('abc123def456');
			expect(params.userId).toBe('user-uuid-123');
		});

		it('should handle missing optional parameters', () => {
			const url = '/v1/admob/ssv?ad_network=123&ad_unit=456&key_id=789&reward_amount=1&reward_item=pages&signature=sig&timestamp=123&transaction_id=txn123&user_id=user123';
			
			const params = parseAdMobCallback(url);
			
			expect(params.customData).toBeNull();
			expect(params.transactionId).toBe('txn123');
			expect(params.userId).toBe('user123');
		});

		it('should default reward_amount to 0 if not provided', () => {
			const url = '/v1/admob/ssv?ad_network=123&ad_unit=456&key_id=789&reward_item=pages&signature=sig&timestamp=123&transaction_id=txn123&user_id=user123';
			
			const params = parseAdMobCallback(url);
			
			expect(params.rewardAmount).toBe(0);
		});
	});
});
