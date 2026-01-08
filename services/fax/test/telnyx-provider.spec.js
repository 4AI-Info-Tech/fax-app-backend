import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelnyxProvider } from '../src/providers/telnyx-provider.js';

// Mock DatabaseUtils
vi.mock('../src/database.js', () => ({
	DatabaseUtils: {
		saveFaxRecord: vi.fn().mockResolvedValue({ id: 'saved-fax-123' }),
		updateFaxRecord: vi.fn().mockResolvedValue({ id: 'updated-fax-123' })
	}
}));

// Mock global fetch
global.fetch = vi.fn();

import { DatabaseUtils } from '../src/database.js';

describe('TelnyxProvider', () => {
	let telnyxProvider;
	let mockLogger;
	let mockR2Utils;
	let mockEnv;

	beforeEach(() => {
		// Mock logger
		mockLogger = {
			log: vi.fn()
		};

		// Mock R2Utils
		mockR2Utils = {
			uploadFile: vi.fn().mockResolvedValue('https://files.example.com/fax/test-fax/document_1_123456.pdf'),
			validateConfiguration: vi.fn().mockReturnValue(true)
		};

		// Mock environment
		mockEnv = {
			SUPABASE_URL: 'https://test.supabase.co',
			SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
		};

		// Mock fetch for Telnyx API
		global.fetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({
				data: {
					id: 'telnyx-fax-123',
					status: 'queued',
					to: '+1234567890',
					from: '+1987654321'
				}
			})
		});

		telnyxProvider = new TelnyxProvider('test-api-key', mockLogger, {
			connectionId: 'test-connection-id',
			r2Utils: mockR2Utils,
			env: mockEnv
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('constructor', () => {
		it('should initialize with correct properties', () => {
			expect(telnyxProvider.apiKey).toBe('test-api-key');
			expect(telnyxProvider.logger).toBe(mockLogger);
			expect(telnyxProvider.baseUrl).toBe('https://api.telnyx.com');
			expect(telnyxProvider.connectionId).toBe('test-connection-id');
			expect(telnyxProvider.r2Utils).toBe(mockR2Utils);
			expect(telnyxProvider.env).toBe(mockEnv);
		});
	});

	describe('getProviderName', () => {
		it('should return "telnyx"', () => {
			expect(telnyxProvider.getProviderName()).toBe('telnyx');
		});
	});

	describe('buildPayload', () => {
		it('should build valid Telnyx payload', async () => {
			const faxRequest = {
				recipients: ['+1234567890'],
				senderId: '+1987654321',
				message: 'Test message'
			};

			const payload = await telnyxProvider.buildPayload(faxRequest);

			expect(payload).toEqual({
				connection_id: 'test-connection-id',
				to: '+1234567890',
				from: '+1987654321'
			});

			expect(mockLogger.log).toHaveBeenCalledWith('DEBUG', 'Building Telnyx API payload structure');
		});

		it('should throw error when connection_id is missing', async () => {
			telnyxProvider.connectionId = null;

			const faxRequest = {
				recipients: ['+1234567890']
			};

			await expect(telnyxProvider.buildPayload(faxRequest))
				.rejects.toThrow('Telnyx connection_id is required');
		});

		it('should throw error when no recipients provided', async () => {
			const faxRequest = {
				recipients: []
			};

			await expect(telnyxProvider.buildPayload(faxRequest))
				.rejects.toThrow('At least one recipient is required for Telnyx');
		});

		it('should use first recipient when multiple provided', async () => {
			const faxRequest = {
				recipients: ['+1234567890', '+1555666777'],
				senderId: '+1987654321'
			};

			const payload = await telnyxProvider.buildPayload(faxRequest);

			expect(payload.to).toBe('+1234567890');
			expect(mockLogger.log).toHaveBeenCalledWith('DEBUG', 'Using first recipient for Telnyx', {
				recipient: '+***'
			});
		});
	});

	describe('sendFaxWithCustomWorkflow', () => {
		it('should execute complete workflow successfully', async () => {
			const faxRequest = {
				recipients: ['+1234567890'],
				senderId: '+1987654321',
				files: [
					{ data: 'base64data', filename: 'test.pdf' }
				],
				message: 'Test fax'
			};
			const userId = 'user-123';

			const result = await telnyxProvider.sendFaxWithCustomWorkflow(faxRequest, userId);

			// Verify all workflow steps
			expect(DatabaseUtils.saveFaxRecord).toHaveBeenCalledWith(
				expect.objectContaining({
					user_id: userId,
					recipients: ['+1234567890'],
					sender_id: '+1987654321',
					subject: 'Test fax',
					status: 'queued',
					original_status: 'preparing'
				}),
				userId,
				mockEnv,
				mockLogger
			);

			expect(mockR2Utils.uploadFile).toHaveBeenCalled();

			expect(DatabaseUtils.updateFaxRecord).toHaveBeenCalledTimes(2); // R2 URLs + Telnyx response

			expect(global.fetch).toHaveBeenCalledWith(
				'https://api.telnyx.com/v2/faxes',
				expect.objectContaining({
					method: 'POST',
					headers: {
						'Authorization': 'Bearer test-api-key',
						'Content-Type': 'application/json'
					}
				})
			);

			expect(result).toEqual({
				id: 'telnyx-fax-123',
				status: 'sending',
				originalStatus: 'queued',
				message: 'Fax submitted to Telnyx successfully',
				timestamp: expect.any(String),
				friendlyId: 'telnyx-fax-123',
				providerResponse: expect.any(Object)
			});
		});

		it('should handle workflow failure gracefully', async () => {
			// Reset the mock to reject for this test
			DatabaseUtils.saveFaxRecord.mockRejectedValueOnce(new Error('Database error'));

			const faxRequest = {
				recipients: ['+1234567890'],
				files: [{ data: 'base64data' }]
			};

			await expect(telnyxProvider.sendFaxWithCustomWorkflow(faxRequest, 'user-123'))
				.rejects.toThrow('Database error');

			expect(mockLogger.log).toHaveBeenCalledWith('ERROR', 'Telnyx custom workflow failed', {
				error: 'Database error',
				stack: expect.any(String)
			});
		});
	});

	describe('createInitialFaxRecord', () => {
		it('should create initial fax record with correct data', async () => {
			const faxRequest = {
				recipients: ['+1234567890'],
				senderId: '+1987654321',
				subject: 'Test Subject',
				message: 'Test message',
				files: [{ data: 'test' }, { data: 'test2' }]
			};
			const userId = 'user-123';

			await telnyxProvider.createInitialFaxRecord(faxRequest, userId);

			expect(DatabaseUtils.saveFaxRecord).toHaveBeenCalledWith(
				expect.objectContaining({
					user_id: userId,
					recipients: ['+1234567890'],
					sender_id: '+1987654321',
					subject: 'Test Subject',
					status: 'queued',
					original_status: 'preparing',
					created_at: expect.any(String)
				}),
				userId,
				mockEnv,
				mockLogger
			);
		});

		it('should use message as subject when no subject provided', async () => {
			const faxRequest = {
				recipients: ['+1234567890'],
				message: 'Test message'
			};

			await telnyxProvider.createInitialFaxRecord(faxRequest, 'user-123');

			expect(DatabaseUtils.saveFaxRecord).toHaveBeenCalledWith(
				expect.objectContaining({
					subject: 'Test message'
				}),
				'user-123',
				mockEnv,
				mockLogger
			);
		});

		it('should use default subject when neither subject nor message provided', async () => {
			const faxRequest = {
				recipients: ['+1234567890']
			};

			await telnyxProvider.createInitialFaxRecord(faxRequest, 'user-123');

			expect(DatabaseUtils.saveFaxRecord).toHaveBeenCalledWith(
				expect.objectContaining({
					subject: 'Fax Document'
				}),
				'user-123',
				mockEnv,
				mockLogger
			);
		});
	});

	describe('uploadFilesToR2', () => {
		it('should upload all files and return URLs', async () => {
			const files = [
				{ data: 'base64data1', filename: 'file1.pdf' },
				{ data: 'base64data2', filename: 'file2.pdf' }
			];
			const faxId = 'test-fax-123';

			mockR2Utils.uploadFile
				.mockResolvedValueOnce('https://files.example.com/fax/test-fax-123/document_1_123456.pdf')
				.mockResolvedValueOnce('https://files.example.com/fax/test-fax-123/document_2_123457.pdf');

			const result = await telnyxProvider.uploadFilesToR2(files, faxId);

			expect(result).toHaveLength(2);
			expect(result[0]).toContain('document_1_');
			expect(result[1]).toContain('document_2_');

			expect(mockR2Utils.uploadFile).toHaveBeenCalledTimes(2);
		});

		it('should handle Blob files', async () => {
			const mockBlob = {
				arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4))
			};
			const files = [mockBlob];
			const faxId = 'test-fax-123';

			await telnyxProvider.uploadFilesToR2(files, faxId);

			expect(mockBlob.arrayBuffer).toHaveBeenCalled();
			expect(mockR2Utils.uploadFile).toHaveBeenCalledWith(
				expect.stringContaining('fax/test-fax-123/document_1_'),
				expect.any(ArrayBuffer),
				'application/pdf'
			);
		});

		it('should handle base64 encoded files', async () => {
			const files = [{ data: 'dGVzdA==' }]; // base64 for "test"
			const faxId = 'test-fax-123';

			await telnyxProvider.uploadFilesToR2(files, faxId);

			expect(mockR2Utils.uploadFile).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Uint8Array),
				'application/pdf'
			);
		});

		it('should throw error when R2Utils not configured', async () => {
			telnyxProvider.r2Utils = null;

			await expect(telnyxProvider.uploadFilesToR2([{ data: 'test' }], 'fax-123'))
				.rejects.toThrow('R2 utilities not configured');
		});

		it('should throw error when no files provided', async () => {
			await expect(telnyxProvider.uploadFilesToR2([], 'fax-123'))
				.rejects.toThrow('No files to upload');

			await expect(telnyxProvider.uploadFilesToR2(null, 'fax-123'))
				.rejects.toThrow('No files to upload');
		});

		it('should handle upload failures', async () => {
			mockR2Utils.uploadFile.mockRejectedValue(new Error('Upload failed'));

			const files = [{ data: 'test' }];

			await expect(telnyxProvider.uploadFilesToR2(files, 'fax-123'))
				.rejects.toThrow('Upload failed');

			expect(mockLogger.log).toHaveBeenCalledWith('ERROR', 'Failed to upload file 1 to R2', {
				error: 'Upload failed',
				fileIndex: 0
			});
		});

		it('should handle unsupported file formats', async () => {
			const files = [{ unsupported: 'format' }];

			await expect(telnyxProvider.uploadFilesToR2(files, 'fax-123'))
				.rejects.toThrow('Unsupported file format for file 1');
		});
	});

	describe('updateFaxRecordWithR2Urls', () => {
		it('should update fax record with R2 URLs', async () => {
			const faxId = 'test-fax-123';
			const mediaUrls = ['https://example.com/file1.pdf', 'https://example.com/file2.pdf'];

			await telnyxProvider.updateFaxRecordWithR2Urls(faxId, mediaUrls);

			expect(DatabaseUtils.updateFaxRecord).toHaveBeenCalledWith(
				faxId,
				{
					r2_urls: mediaUrls,
					status: 'processing'
				},
				mockEnv,
				mockLogger,
				'id'
			);
		});
	});

	describe('sendToTelnyx', () => {
		it('should send fax to Telnyx API successfully', async () => {
			const faxRequest = {
				recipients: ['+1234567890'],
				senderId: '+1987654321'
			};
			const mediaUrl = 'https://files.example.com/fax/test/document.pdf';

			const result = await telnyxProvider.sendToTelnyx(faxRequest, mediaUrl);

			expect(global.fetch).toHaveBeenCalledWith(
				'https://api.telnyx.com/v2/faxes',
				{
					method: 'POST',
					headers: {
						'Authorization': 'Bearer test-api-key',
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						connection_id: 'test-connection-id',
						to: '+1234567890',
						from: '+1987654321',
						media_url: mediaUrl
					})
				}
			);

			expect(result).toEqual({
				id: 'telnyx-fax-123',
				status: 'queued',
				to: '+1234567890',
				from: '+1987654321'
			});
		});

		it('should handle Telnyx API errors', async () => {
			global.fetch.mockResolvedValue({
				ok: false,
				status: 400,
				statusText: 'Bad Request',
				text: () => Promise.resolve('Invalid request')
			});

			const faxRequest = { recipients: ['+1234567890'] };
			const mediaUrl = 'https://example.com/file.pdf';

			await expect(telnyxProvider.sendToTelnyx(faxRequest, mediaUrl))
				.rejects.toThrow('Telnyx API error: 400 Bad Request - Invalid request');

			expect(mockLogger.log).toHaveBeenCalledWith('ERROR', 'Telnyx API request failed', {
				status: 400,
				statusText: 'Bad Request',
				error: 'Invalid request'
			});
		});
	});

	describe('updateFaxRecordWithTelnyxResponse', () => {
		it('should update fax record with Telnyx response', async () => {
			const faxId = 'test-fax-123';
			const telnyxResponse = {
				id: 'telnyx-fax-456',
				status: 'queued',
				extra: 'data'
			};

			await telnyxProvider.updateFaxRecordWithTelnyxResponse(faxId, telnyxResponse);

			expect(DatabaseUtils.updateFaxRecord).toHaveBeenCalledWith(
				faxId,
				{
					provider_fax_id: 'telnyx-fax-456',
					metadata: telnyxResponse,
					status: 'sending',
					sent_at: expect.any(String),
					updated_at: expect.any(String)
				},
				mockEnv,
				mockLogger,
				'id'
			);
		});
	});

	describe('sendFax', () => {
		it('should throw error indicating to use custom workflow', async () => {
			await expect(telnyxProvider.sendFax({}))
				.rejects.toThrow('Use sendFaxWithCustomWorkflow method for Telnyx provider');
		});
	});

	describe('mapStatus', () => {
		it('should map Telnyx statuses to standard statuses', () => {
			expect(telnyxProvider.mapStatus('queued')).toBe('sending');
			expect(telnyxProvider.mapStatus('sending')).toBe('sending');
			expect(telnyxProvider.mapStatus('media.processed')).toBe('sending');
			expect(telnyxProvider.mapStatus('delivered')).toBe('delivered');
			expect(telnyxProvider.mapStatus('failed')).toBe('failed');
			expect(telnyxProvider.mapStatus('canceled')).toBe('failed');
			expect(telnyxProvider.mapStatus('unknown')).toBe('failed');
		});
	});

	describe('mapTelnyxResponse', () => {
		it('should map Telnyx response to standard format', () => {
			const telnyxResponse = {
				id: 'telnyx-fax-123',
				status: 'queued',
				extra: 'data'
			};

			const result = telnyxProvider.mapTelnyxResponse(telnyxResponse);

			expect(result).toEqual({
				id: 'telnyx-fax-123',
				status: 'sending',
				originalStatus: 'queued',
				message: 'Fax submitted to Telnyx successfully',
				timestamp: expect.any(String),
				friendlyId: 'telnyx-fax-123',
				providerResponse: telnyxResponse
			});
		});
	});

	describe('generateFaxId', () => {
		it('should generate unique fax ID with correct format', () => {
			const faxId1 = telnyxProvider.generateFaxId();
			const faxId2 = telnyxProvider.generateFaxId();

			expect(faxId1).toMatch(/^telnyx_\d+_[a-z0-9]+$/);
			expect(faxId2).toMatch(/^telnyx_\d+_[a-z0-9]+$/);
			expect(faxId1).not.toBe(faxId2);
		});
	});

	describe('validateConfig', () => {
		it('should return true when properly configured', () => {
			const result = telnyxProvider.validateConfig();

			expect(result).toBe(true);
		});

		it('should return false and log when API key missing', () => {
			telnyxProvider.apiKey = null;

			const result = telnyxProvider.validateConfig();

			expect(result).toBe(false);
			expect(mockLogger.log).toHaveBeenCalledWith('ERROR', 'Telnyx API key is missing');
		});

		it('should return false and log when connection ID missing', () => {
			telnyxProvider.connectionId = null;

			const result = telnyxProvider.validateConfig();

			expect(result).toBe(false);
			expect(mockLogger.log).toHaveBeenCalledWith('ERROR', 'Telnyx connection_id is missing');
		});

		it('should return false and log when R2Utils missing', () => {
			telnyxProvider.r2Utils = null;

			const result = telnyxProvider.validateConfig();

			expect(result).toBe(false);
			expect(mockLogger.log).toHaveBeenCalledWith('ERROR', 'R2 utilities are missing');
		});

		it('should return false when R2Utils validation fails', () => {
			mockR2Utils.validateConfiguration.mockReturnValue(false);

			const result = telnyxProvider.validateConfig();

			expect(result).toBe(false);
		});
	});
});
