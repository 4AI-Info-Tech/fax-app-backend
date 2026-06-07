import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';

// Mock Supabase client to avoid ES module issues in tests
vi.mock('@supabase/supabase-js', () => ({
	createClient: vi.fn(() => ({
		from: vi.fn(() => ({
			select: vi.fn(() => ({ eq: vi.fn() })),
			insert: vi.fn(() => ({ select: vi.fn() })),
			update: vi.fn(() => ({ eq: vi.fn() }))
		}))
	}))
}));

// Mock DatabaseUtils and FaxDatabaseUtils
vi.mock('../src/database.js', () => ({
	DatabaseUtils: {
		getSupabaseAdminClient: vi.fn(() => ({
			from: vi.fn(() => ({
				select: vi.fn(() => ({ eq: vi.fn() })),
				insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(() => ({ data: { id: 'test-id' }, error: null })) })) })),
				update: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(() => ({ data: { id: 'test-id' }, error: null })) })) })) }))
			}))
		})),
		saveFaxRecord: vi.fn().mockResolvedValue({ id: 'saved-fax-123', notifyre_fax_id: 'fax_mock_123' }),
		getFaxRecord: vi.fn().mockResolvedValue({ id: 'updated-fax-123', status: 'queued', user_id: 'test-user-123' }),
		updateFaxRecord: vi.fn().mockResolvedValue({ id: 'updated-fax-123' }),
		recordUsage: vi.fn().mockResolvedValue({ success: true }),
		
		storeWebhookEvent: vi.fn().mockResolvedValue(true)
	},
	FaxDatabaseUtils: {
		checkUserCredits: vi.fn().mockResolvedValue({
			hasCredits: true,
			availablePages: 100,
			subscriptionId: 'test-subscription-id',
			subscriptions: [],
			error: null
		}),
		updatePageUsage: vi.fn().mockResolvedValue({
			success: true,
			updatedSubscription: { pages_used: 5 }
		}),
		getUserFaxUsage: vi.fn().mockResolvedValue({
			success: true,
			totalPages: 10,
			faxCount: 5,
			faxes: []
		})
	}
}));

// Mock WorkerEntrypoint to avoid module issues
vi.mock('cloudflare:workers', () => ({
	WorkerEntrypoint: class MockWorkerEntrypoint {
		constructor() {
			this.env = {};
		}
	}
}));

// Mock R2Utils with the updated single-parameter constructor (logger only)
vi.mock('../src/r2-utils.js', () => ({
	R2Utils: vi.fn().mockImplementation((logger) => ({
		logger,
		validateConfiguration: vi.fn().mockReturnValue(true),
		uploadFile: vi.fn().mockResolvedValue('https://test.r2.url/file.pdf')
	}))
}));

const mockConvertToPdf = vi.fn();

vi.mock('../src/conversion-client.js', () => ({
	ConversionClientError: class ConversionClientError extends Error {
		constructor(code, message) {
			super(message);
			this.code = code;
		}
	},
	ConversionClient: vi.fn().mockImplementation(() => ({
		convertToPdf: mockConvertToPdf
	}))
}));

// Mock TelnyxProvider
vi.mock('../src/providers/telnyx-provider.js', () => ({
	TelnyxProvider: vi.fn().mockImplementation((apiKey, logger, options) => ({
		apiKey,
		logger,
		options,
		getProviderName: () => 'telnyx',
		prepareFaxRequest: vi.fn().mockImplementation(async (requestBody) => {
			if (requestBody && typeof requestBody === 'object' && requestBody !== null) {
				return {
					recipients: requestBody.recipients || (requestBody.recipient ? [requestBody.recipient] : ['+1234567890']),
					senderId: requestBody.senderId || '',
					message: requestBody.message || 'Test fax',
					files: requestBody.files || []
				};
			}
			// Return empty recipients for null/empty request body
			return {
				recipients: [],
				senderId: '',
				message: 'Test fax',
				files: []
			};
		}),
		sendFaxWithCustomWorkflow: vi.fn().mockResolvedValue({
			id: 'telnyx-fax-123',
			friendlyId: 'TELNYX123',
			status: 'queued',
			originalStatus: 'Submitted',
			message: 'Fax submitted to Telnyx successfully',
			timestamp: new Date().toISOString(),
			providerResponse: {
				id: 'telnyx-fax-123',
				status: 'queued'
			}
		}),
		mapStatus: vi.fn().mockImplementation((status) => {
			// Simple status mapping for tests
			const statusMap = {
				'delivered': 'delivered',
				'failed': 'failed',
				'queued': 'queued',
				'sending': 'sending',
				'canceled': 'cancelled'
			};
			return statusMap[status] || 'failed';
		})
	}))
}));

// Mock NotifyreProvider
vi.mock('../src/providers/notifyre-provider.js', () => ({
	NotifyreProvider: vi.fn().mockImplementation((apiKey, logger) => ({
		apiKey,
		logger,
		getProviderName: () => 'notifyre',
		prepareFaxRequest: vi.fn().mockImplementation(async (requestBody) => {
			if (requestBody && typeof requestBody === 'object' && requestBody !== null) {
				return {
					recipients: requestBody.recipients || (requestBody.recipient ? [requestBody.recipient] : ['+1234567890']),
					senderId: requestBody.senderId || '',
					message: requestBody.message || 'Test fax',
					files: requestBody.files || []
				};
			}
			// Return empty recipients for null/empty request body
			return {
				recipients: [],
				senderId: '',
				message: 'Test fax',
				files: []
			};
		}),
		buildPayload: vi.fn().mockResolvedValue({
			Faxes: {
				Recipients: [{ Type: 'fax_number', Value: '+1234567890' }],
				SendFrom: '',
				ClientReference: 'SendFaxPro',
				Subject: 'Test fax',
				IsHighQuality: false,
				CoverPage: false,
				Documents: []
			}
		}),
		sendFax: vi.fn().mockResolvedValue({
			id: 'fax_mock_123',
			friendlyId: 'TEST123',
			status: 'queued',
			originalStatus: 'Submitted',
			message: 'Fax submitted successfully',
			timestamp: new Date().toISOString(),
			providerResponse: {
				payload: {
					faxID: 'fax_mock_123',
					friendlyID: 'TEST123'
				},
				success: true
			}
		})
	}))
}));

// Mock fetch for Notifyre API calls
global.fetch = vi.fn();

import FaxService from '../src/fax.js';
import { DatabaseUtils } from '../src/database.js';
import { NotifyreApiUtils } from '../src/utils.js';

describe('Fax Service', () => {
	let faxService;
	let mockEnv;
	let mockSagContext;

	beforeAll(() => {
			mockEnv = {
				NOTIFYRE_API_KEY: {
					get: vi.fn().mockResolvedValue('test-notifyre-key')
				},
				SUPABASE_URL: 'https://test.supabase.co',
				SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
				SUPABASE_WEBHOOK_SECRET: 'test-webhook-secret',
				REVENUECAT_PROJECT_ID: 'test-project',
				REVENUECAT_SECRET_API_KEY: 'test-rc-secret',
				LOG_LEVEL: 'DEBUG'
			};
		
		mockSagContext = {
			jwtPayload: {
				sub: 'test-user-123',
				email: 'test@example.com'
			}
		};

		// Create instance of the service
		faxService = new FaxService();
		faxService.env = mockEnv;

		// Mock JSON.parse to return our properly mocked environment when parsing env
		const originalJsonParse = JSON.parse;
		vi.spyOn(JSON, 'parse').mockImplementation((text) => {
			const parsed = originalJsonParse(text);
			// If this looks like our environment object, return the mocked version
			if (parsed && parsed.NOTIFYRE_API_KEY !== undefined && parsed.SUPABASE_URL) {
				return mockEnv;
			}
			// Otherwise return the normally parsed object (for context parsing)
			return parsed;
		});
	});

	beforeEach(() => {
		mockConvertToPdf.mockReset();
		mockConvertToPdf.mockResolvedValue({
			pdfBytes: new Uint8Array([37, 80, 68, 70]),
			pageCount: 2,
			outputFilename: 'converted.pdf',
			elapsedMs: 25
		});

		// Mock fetch for Notifyre API calls
		global.fetch.mockImplementation((url, options) => {
			const urlObj = new URL(url);
			const path = urlObj.pathname;
			const jsonResponse = (statusCode, payload) => ({
				ok: statusCode >= 200 && statusCode < 300,
				status: statusCode,
				json: () => Promise.resolve(payload),
				text: () => Promise.resolve(JSON.stringify(payload))
			});

			// RevenueCat API mocks
			if (urlObj.hostname === 'api.revenuecat.com' && path.endsWith('/active_entitlements')) {
				return Promise.resolve(jsonResponse(200, { items: [] }));
			}

			if (urlObj.hostname === 'api.revenuecat.com' && path.endsWith('/virtual_currencies')) {
				return Promise.resolve(jsonResponse(200, {
					items: [
						{ currency_code: 'FreeCredit', balance: 100 },
						{ currency_code: 'ProCredit', balance: 0 }
					]
				}));
			}

			if (urlObj.hostname === 'api.revenuecat.com' && path.endsWith('/virtual_currencies/transactions')) {
				return Promise.resolve(jsonResponse(200, { success: true }));
			}

			// Mock responses based on the path
			if (path === '/fax/send') {
				// Verify the request structure matches Notifyre format
				if (options.body) {
					const requestBody = JSON.parse(options.body);
					// Verify it has the correct Notifyre structure
					if (requestBody.Faxes && requestBody.Faxes.Recipients) {
						// Valid Notifyre format
					}
				}
				
					return Promise.resolve(jsonResponse(200, {
							payload: {
								faxID: 'fax_mock_123',
								friendlyID: 'TEST123'
							},
							success: true,
							statusCode: 200,
							message: "OK",
							errors: []
						}));
				}

				if (path.startsWith('/fax/sent') && path.includes('?')) {
					return Promise.resolve(jsonResponse(200, {
							data: [
								{
									id: 'fax_123',
								status: 'Successful',
								recipients: ['1234567890'],
								pages: 1,
								cost: 0.03,
								sentAt: '2024-01-01T00:00:00Z',
								completedAt: '2024-01-01T00:05:00Z'
							}
							],
							total: 1
						}));
				}

				if (path === '/fax/sent/fax_123') {
					return Promise.resolve(jsonResponse(200, {
							id: 'fax_123',
							status: 'Successful',
							recipients: ['1234567890'],
						pages: 1,
							cost: 0.03,
							sentAt: '2024-01-01T00:00:00Z',
							completedAt: '2024-01-01T00:05:00Z'
						}));
				}

				if (path.startsWith('/fax/received') && path.includes('?')) {
					return Promise.resolve(jsonResponse(200, {
							data: [
								{
									id: 'received_123',
								sender: '+0987654321',
								pages: 2,
								receivedAt: '2024-01-01T00:00:00Z',
								faxNumber: '+1234567890'
							}
							],
							total: 1
						}));
				}

				if (path.includes('/download')) {
					return Promise.resolve(jsonResponse(200, {
							fileData: 'base64encodeddata',
							filename: path.includes('sent') ? 'fax_123.pdf' : 'received_fax_123.pdf',
							mimeType: 'application/pdf'
						}));
				}

				if (path === '/fax/numbers') {
					return Promise.resolve(jsonResponse(200, {
							data: [
								{ number: '+1234567890', status: 'active' }
							]
						}));
				}

				if (path === '/fax/cover-pages') {
					return Promise.resolve(jsonResponse(200, {
							data: [
								{ id: 'cp_1', name: 'Default Cover Page' }
							]
						}));
				}

				// Default mock response
				return Promise.resolve(jsonResponse(404, { error: 'Not found' }));
			});
		});

		const jsonResponse = (statusCode, payload) => ({
			ok: statusCode >= 200 && statusCode < 300,
			status: statusCode,
			json: () => Promise.resolve(payload),
			text: () => Promise.resolve(JSON.stringify(payload))
		});

		function installSendFaxFetchMockWithRevenueCatSnapshots(snapshots) {
			let entitlementCalls = 0;
			let currencyCalls = 0;

			global.fetch.mockImplementation((url, options) => {
				const urlObj = new URL(url);
				const path = urlObj.pathname;

				if (urlObj.hostname === 'api.revenuecat.com' && path.endsWith('/active_entitlements')) {
					const snapshot = snapshots[Math.min(entitlementCalls, snapshots.length - 1)];
					entitlementCalls++;
					return Promise.resolve(jsonResponse(200, {
						items: snapshot.isSubscriber ? [{ id: 'pro', entitlement_id: 'pro' }] : []
					}));
				}

				if (urlObj.hostname === 'api.revenuecat.com' && path.endsWith('/virtual_currencies')) {
					const snapshot = snapshots[Math.min(currencyCalls, snapshots.length - 1)];
					currencyCalls++;
					return Promise.resolve(jsonResponse(200, {
						items: [
							{ currency_code: 'FreeCredit', balance: snapshot.freeCredits ?? 0 },
							{ currency_code: 'ProCredit', balance: snapshot.proCredits ?? 0 }
						]
					}));
				}

				if (path === '/fax/send') {
					return Promise.resolve(jsonResponse(200, {
						payload: {
							faxID: 'fax_mock_123',
							friendlyID: 'TEST123'
						},
						success: true,
						statusCode: 200,
						message: "OK",
						errors: []
					}));
				}

				return Promise.resolve(jsonResponse(404, { error: 'Not found' }));
			});

			return {
				getEntitlementCalls: () => entitlementCalls,
				getCurrencyCalls: () => currencyCalls
			};
		}

		describe('sendFax', () => {
			it('should queue a fax successfully', async () => {
				const request = new Request('https://api.sendfax.pro/v1/fax/send', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					message: 'Test fax message',
					files: [
						{
							filename: 'test.pdf',
							data: 'U2FtcGxlQmFzZTY0RGF0YQ==', // "SampleBase64Data" in base64
							mimeType: 'application/pdf'
						}
					],
					pages: 2
				})
			});

			const result = await faxService.sendFax(request, JSON.stringify(mockEnv), JSON.stringify(mockSagContext));
			expect(result.statusCode).toBe(200);
				expect(result.message).toBe('Fax submitted successfully');
				expect(result.data.recipient).toBe('+1234567890');
				expect(result.data.status).toBe('queued');
			});

			it('should return normal insufficient credits for free users without retrying RevenueCat', async () => {
				const rcCalls = installSendFaxFetchMockWithRevenueCatSnapshots([
					{ isSubscriber: false, freeCredits: 0, proCredits: 0 }
				]);
				const request = new Request('https://api.sendfax.pro/v1/fax/send', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						recipient: '+1234567890',
						message: 'Test fax message',
						pages: 2
					})
				});

				const result = await faxService.sendFax(request, JSON.stringify(mockEnv), JSON.stringify(mockSagContext));

				expect(result.statusCode).toBe(402);
				expect(result.data.reason).toBe('insufficient_credits');
				expect(result.data.availableCredits).toBe(0);
				expect(result.data.activeCredits).toBe(0);
				expect(result.data.freeCredits).toBe(0);
				expect(result.data.proCredits).toBe(0);
				expect(result.data.retryAfterSeconds).toBeNull();
				expect(rcCalls.getEntitlementCalls()).toBe(1);
				expect(rcCalls.getCurrencyCalls()).toBe(1);
			});

			it('should retry subscriber credit snapshot and queue when ProCredit appears', async () => {
				const rcCalls = installSendFaxFetchMockWithRevenueCatSnapshots([
					{ isSubscriber: true, freeCredits: 0, proCredits: 0 },
					{ isSubscriber: true, freeCredits: 0, proCredits: 40 }
				]);
				const envWithFastRetry = {
					...mockEnv,
					REVENUECAT_CREDIT_SYNC_RETRY_ATTEMPTS: '3',
					REVENUECAT_CREDIT_SYNC_RETRY_BASE_MS: '0'
				};
				const request = new Request('https://api.sendfax.pro/v1/fax/send', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						recipient: '+1234567890',
						message: 'Test fax message',
						pages: 2
					})
				});

				const result = await faxService.sendFax(request, envWithFastRetry, mockSagContext);

				expect(result.statusCode).toBe(200);
				expect(result.message).toBe('Fax submitted successfully');
				expect(rcCalls.getEntitlementCalls()).toBe(2);
				expect(rcCalls.getCurrencyCalls()).toBe(2);
			});

			it('should return subscription syncing when subscriber ProCredit remains missing after retries', async () => {
				const rcCalls = installSendFaxFetchMockWithRevenueCatSnapshots([
					{ isSubscriber: true, freeCredits: 0, proCredits: 0 },
					{ isSubscriber: true, freeCredits: 0, proCredits: 0 }
				]);
				const envWithFastRetry = {
					...mockEnv,
					REVENUECAT_CREDIT_SYNC_RETRY_ATTEMPTS: '2',
					REVENUECAT_CREDIT_SYNC_RETRY_BASE_MS: '0'
				};
				const request = new Request('https://api.sendfax.pro/v1/fax/send', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						recipient: '+1234567890',
						message: 'Test fax message',
						pages: 2
					})
				});

				const result = await faxService.sendFax(request, envWithFastRetry, mockSagContext);

				expect(result.statusCode).toBe(402);
				expect(result.data.reason).toBe('subscription_credits_syncing');
				expect(result.data.isSubscriber).toBe(true);
				expect(result.data.availableCredits).toBe(0);
				expect(result.data.activeCredits).toBe(0);
				expect(result.data.proCredits).toBe(0);
				expect(result.data.retryAfterSeconds).toBe(1);
				expect(rcCalls.getEntitlementCalls()).toBe(2);
				expect(rcCalls.getCurrencyCalls()).toBe(2);
			});

			it('should not retry when subscriber already has enough ProCredit', async () => {
				const rcCalls = installSendFaxFetchMockWithRevenueCatSnapshots([
					{ isSubscriber: true, freeCredits: 0, proCredits: 40 }
				]);
				const envWithFastRetry = {
					...mockEnv,
					REVENUECAT_CREDIT_SYNC_RETRY_ATTEMPTS: '3',
					REVENUECAT_CREDIT_SYNC_RETRY_BASE_MS: '0'
				};
				const request = new Request('https://api.sendfax.pro/v1/fax/send', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						recipient: '+1234567890',
						message: 'Test fax message',
						pages: 2
					})
				});

				const result = await faxService.sendFax(request, envWithFastRetry, mockSagContext);

				expect(result.statusCode).toBe(200);
				expect(rcCalls.getEntitlementCalls()).toBe(1);
				expect(rcCalls.getCurrencyCalls()).toBe(1);
			});

			it('should handle empty request body', async () => {
				const request = new Request('https://api.sendfax.pro/v1/fax/send', {
					method: 'POST'
				});

			const result = await faxService.sendFax(request, JSON.stringify(mockEnv), JSON.stringify(mockSagContext));
			expect(result.statusCode).toBe(200);
			expect(result.data.recipient).toBe('unknown');
			expect(result.data.pages).toBe(1);
		});

		it('should call DatabaseUtils.saveFaxRecord during fax sending', async () => {
			const request = new Request('https://api.sendfax.pro/v1/fax/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					message: 'Test fax message'
				})
			});

			const result = await faxService.sendFax(request, JSON.stringify(mockEnv), JSON.stringify(mockSagContext));
			
			expect(result.statusCode).toBe(200);
			expect(DatabaseUtils.saveFaxRecord).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'fax_mock_123',
					friendlyId: 'TEST123',
					status: 'queued',
					recipients: ['+1234567890']
				}),
				'test-user-123', // userId from context
				mockEnv,
				expect.any(Object) // logger
			);
		});

		it('should normalize office files for Telnyx when conversion is enabled', async () => {
			const telnyxEnv = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
				TELNYX_API_KEY: 'test-telnyx-key',
				TELNYX_CONNECTION_ID: 'test-connection-id',
				TELNYX_ENABLE_FILE_CONVERSION: 'true',
				FAX_FILES_BUCKET: { put: vi.fn(), get: vi.fn(), name: 'test-bucket' },
				CLOUDFLARE_ACCOUNT_ID: 'test-account-id'
			};

			const request = new Request('https://api.sendfax.pro/v1/fax/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					files: [
						{
							filename: 'office.docx',
							data: 'dGVzdA==',
							mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
						}
					]
				})
			});

			const result = await faxService.sendFax(request, telnyxEnv, mockSagContext);
			expect(result.statusCode).toBe(200);
			expect(mockConvertToPdf).toHaveBeenCalledTimes(1);
		});

		it('should canonicalize ppt, pptx, and odt MIME types before conversion', async () => {
			const telnyxEnv = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
				TELNYX_API_KEY: 'test-telnyx-key',
				TELNYX_CONNECTION_ID: 'test-connection-id',
				TELNYX_ENABLE_FILE_CONVERSION: 'true',
				FAX_FILES_BUCKET: { put: vi.fn(), get: vi.fn(), name: 'test-bucket' },
				CLOUDFLARE_ACCOUNT_ID: 'test-account-id'
			};

			const request = new Request('https://api.sendfax.pro/v1/fax/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					files: [
						{ filename: 'deck.ppt', data: 'dGVzdA==', mimeType: 'application/octet-stream' },
						{ filename: 'slides.pptx', data: 'dGVzdA==', mimeType: 'application/octet-stream' },
						{ filename: 'document.odt', data: 'dGVzdA==', mimeType: 'application/x-vnd.oasis.opendocument.text; charset=binary' }
					]
				})
			});

			const result = await faxService.sendFax(request, telnyxEnv, mockSagContext);
			expect(result.statusCode).toBe(200);
			expect(mockConvertToPdf).toHaveBeenCalledTimes(3);
			expect(mockConvertToPdf).toHaveBeenNthCalledWith(1, expect.objectContaining({
				filename: 'deck.ppt',
				mimeType: 'application/vnd.ms-powerpoint'
			}));
			expect(mockConvertToPdf).toHaveBeenNthCalledWith(2, expect.objectContaining({
				filename: 'slides.pptx',
				mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
			}));
			expect(mockConvertToPdf).toHaveBeenNthCalledWith(3, expect.objectContaining({
				filename: 'document.odt',
				mimeType: 'application/vnd.oasis.opendocument.text'
			}));
		});

		it('should still convert backend-convert formats when conversion flag is false', async () => {
			const telnyxEnv = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
				TELNYX_API_KEY: 'test-telnyx-key',
				TELNYX_CONNECTION_ID: 'test-connection-id',
				TELNYX_ENABLE_FILE_CONVERSION: 'false',
				FAX_FILES_BUCKET: { put: vi.fn(), get: vi.fn(), name: 'test-bucket' },
				CLOUDFLARE_ACCOUNT_ID: 'test-account-id'
			};

			const request = new Request('https://api.sendfax.pro/v1/fax/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					files: [
						{ filename: 'document.odt', data: 'dGVzdA==', mimeType: 'application/octet-stream' }
					]
				})
			});

			const result = await faxService.sendFax(request, telnyxEnv, mockSagContext);
			expect(result.statusCode).toBe(200);
			expect(mockConvertToPdf).toHaveBeenCalledTimes(1);
			expect(mockConvertToPdf).toHaveBeenCalledWith(expect.objectContaining({
				filename: 'document.odt',
				mimeType: 'application/vnd.oasis.opendocument.text'
			}));
		});

		it('should normalize office files for Telnyx by default when flag is missing', async () => {
			const telnyxEnv = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
				TELNYX_API_KEY: 'test-telnyx-key',
				TELNYX_CONNECTION_ID: 'test-connection-id',
				FAX_FILES_BUCKET: { put: vi.fn(), get: vi.fn(), name: 'test-bucket' },
				CLOUDFLARE_ACCOUNT_ID: 'test-account-id'
			};

			const request = new Request('https://api.sendfax.pro/v1/fax/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					files: [
						{
							filename: 'office.docx',
							data: 'dGVzdA==',
							mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
						}
					]
				})
			});

			const result = await faxService.sendFax(request, telnyxEnv, mockSagContext);
			expect(result.statusCode).toBe(200);
			expect(mockConvertToPdf).toHaveBeenCalledTimes(1);
		});

		it('should return 422 when Telnyx conversion fails', async () => {
			mockConvertToPdf.mockRejectedValueOnce({ code: 'timeout', message: 'timed out' });

			const telnyxEnv = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
					TELNYX_API_KEY: 'test-telnyx-key',
					TELNYX_CONNECTION_ID: 'test-connection-id',
					TELNYX_ENABLE_FILE_CONVERSION: 'true',
					FAX_FILES_BUCKET: { put: vi.fn(), get: vi.fn(), name: 'test-bucket' },
					CLOUDFLARE_ACCOUNT_ID: 'test-account-id'
				};

			const request = new Request('https://api.sendfax.pro/v1/fax/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					files: [
						{
							filename: 'office.docx',
							data: 'dGVzdA==',
							mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
						}
					]
				})
			});

			const result = await faxService.sendFax(request, telnyxEnv, mockSagContext);
			expect(result.statusCode).toBe(422);
			expect(result.error).toBe('File conversion failed');
			expect(result.data.failedFiles[0].reason).toBe('timeout');
		});

		it('should reject unsupported Telnyx file types with deterministic reason', async () => {
			const telnyxEnv = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
					TELNYX_API_KEY: 'test-telnyx-key',
					TELNYX_CONNECTION_ID: 'test-connection-id',
					TELNYX_ENABLE_FILE_CONVERSION: 'true',
					FAX_FILES_BUCKET: { put: vi.fn(), get: vi.fn(), name: 'test-bucket' },
					CLOUDFLARE_ACCOUNT_ID: 'test-account-id'
				};

			const request = new Request('https://api.sendfax.pro/v1/fax/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					files: [
						{
							filename: 'archive.zip',
							data: 'dGVzdA==',
							mimeType: 'application/zip'
						}
					]
				})
			});

			const result = await faxService.sendFax(request, telnyxEnv, mockSagContext);
			expect(result.statusCode).toBe(422);
			expect(result.data.failedFiles[0].reason).toBe('unsupported_type');
			expect(mockConvertToPdf).not.toHaveBeenCalled();
		});

		it('should reject invalid PDF payloads even when extension is pdf', async () => {
			const telnyxEnv = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
				TELNYX_API_KEY: 'test-telnyx-key',
				TELNYX_CONNECTION_ID: 'test-connection-id',
				TELNYX_ENABLE_FILE_CONVERSION: 'true',
				FAX_FILES_BUCKET: { put: vi.fn(), get: vi.fn(), name: 'test-bucket' },
				CLOUDFLARE_ACCOUNT_ID: 'test-account-id'
			};

			const request = new Request('https://api.sendfax.pro/v1/fax/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					recipient: '+1234567890',
					files: [
						{
							filename: 'document.pdf',
							data: 'dGVzdA==',
							mimeType: 'application/pdf'
						}
					]
				})
			});

			const result = await faxService.sendFax(request, telnyxEnv, mockSagContext);
			expect(result.statusCode).toBe(422);
			expect(result.error).toBe('File conversion failed');
			expect(result.data.failedFiles[0].reason).toBe('invalid_pdf_content');
			expect(mockConvertToPdf).not.toHaveBeenCalled();
			});
		});

		describe('numberLookup', () => {
			it('should keep snake_case fields and include camelCase data compatibility fields', async () => {
				const lookupSpy = vi.spyOn(faxService, 'performTelnyxLookup').mockResolvedValue({
					country_code: 'US',
					portability: {}
				});
				const request = new Request('https://api.sendfax.pro/v1/fax/lookup?to=%2B1234567890', {
					method: 'GET'
				});

				try {
					const result = await faxService.numberLookup(request, {
						...mockEnv,
						TELNYX_API_KEY: 'test-telnyx-key'
					}, mockSagContext);

					expect(result.statusCode).toBe(200);
					expect(result.credit_per_page).toBeGreaterThan(0);
					expect(result.creditPerPage).toBe(result.credit_per_page);
					expect(result.phone_e164).toBe('+1234567890');
					expect(result.phoneE164).toBe('+1234567890');
					expect(result.dialed_digits).toBe('1234567890');
					expect(result.dialedDigits).toBe('1234567890');
					expect(result.billed_rate).toBeTruthy();
					expect(result.billedRate).toEqual(result.billed_rate);
					expect(result.data).toEqual(expect.objectContaining({
						input: '+1234567890',
						phoneE164: '+1234567890',
						dialedDigits: '1234567890',
						creditPerPage: result.credit_per_page,
						billedRate: result.billed_rate
					}));
				} finally {
					lookupSpy.mockRestore();
				}
			});
		});



		describe('Provider Selection', () => {
		it('should default to Notifyre provider when FAX_PROVIDER not set', async () => {
			const envWithoutProvider = { ...mockEnv };
			delete envWithoutProvider.FAX_PROVIDER;
			
			const provider = await faxService.createFaxProvider('notifyre', envWithoutProvider);
			expect(provider.getProviderName()).toBe('notifyre');
		});

		it('should use Notifyre provider when FAX_PROVIDER=notifyre', async () => {
			const envWithNotifyre = { ...mockEnv, FAX_PROVIDER: 'notifyre' };
			
			const provider = await faxService.createFaxProvider('notifyre', envWithNotifyre);
			expect(provider.getProviderName()).toBe('notifyre');
		});

		it('should use Telnyx provider when FAX_PROVIDER=telnyx', async () => {
			const envWithTelnyx = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
				TELNYX_API_KEY: 'test-telnyx-key',
				TELNYX_CONNECTION_ID: 'test-connection-id',
				FAX_FILES_BUCKET: { put: vi.fn(), get: vi.fn(), name: 'test-bucket' },
				CLOUDFLARE_ACCOUNT_ID: 'test-account-id'
			};
			
			const provider = await faxService.createFaxProvider('telnyx', envWithTelnyx);
			expect(provider.getProviderName()).toBe('telnyx');
		});

		it('should throw error for unsupported provider', async () => {
			const envWithUnsupported = { ...mockEnv, FAX_PROVIDER: 'unsupported' };
			
			await expect(faxService.createFaxProvider('unsupported', envWithUnsupported))
				.rejects.toThrow('Unsupported API provider: unsupported');
		});

		it('should throw error when Telnyx API key missing', async () => {
			const envWithoutKey = { 
				...mockEnv, 
				FAX_PROVIDER: 'telnyx',
				TELNYX_CONNECTION_ID: 'test-connection-id'
			};
			
			await expect(faxService.createFaxProvider('telnyx', envWithoutKey))
				.rejects.toThrow('API key not found for telnyx provider');
		});

		it('should throw error when Telnyx connection ID missing', async () => {
			const envWithoutConnectionId = {
				...mockEnv,
				FAX_PROVIDER: 'telnyx',
				TELNYX_API_KEY: 'test-key'
			};
			
			await expect(faxService.createFaxProvider('telnyx', envWithoutConnectionId))
				.rejects.toThrow('TELNYX_CONNECTION_ID is required for Telnyx provider');
		});
	});

	describe('health handlers', () => {
		it('should return healthy status (unauthenticated)', async () => {
			const request = new Request('https://api.sendfax.pro/v1/fax/health', { method: 'GET' });
			const result = await faxService.health(request, mockEnv, mockSagContext);
			expect(result.statusCode).toBe(200);
			expect(result.message).toBe('Fax service healthy');
			expect(result.data.service).toBe('fax');
			expect(result.data.version).toBe('2.0.0');
		});

		it('should return healthy status with user info (authenticated)', async () => {
			const request = new Request('https://api.sendfax.pro/v1/fax/health/protected', { method: 'GET' });
			const result = await faxService.healthProtected(request, mockEnv, mockSagContext);
			expect(result.statusCode).toBe(200);
			expect(result.message).toBe('Fax service healthy (authenticated)');
			expect(result.data.service).toBe('fax');
			expect(result.data.user.sub).toBe('test-user-123');
			expect(result.data.version).toBe('2.0.0');
		});
	});

	describe('Telnyx webhook handler', () => {
		beforeEach(() => {
			// Clear mock calls between tests
			DatabaseUtils.updateFaxRecord.mockClear();
			DatabaseUtils.storeWebhookEvent.mockClear();
		});

		it('should process Telnyx webhook with page count successfully', async () => {
			const webhookPayload = {
				data: {
					event_type: 'fax.delivered',
					payload: {
						fax_id: 'a92b4cc7-6817-49e8-932b-fef103d35b5c',
						status: 'delivered',
						page_count: 3,
						call_duration_secs: 169,
						from: '+18334610414',
						to: '+19725329272'
					}
				}
			};

			const request = new Request('https://api.sendfax.pro/v1/fax/webhook/telnyx', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(webhookPayload)
			});

			const result = await faxService.telnyxWebhook(request, JSON.stringify(mockEnv), JSON.stringify(mockSagContext));

			expect(result.statusCode).toBe(200);
			expect(result.message).toBe('Webhook processed successfully');
			expect(result.data.faxId).toBe('a92b4cc7-6817-49e8-932b-fef103d35b5c');
			expect(result.data.standardizedStatus).toBe('delivered');

			// Verify that updateFaxRecord was called with page count
			expect(DatabaseUtils.updateFaxRecord).toHaveBeenCalledWith(
				'a92b4cc7-6817-49e8-932b-fef103d35b5c',
				expect.objectContaining({
					status: 'delivered',
					original_status: 'delivered',
					pages: 3,
					metadata: webhookPayload.data.payload
				}),
				mockEnv,
				expect.any(Object), // logger
				'provider_fax_id'
			);

			// Verify webhook event was stored
			expect(DatabaseUtils.storeWebhookEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event: 'fax.delivered',
					faxId: 'a92b4cc7-6817-49e8-932b-fef103d35b5c',
					processedData: expect.objectContaining({
						pages: 3
					}),
					rawPayload: webhookPayload
				}),
				mockEnv,
				expect.any(Object) // logger
			);
		});

		it('should process Telnyx webhook without page count', async () => {
			const webhookPayload = {
				data: {
					event_type: 'fax.failed',
					payload: {
						fax_id: 'a92b4cc7-6817-49e8-932b-fef103d35b5c',
						status: 'failed',
						failure_reason: 'destination_unreachable',
						from: '+18334610414',
						to: '+19725329272'
					}
				}
			};

			const request = new Request('https://api.sendfax.pro/v1/fax/webhook/telnyx', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(webhookPayload)
			});

			const result = await faxService.telnyxWebhook(request, JSON.stringify(mockEnv), JSON.stringify(mockSagContext));

			expect(result.statusCode).toBe(200);
			expect(result.message).toBe('Webhook processed successfully');

			// Verify that updateFaxRecord was called without page count
			expect(DatabaseUtils.updateFaxRecord).toHaveBeenCalledWith(
				'a92b4cc7-6817-49e8-932b-fef103d35b5c',
				expect.objectContaining({
					status: 'failed',
					original_status: 'failed',
					error_message: 'destination_unreachable',
					metadata: webhookPayload.data.payload
				}),
				mockEnv,
				expect.any(Object), // logger
				'provider_fax_id'
			);

			// Verify that pages field is not included in the update data
			const updateCall = DatabaseUtils.updateFaxRecord.mock.calls.find(
				call => call[0] === 'a92b4cc7-6817-49e8-932b-fef103d35b5c'
			);
			expect(updateCall[1]).not.toHaveProperty('pages');
		});

		it('should handle webhook with missing fax_id', async () => {
			const webhookPayload = {
				data: {
					event_type: 'fax.delivered',
					payload: {
						status: 'delivered',
						page_count: 3
					}
				}
			};

			const request = new Request('https://api.sendfax.pro/v1/fax/webhook/telnyx', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(webhookPayload)
			});

			const result = await faxService.telnyxWebhook(request, JSON.stringify(mockEnv), JSON.stringify(mockSagContext));

			expect(result.statusCode).toBe(400);
			expect(result.error).toBe('Invalid webhook payload: missing fax_id');
		});
	});


});
