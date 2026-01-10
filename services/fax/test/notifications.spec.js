/**
 * Property-based tests for NotificationService
 * 
 * **Feature: ios-backend-integration, Property 14: Notification Payload Completeness**
 * **Validates: Requirements 9.9**
 * 
 * For any push notification sent for fax status change, the payload SHALL include
 * fax_id, recipient_number, status, and deep_link URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Supabase client to avoid ES module issues in tests
vi.mock('@supabase/supabase-js', () => ({
    createClient: vi.fn(() => ({
        from: vi.fn(() => ({
            select: vi.fn(() => ({ 
                eq: vi.fn(() => ({
                    single: vi.fn(() => Promise.resolve({ data: null, error: { code: 'PGRST116' } }))
                }))
            })),
            insert: vi.fn(() => ({ select: vi.fn() })),
            update: vi.fn(() => ({ eq: vi.fn() }))
        }))
    }))
}));

import { NotificationService, createNotificationService } from '../src/notifications.js';

// Mock fetch globally
global.fetch = vi.fn();

// Mock logger
const createMockLogger = () => ({
    log: vi.fn()
});

// Helper to generate random strings
function randomString(length = 10) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Helper to generate random UUID-like strings
function randomUUID() {
    return `${randomString(8)}-${randomString(4)}-${randomString(4)}-${randomString(4)}-${randomString(12)}`;
}

// Helper to generate random phone numbers
function randomPhoneNumber() {
    const areaCode = Math.floor(Math.random() * 900) + 100;
    const firstPart = Math.floor(Math.random() * 900) + 100;
    const lastPart = Math.floor(Math.random() * 9000) + 1000;
    return `+1${areaCode}${firstPart}${lastPart}`;
}

// Helper to generate random fax status
function randomFaxStatus() {
    const statuses = ['delivered', 'failed'];
    return statuses[Math.floor(Math.random() * statuses.length)];
}

describe('NotificationService', () => {
    let notificationService;
    let mockLogger;
    let mockEnv;

    beforeEach(() => {
        mockLogger = createMockLogger();
        notificationService = new NotificationService(mockLogger);
        mockEnv = {
            ONESIGNAL_APP_ID: 'test-app-id',
            ONESIGNAL_REST_API_KEY: 'test-api-key',
            SUPABASE_URL: 'https://test.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
        };

        // Reset fetch mock
        global.fetch.mockReset();
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: () => Promise.resolve({ id: 'notification-123', recipients: 1 })
        });
    });

    describe('Property 14: Notification Payload Completeness', () => {
        /**
         * Property test: For any fax status notification, the payload SHALL include
         * fax_id, recipient_number, status, and deep_link URL.
         * 
         * This test runs 100 iterations with randomly generated fax data to verify
         * that the notification payload always contains all required fields.
         */
        it('should include all required fields in notification payload for any fax', async () => {
            // Run 100 iterations with random fax data
            for (let i = 0; i < 100; i++) {
                const faxId = randomUUID();
                const userId = randomUUID();
                const recipientNumber = randomPhoneNumber();
                const status = randomFaxStatus();

                const fax = {
                    id: faxId,
                    user_id: userId,
                    status: status,
                    recipients: [recipientNumber],
                    error_message: status === 'failed' ? 'Test error' : null
                };

                // Reset fetch mock for each iteration
                global.fetch.mockReset();
                global.fetch.mockResolvedValue({
                    ok: true,
                    json: () => Promise.resolve({ id: `notification-${i}`, recipients: 1 })
                });

                await notificationService.sendFaxStatusNotification(mockEnv, fax);

                // Verify fetch was called
                expect(global.fetch).toHaveBeenCalled();

                // Get the payload that was sent
                const fetchCall = global.fetch.mock.calls[0];
                const requestBody = JSON.parse(fetchCall[1].body);

                // Verify all required fields are present in the data payload
                expect(requestBody.data).toBeDefined();
                expect(requestBody.data.fax_id).toBe(faxId);
                expect(requestBody.data.status).toBe(status);
                expect(requestBody.data.recipient_number).toBe(recipientNumber);
                expect(requestBody.data.deep_link).toBe(`sendfaxapp://fax/${faxId}`);

                // Verify deep_link format is correct
                expect(requestBody.data.deep_link).toMatch(/^sendfaxapp:\/\/fax\/[a-z0-9-]+$/);
            }
        });

        /**
         * Property test: buildNotificationPayload always produces complete payloads
         * For any valid input parameters, the built payload should contain all required fields.
         */
        it('should build complete notification payloads for any valid input', () => {
            // Run 100 iterations
            for (let i = 0; i < 100; i++) {
                const faxId = randomUUID();
                const status = randomFaxStatus();
                const recipientNumber = randomPhoneNumber();
                const title = `Test Title ${i}`;
                const message = `Test message ${i}`;

                const payload = notificationService.buildNotificationPayload({
                    faxId,
                    status,
                    recipientNumber,
                    title,
                    message
                });

                // Validate the payload has all required fields
                const validation = notificationService.validateNotificationPayload(payload);

                expect(validation.isValid).toBe(true);
                expect(validation.missingFields).toHaveLength(0);
                expect(payload.faxId).toBe(faxId);
                expect(payload.status).toBe(status);
                expect(payload.recipientNumber).toBe(recipientNumber);
                expect(payload.deepLink).toBe(`sendfaxapp://fax/${faxId}`);
            }
        });

        /**
         * Property test: validateNotificationPayload correctly identifies missing fields
         * For any payload with missing fields, validation should report them.
         */
        it('should correctly identify missing fields in incomplete payloads', () => {
            const requiredFields = ['faxId', 'status', 'recipientNumber', 'deepLink'];

            // Test each field being missing
            for (const missingField of requiredFields) {
                for (let i = 0; i < 25; i++) {
                    const payload = {
                        faxId: randomUUID(),
                        status: randomFaxStatus(),
                        recipientNumber: randomPhoneNumber(),
                        deepLink: `sendfaxapp://fax/${randomUUID()}`
                    };

                    // Remove the field we're testing
                    payload[missingField] = null;

                    const validation = notificationService.validateNotificationPayload(payload);

                    expect(validation.isValid).toBe(false);
                    expect(validation.missingFields).toContain(missingField);
                }
            }
        });

        /**
         * Property test: Deep link URL format is always correct
         * For any fax ID, the deep link should follow the format sendfaxapp://fax/{faxId}
         */
        it('should generate correct deep link format for any fax ID', () => {
            // Run 100 iterations
            for (let i = 0; i < 100; i++) {
                const faxId = randomUUID();

                const payload = notificationService.buildNotificationPayload({
                    faxId,
                    status: 'delivered',
                    recipientNumber: randomPhoneNumber(),
                    title: 'Test',
                    message: 'Test'
                });

                // Verify deep link format
                expect(payload.deepLink).toBe(`sendfaxapp://fax/${faxId}`);
                expect(payload.deepLink).toMatch(/^sendfaxapp:\/\/fax\/.+$/);

                // Verify the fax ID can be extracted from the deep link
                const extractedId = payload.deepLink.replace('sendfaxapp://fax/', '');
                expect(extractedId).toBe(faxId);
            }
        });
    });

    describe('sendPushNotification', () => {
        it('should return error when OneSignal App ID is not configured', async () => {
            const envWithoutAppId = { ...mockEnv, ONESIGNAL_APP_ID: undefined };

            const result = await notificationService.sendPushNotification(
                envWithoutAppId,
                'user-123',
                { title: 'Test', message: 'Test', faxId: 'fax-123', status: 'delivered', recipientNumber: '+1234567890' }
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('OneSignal App ID not configured');
        });

        it('should return error when OneSignal API Key is not configured', async () => {
            const envWithoutApiKey = { ...mockEnv, ONESIGNAL_REST_API_KEY: undefined };

            const result = await notificationService.sendPushNotification(
                envWithoutApiKey,
                'user-123',
                { title: 'Test', message: 'Test', faxId: 'fax-123', status: 'delivered', recipientNumber: '+1234567890' }
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('OneSignal REST API Key not configured');
        });

        it('should return error when user ID is not provided', async () => {
            const result = await notificationService.sendPushNotification(
                mockEnv,
                null,
                { title: 'Test', message: 'Test', faxId: 'fax-123', status: 'delivered', recipientNumber: '+1234567890' }
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('User ID not provided');
        });

        it('should send notification successfully with correct payload', async () => {
            const userId = 'user-123';
            const notification = {
                title: 'Fax Delivered!',
                message: 'Your fax was delivered successfully.',
                faxId: 'fax-456',
                status: 'delivered',
                recipientNumber: '+1234567890'
            };

            // Setup mock response with proper headers
            const mockHeaders = new Headers();
            mockHeaders.set('content-type', 'application/json');
            global.fetch.mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: mockHeaders,
                json: () => Promise.resolve({ id: 'notification-123', recipients: 1 })
            });

            const result = await notificationService.sendPushNotification(mockEnv, userId, notification);

            expect(result.success).toBe(true);
            expect(global.fetch).toHaveBeenCalledWith(
                'https://onesignal.com/api/v1/notifications',
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Authorization': 'Basic test-api-key',
                        'Content-Type': 'application/json'
                    }
                })
            );

            const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(requestBody.app_id).toBe('test-app-id');
            expect(requestBody.include_external_user_ids).toEqual([userId]);
            expect(requestBody.contents.en).toBe(notification.message);
            expect(requestBody.headings.en).toBe(notification.title);
            expect(requestBody.data.fax_id).toBe(notification.faxId);
            expect(requestBody.data.status).toBe(notification.status);
            expect(requestBody.data.recipient_number).toBe(notification.recipientNumber);
            expect(requestBody.data.deep_link).toBe('sendfaxapp://fax/fax-456');
        });

        it('should handle OneSignal API errors gracefully', async () => {
            const mockHeaders = new Headers();
            mockHeaders.set('content-type', 'application/json');
            global.fetch.mockResolvedValue({
                ok: false,
                status: 400,
                statusText: 'Bad Request',
                headers: mockHeaders,
                json: () => Promise.resolve({ errors: ['Invalid player id'] })
            });

            const result = await notificationService.sendPushNotification(
                mockEnv,
                'user-123',
                { title: 'Test', message: 'Test', faxId: 'fax-123', status: 'delivered', recipientNumber: '+1234567890' }
            );

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(400);
        });
    });

    describe('sendFaxStatusNotification', () => {
        it('should send delivered notification with correct message', async () => {
            const fax = {
                id: 'fax-123',
                user_id: 'user-456',
                status: 'delivered',
                recipients: ['+1234567890']
            };

            await notificationService.sendFaxStatusNotification(mockEnv, fax);

            expect(global.fetch).toHaveBeenCalled();
            const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(requestBody.headings.en).toBe('Fax Delivered!');
            expect(requestBody.contents.en).toContain('delivered successfully');
        });

        it('should send failed notification with error message', async () => {
            const fax = {
                id: 'fax-123',
                user_id: 'user-456',
                status: 'failed',
                recipients: ['+1234567890'],
                error_message: 'Line busy'
            };

            await notificationService.sendFaxStatusNotification(mockEnv, fax);

            expect(global.fetch).toHaveBeenCalled();
            const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(requestBody.headings.en).toBe('Fax Failed');
            expect(requestBody.contents.en).toContain('could not be delivered');
            expect(requestBody.contents.en).toContain('Line busy');
        });

        it('should return error for invalid fax data', async () => {
            const result = await notificationService.sendFaxStatusNotification(mockEnv, null);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Invalid fax data');
        });

        it('should return error for fax without user_id', async () => {
            const fax = {
                id: 'fax-123',
                status: 'delivered',
                recipients: ['+1234567890']
            };

            const result = await notificationService.sendFaxStatusNotification(mockEnv, fax);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Invalid fax data');
        });
    });

    describe('formatPhoneNumber', () => {
        it('should format US phone numbers correctly', () => {
            const formatted = notificationService.formatPhoneNumber('+12125551234');
            expect(formatted).toBe('+1 (212) 555-1234');
        });

        it('should return international numbers as-is', () => {
            const formatted = notificationService.formatPhoneNumber('+442071234567');
            expect(formatted).toBe('+442071234567');
        });

        it('should handle null/undefined input', () => {
            expect(notificationService.formatPhoneNumber(null)).toBe('Unknown');
            expect(notificationService.formatPhoneNumber(undefined)).toBe('Unknown');
        });

        it('should handle non-string input', () => {
            expect(notificationService.formatPhoneNumber(12345)).toBe('Unknown');
        });
    });

    describe('createNotificationService', () => {
        it('should create a NotificationService instance', () => {
            const service = createNotificationService(mockLogger);
            expect(service).toBeInstanceOf(NotificationService);
        });
    });
});
