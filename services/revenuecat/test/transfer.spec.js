import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseUtils } from '../src/database.js';

// Mock Supabase client with proper chaining
const createMockSupabase = () => {
	const mockSupabase = {
		from: vi.fn(() => mockSupabase),
		select: vi.fn(() => mockSupabase),
		update: vi.fn(() => mockSupabase),
		eq: vi.fn(() => mockSupabase),
		insert: vi.fn(() => mockSupabase),
		rpc: vi.fn(),
		auth: {
			admin: {
				getUserById: vi.fn(),
				deleteUser: vi.fn()
			}
		}
	};
	return mockSupabase;
};

// Mock environment
const mockEnv = {
	SUPABASE_URL: 'https://test.supabase.co',
	SUPABASE_SERVICE_ROLE_KEY: 'test-key'
};

// Mock logger
const mockLogger = {
	log: vi.fn()
};

describe('DatabaseUtils.transferUserData', () => {
	let mockSupabase;

	beforeEach(() => {
		vi.clearAllMocks();
		mockSupabase = createMockSupabase();
		
		// Mock the getSupabaseAdminClient method
		vi.spyOn(DatabaseUtils, 'getSupabaseAdminClient').mockReturnValue(mockSupabase);
		
		// Mock the audit methods to avoid database dependency in tests
		vi.spyOn(DatabaseUtils, 'createTransferAuditRecord').mockResolvedValue('transfer-123');
		vi.spyOn(DatabaseUtils, 'updateTransferAuditRecord').mockResolvedValue();
		vi.spyOn(DatabaseUtils, 'moveRowsByUserId').mockResolvedValue(0);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('should handle basic transfer scenarios', async () => {
		const fromUserId = 'user-1';
		const toUserId = 'user-2';

		// Mock user validation
		mockSupabase.auth.admin.getUserById
			.mockResolvedValueOnce({ data: { user: { id: fromUserId, app_metadata: { is_anonymous: false } } }, error: null })
			.mockResolvedValueOnce({ data: { user: { id: toUserId, app_metadata: { is_anonymous: false } } }, error: null });

		const result = await DatabaseUtils.transferUserData(fromUserId, toUserId, mockEnv, mockLogger);

		expect(result.success).toBe(true);
		expect(result.transferredSubscriptions).toBe(0);
		expect(result.transferredUsage).toBe(0);
		expect(result.transferredFaxes).toBe(0);
		expect(result.oldUserDeleted).toBe(false);
		expect(result.fromUserId).toBe(fromUserId);
		expect(result.toUserId).toBe(toUserId);
		expect(result.transferId).toBe('transfer-123');
	});

	it('should delete anonymous user after transfer', async () => {
		const fromUserId = 'user-1';
		const toUserId = 'user-2';

		// Mock user validation (first two calls for validation, third for deletion check)
		mockSupabase.auth.admin.getUserById
			.mockResolvedValueOnce({ data: { user: { id: fromUserId, app_metadata: { is_anonymous: false } } }, error: null })
			.mockResolvedValueOnce({ data: { user: { id: toUserId, app_metadata: { is_anonymous: false } } }, error: null })
			.mockResolvedValueOnce({ data: { user: { id: fromUserId, app_metadata: { is_anonymous: true } } }, error: null });

		// Mock user deletion
		mockSupabase.auth.admin.deleteUser.mockResolvedValue({ error: null });

		const result = await DatabaseUtils.transferUserData(fromUserId, toUserId, mockEnv, mockLogger);

		expect(result.success).toBe(true);
		expect(result.oldUserDeleted).toBe(true);
		expect(mockSupabase.auth.admin.deleteUser).toHaveBeenCalledWith(fromUserId);
	});

	it('should handle missing user IDs', async () => {
		const result = await DatabaseUtils.transferUserData(null, 'user-2', mockEnv, mockLogger);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Missing user IDs');
	});

	it('should handle same user transfer', async () => {
		const userId = 'user-1';
		const result = await DatabaseUtils.transferUserData(userId, userId, mockEnv, mockLogger);

		expect(result.success).toBe(true);
		expect(result.message).toBe('No transfer needed');
	});

	it('should handle validation failures', async () => {
		const fromUserId = 'user-1';
		const toUserId = 'user-2';

		// Mock user validation failure
		mockSupabase.auth.admin.getUserById.mockResolvedValue({ data: null, error: { message: 'User not found' } });

		const result = await DatabaseUtils.transferUserData(fromUserId, toUserId, mockEnv, mockLogger);

		expect(result.success).toBe(false);
		expect(result.error).toContain('does not exist');
	});

	it('should handle transfer failures', async () => {
		const fromUserId = 'user-1';
		const toUserId = 'user-2';

		// Mock user validation
		mockSupabase.auth.admin.getUserById
			.mockResolvedValueOnce({ data: { user: { id: fromUserId, app_metadata: { is_anonymous: false } } }, error: null })
			.mockResolvedValueOnce({ data: { user: { id: toUserId, app_metadata: { is_anonymous: false } } }, error: null });

		DatabaseUtils.moveRowsByUserId.mockRejectedValueOnce(new Error('Database error'));

		const result = await DatabaseUtils.transferUserData(fromUserId, toUserId, mockEnv, mockLogger);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Database error');
	});

	it('should handle missing Supabase configuration', async () => {
		const fromUserId = 'user-1';
		const toUserId = 'user-2';
		const envWithoutSupabase = {};

		const result = await DatabaseUtils.transferUserData(fromUserId, toUserId, envWithoutSupabase, mockLogger);

		expect(result.success).toBe(false);
		expect(result.error).toBe('Supabase not configured');
	});
});

describe('DatabaseUtils.validateUsersForTransfer', () => {
	let mockSupabase;

	beforeEach(() => {
		vi.clearAllMocks();
		mockSupabase = createMockSupabase();
		vi.spyOn(DatabaseUtils, 'getSupabaseAdminClient').mockReturnValue(mockSupabase);
	});

	it('should validate users successfully', async () => {
		const fromUserId = 'user-1';
		const toUserId = 'user-2';

		mockSupabase.auth.admin.getUserById
			.mockResolvedValueOnce({ data: { user: { id: fromUserId } }, error: null })
			.mockResolvedValueOnce({ data: { user: { id: toUserId, app_metadata: { is_anonymous: false } } }, error: null });

		const result = await DatabaseUtils.validateUsersForTransfer(fromUserId, toUserId, mockEnv, mockLogger);

		expect(result.valid).toBe(true);
	});

	it('should reject transfer to anonymous user', async () => {
		const fromUserId = 'user-1';
		const toUserId = 'user-2';

		mockSupabase.auth.admin.getUserById
			.mockResolvedValueOnce({ data: { user: { id: fromUserId } }, error: null })
			.mockResolvedValueOnce({ data: { user: { id: toUserId, app_metadata: { is_anonymous: true } } }, error: null });

		const result = await DatabaseUtils.validateUsersForTransfer(fromUserId, toUserId, mockEnv, mockLogger);

		expect(result.valid).toBe(false);
		expect(result.error).toContain('Cannot transfer to anonymous user');
	});

	it('should handle missing source user', async () => {
		const fromUserId = 'user-1';
		const toUserId = 'user-2';

		mockSupabase.auth.admin.getUserById.mockResolvedValue({ data: null, error: { message: 'User not found' } });

		const result = await DatabaseUtils.validateUsersForTransfer(fromUserId, toUserId, mockEnv, mockLogger);

		expect(result.valid).toBe(false);
		expect(result.error).toContain('does not exist');
	});
});

// Audit record tests are not needed since we mock the methods at the method level 
