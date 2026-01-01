/**
 * Property-Based Test: Usage Record Completeness
 * 
 * **Property 13: Usage Record Completeness**
 * *For any* usage record created after a fax send, the record SHALL include 
 * user_id, type="fax", unit_type="page", usage_amount (page count), timestamp, 
 * and fax_id in metadata.
 * 
 * **Validates: Requirements 7.1, 13.4**
 * **Feature: ios-backend-integration, Property 13: Usage Record Completeness**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Mock Supabase client
let capturedUsageRecord = null;

const mockSupabaseClient = {
	from: vi.fn((tableName) => {
		if (tableName === 'usage') {
			return {
				insert: vi.fn((record) => {
					capturedUsageRecord = record;
					return {
						select: vi.fn(() => ({
							single: vi.fn(() => Promise.resolve({
								data: { id: 'usage-id', ...record },
								error: null
							}))
						}))
					};
				})
			};
		}
		return {
			select: vi.fn(() => ({ eq: vi.fn() })),
			insert: vi.fn(() => ({ select: vi.fn() })),
			update: vi.fn(() => ({ eq: vi.fn() }))
		};
	})
};

vi.mock('@supabase/supabase-js', () => ({
	createClient: vi.fn(() => mockSupabaseClient)
}));

import { DatabaseUtils } from '../src/database.js';

describe('Property 13: Usage Record Completeness', () => {
	let mockEnv;
	let mockLogger;

	beforeEach(() => {
		mockEnv = {
			SUPABASE_URL: 'https://test.supabase.co',
			SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
		};
		
		mockLogger = {
			log: vi.fn()
		};

		capturedUsageRecord = null;
		vi.clearAllMocks();
	});

	/**
	 * Property Test: For any valid usage data input, the recorded usage SHALL contain
	 * all required fields: user_id, type="fax", unit_type="page", usage_amount, 
	 * timestamp, and fax_id in metadata.
	 */
	it('should always include all required fields in usage records (100 iterations)', async () => {
		// Arbitrary generators for usage data
		const userIdArb = fc.uuid();
		const faxIdArb = fc.uuid();
		const pageCountArb = fc.integer({ min: 1, max: 100 });
		const providerArb = fc.constantFrom('telnyx', 'notifyre');
		const eventTypeArb = fc.constantFrom('fax.delivered', 'fax.sent', 'fax.completed');
		const statusArb = fc.constantFrom('delivered', 'sent', 'completed');

		await fc.assert(
			fc.asyncProperty(
				userIdArb,
				faxIdArb,
				pageCountArb,
				providerArb,
				eventTypeArb,
				statusArb,
				async (userId, faxId, pageCount, provider, eventType, status) => {
					// Arrange: Create usage data as it would be created in webhook handlers
					const usageData = {
						userId: userId,
						type: 'fax',
						unitType: 'page',
						usageAmount: pageCount,
						timestamp: new Date().toISOString(),
						metadata: {
							fax_id: faxId,
							provider: provider,
							event_type: eventType,
							status: status
						}
					};

					// Act: Record the usage
					await DatabaseUtils.recordUsage(usageData, mockEnv, mockLogger);

					// Assert: Verify all required fields are present
					expect(capturedUsageRecord).not.toBeNull();
					
					// Property 1: user_id must be present and match input
					expect(capturedUsageRecord.user_id).toBe(userId);
					
					// Property 2: type must be "fax"
					expect(capturedUsageRecord.type).toBe('fax');
					
					// Property 3: unit_type must be "page"
					expect(capturedUsageRecord.unit_type).toBe('page');
					
					// Property 4: usage_amount must be present and be a positive integer
					expect(capturedUsageRecord.usage_amount).toBe(pageCount);
					expect(capturedUsageRecord.usage_amount).toBeGreaterThan(0);
					
					// Property 5: timestamp must be present and be a valid ISO string
					expect(capturedUsageRecord.timestamp).toBeDefined();
					expect(new Date(capturedUsageRecord.timestamp).toISOString()).toBe(capturedUsageRecord.timestamp);
					
					// Property 6: metadata must contain fax_id
					expect(capturedUsageRecord.metadata).toBeDefined();
					expect(capturedUsageRecord.metadata.fax_id).toBe(faxId);
				}
			),
			{ numRuns: 100 }
		);
	});

	/**
	 * Property Test: Usage amount must always be a positive integer representing page count
	 */
	it('should always have positive usage_amount for page counts (100 iterations)', async () => {
		const pageCountArb = fc.integer({ min: 1, max: 1000 });

		await fc.assert(
			fc.asyncProperty(pageCountArb, async (pageCount) => {
				const usageData = {
					userId: 'test-user-id',
					type: 'fax',
					unitType: 'page',
					usageAmount: pageCount,
					timestamp: new Date().toISOString(),
					metadata: { fax_id: 'test-fax-id' }
				};

				await DatabaseUtils.recordUsage(usageData, mockEnv, mockLogger);

				expect(capturedUsageRecord.usage_amount).toBeGreaterThan(0);
				expect(Number.isInteger(capturedUsageRecord.usage_amount)).toBe(true);
			}),
			{ numRuns: 100 }
		);
	});

	/**
	 * Property Test: Metadata must always contain fax_id for traceability
	 */
	it('should always include fax_id in metadata for traceability (100 iterations)', async () => {
		const faxIdArb = fc.oneof(
			fc.uuid(),
			fc.stringMatching(/^[a-f0-9]{8,36}$/),
			fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0)
		);

		await fc.assert(
			fc.asyncProperty(faxIdArb, async (faxId) => {
				const usageData = {
					userId: 'test-user-id',
					type: 'fax',
					unitType: 'page',
					usageAmount: 1,
					timestamp: new Date().toISOString(),
					metadata: { fax_id: faxId }
				};

				await DatabaseUtils.recordUsage(usageData, mockEnv, mockLogger);

				expect(capturedUsageRecord.metadata).toBeDefined();
				expect(capturedUsageRecord.metadata.fax_id).toBe(faxId);
				expect(capturedUsageRecord.metadata.fax_id).toBeTruthy();
			}),
			{ numRuns: 100 }
		);
	});
});
