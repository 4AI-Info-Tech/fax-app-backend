import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseUtils } from '../src/database.js';

const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' };
const USER = 'F2034C74-782E-4D8F-AAD3-E1FEBC3B5794';

function createSupabase({ user = null, userError = null, transfers = [], transferError = null } = {}) {
	const query = {
		select: vi.fn(() => query),
		eq: vi.fn(() => query),
		limit: vi.fn(async () => ({ data: transfers, error: transferError }))
	};
	return {
		query,
		from: vi.fn(() => query),
		auth: {
			admin: {
				getUserById: vi.fn(async () => ({ data: { user }, error: userError }))
			}
		}
	};
}

describe('DatabaseUtils.isAnonymousTransferSource', () => {
	const logger = { log: vi.fn() };
	let supabase;

	const useSupabase = (options) => {
		supabase = createSupabase(options);
		vi.spyOn(DatabaseUtils, 'getSupabaseAdminClient').mockReturnValue(supabase);
	};

	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.restoreAllMocks());

	it('treats RevenueCat anonymous IDs as anonymous without a lookup', async () => {
		useSupabase();
		await expect(DatabaseUtils.isAnonymousTransferSource('$RCAnonymousID:abc123', env, logger)).resolves.toBe(true);
		expect(supabase.auth.admin.getUserById).not.toHaveBeenCalled();
	});

	it('treats anonymous Supabase users as anonymous', async () => {
		useSupabase({ user: { id: USER, app_metadata: { is_anonymous: true } } });
		await expect(DatabaseUtils.isAnonymousTransferSource(USER, env, logger)).resolves.toBe(true);
		expect(supabase.auth.admin.getUserById).toHaveBeenCalledWith(USER.toLowerCase());
	});

	it('rejects signed-in Supabase users', async () => {
		useSupabase({ user: { id: USER, app_metadata: { provider: 'apple' }, is_anonymous: false } });
		await expect(DatabaseUtils.isAnonymousTransferSource(USER, env, logger)).resolves.toBe(false);
	});

	it('rejects a source user that no longer exists', async () => {
		useSupabase({ userError: { status: 404, message: 'User not found' } });
		await expect(DatabaseUtils.isAnonymousTransferSource(USER, env, logger)).resolves.toBe(false);
		expect(supabase.from).not.toHaveBeenCalled();
	});

	it('throws on lookup failures so the webhook is retried', async () => {
		useSupabase({ userError: { status: 500, message: 'boom' } });
		await expect(DatabaseUtils.isAnonymousTransferSource(USER, env, logger)).rejects.toThrow(/Failed to look up/);
	});

	it('rejects non-UUID custom IDs', async () => {
		useSupabase();
		await expect(DatabaseUtils.isAnonymousTransferSource('custom-user', env, logger)).resolves.toBe(false);
	});
});
