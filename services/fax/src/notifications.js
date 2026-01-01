/**
 * Push Notification Service for Fax Status Updates
 * Integrates with OneSignal REST API to send push notifications to iOS app users
 */

import { createClient } from '@supabase/supabase-js';

/**
 * OneSignal notification service for sending push notifications
 */
export class NotificationService {
    constructor(logger) {
        this.logger = logger;
        this.oneSignalApiUrl = 'https://onesignal.com/api/v1/notifications';
    }

    /**
     * Send a push notification via OneSignal REST API
     * @param {Object} env - Environment variables containing OneSignal credentials
     * @param {string} userId - Supabase user ID (used as external_user_id in OneSignal)
     * @param {Object} notification - Notification payload
     * @param {string} notification.title - Notification title
     * @param {string} notification.message - Notification body message
     * @param {string} notification.faxId - Fax ID for deep linking
     * @param {string} notification.status - Fax status (delivered/failed)
     * @param {string} notification.recipientNumber - Recipient fax number
     * @returns {Promise<Object>} OneSignal API response
     */
    async sendPushNotification(env, userId, notification) {
        try {
            // Validate required environment variables
            if (!env.ONESIGNAL_APP_ID) {
                this.logger.log('WARN', 'OneSignal App ID not configured, skipping push notification');
                return { success: false, error: 'OneSignal App ID not configured' };
            }

            if (!env.ONESIGNAL_REST_API_KEY) {
                this.logger.log('WARN', 'OneSignal REST API Key not configured, skipping push notification');
                return { success: false, error: 'OneSignal REST API Key not configured' };
            }

            if (!userId) {
                this.logger.log('WARN', 'User ID not provided, skipping push notification');
                return { success: false, error: 'User ID not provided' };
            }

            // Build the notification payload
            const payload = {
                app_id: env.ONESIGNAL_APP_ID,
                include_external_user_ids: [userId],
                contents: { en: notification.message },
                headings: { en: notification.title },
                data: {
                    fax_id: notification.faxId,
                    status: notification.status,
                    recipient_number: notification.recipientNumber,
                    deep_link: `sendfaxapp://fax/${notification.faxId}`
                },
                ios_badgeType: 'Increase',
                ios_badgeCount: 1
            };

            this.logger.log('DEBUG', 'Sending push notification via OneSignal', {
                userId,
                faxId: notification.faxId,
                status: notification.status
            });

            const response = await fetch(this.oneSignalApiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${env.ONESIGNAL_REST_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const responseData = await response.json();

            if (!response.ok) {
                this.logger.log('ERROR', 'OneSignal API returned error', {
                    status: response.status,
                    error: responseData.errors || responseData
                });
                return {
                    success: false,
                    error: responseData.errors || 'OneSignal API error',
                    statusCode: response.status
                };
            }

            this.logger.log('INFO', 'Push notification sent successfully', {
                userId,
                faxId: notification.faxId,
                oneSignalId: responseData.id,
                recipients: responseData.recipients
            });

            return {
                success: true,
                id: responseData.id,
                recipients: responseData.recipients
            };

        } catch (error) {
            this.logger.log('ERROR', 'Error sending push notification', {
                error: error.message,
                userId,
                faxId: notification?.faxId
            });
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Send fax status notification based on fax delivery status
     * @param {Object} env - Environment variables
     * @param {Object} fax - Fax record with status information
     * @param {string} fax.id - Internal fax ID
     * @param {string} fax.user_id - User ID who sent the fax
     * @param {string} fax.status - Fax status (delivered/failed)
     * @param {Array<string>} fax.recipients - Array of recipient numbers
     * @param {string} [fax.error_message] - Error message if fax failed
     * @returns {Promise<Object>} Notification send result
     */
    async sendFaxStatusNotification(env, fax) {
        try {
            if (!fax || !fax.user_id) {
                this.logger.log('WARN', 'Invalid fax data for notification', { fax });
                return { success: false, error: 'Invalid fax data' };
            }

            // Check if user has notifications enabled
            const userPreferences = await this.getUserNotificationPreferences(env, fax.user_id);
            
            const isSuccess = fax.status === 'delivered';
            
            // Check user preferences for this notification type
            if (isSuccess && userPreferences && !userPreferences.fax_delivered_enabled) {
                this.logger.log('DEBUG', 'User has disabled delivered notifications', {
                    userId: fax.user_id
                });
                return { success: false, skipped: true, reason: 'User disabled delivered notifications' };
            }
            
            if (!isSuccess && userPreferences && !userPreferences.fax_failed_enabled) {
                this.logger.log('DEBUG', 'User has disabled failed notifications', {
                    userId: fax.user_id
                });
                return { success: false, skipped: true, reason: 'User disabled failed notifications' };
            }

            // Format recipient number for display
            const recipientNumber = Array.isArray(fax.recipients) && fax.recipients.length > 0
                ? fax.recipients[0]
                : 'Unknown';

            // Build notification content
            const notification = {
                faxId: fax.id,
                status: fax.status,
                recipientNumber: recipientNumber,
                title: isSuccess ? 'Fax Delivered!' : 'Fax Failed',
                message: isSuccess
                    ? `Your fax to ${this.formatPhoneNumber(recipientNumber)} was delivered successfully.`
                    : `Your fax to ${this.formatPhoneNumber(recipientNumber)} could not be delivered.${fax.error_message ? ` Reason: ${fax.error_message}` : ''}`
            };

            return await this.sendPushNotification(env, fax.user_id, notification);

        } catch (error) {
            this.logger.log('ERROR', 'Error sending fax status notification', {
                error: error.message,
                faxId: fax?.id,
                userId: fax?.user_id
            });
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get user's notification preferences from Supabase
     * @param {Object} env - Environment variables
     * @param {string} userId - User ID
     * @returns {Promise<Object|null>} User notification preferences or null
     */
    async getUserNotificationPreferences(env, userId) {
        try {
            if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
                this.logger.log('DEBUG', 'Supabase not configured, using default notification preferences');
                return null;
            }

            const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            });

            const { data, error } = await supabase
                .from('user_notification_settings')
                .select('*')
                .eq('user_id', userId)
                .single();

            if (error) {
                if (error.code === 'PGRST116') {
                    // No preferences found - use defaults (all enabled)
                    this.logger.log('DEBUG', 'No notification preferences found for user, using defaults', {
                        userId
                    });
                    return null;
                }
                this.logger.log('ERROR', 'Error fetching notification preferences', {
                    error: error.message,
                    userId
                });
                return null;
            }

            return data;

        } catch (error) {
            this.logger.log('ERROR', 'Error getting user notification preferences', {
                error: error.message,
                userId
            });
            return null;
        }
    }

    /**
     * Format phone number for display in notifications
     * @param {string} phoneNumber - Phone number to format
     * @returns {string} Formatted phone number
     */
    formatPhoneNumber(phoneNumber) {
        if (!phoneNumber || typeof phoneNumber !== 'string') {
            return 'Unknown';
        }

        // Remove all non-digit characters except +
        const cleaned = phoneNumber.replace(/[^\d+]/g, '');
        
        // If it's a US number (starts with +1 and has 11 digits)
        if (cleaned.startsWith('+1') && cleaned.length === 12) {
            const areaCode = cleaned.slice(2, 5);
            const firstPart = cleaned.slice(5, 8);
            const lastPart = cleaned.slice(8);
            return `+1 (${areaCode}) ${firstPart}-${lastPart}`;
        }

        // Return as-is for international numbers
        return phoneNumber;
    }

    /**
     * Build a notification payload with all required fields
     * This is useful for testing and validation
     * @param {Object} params - Notification parameters
     * @param {string} params.faxId - Fax ID
     * @param {string} params.status - Fax status
     * @param {string} params.recipientNumber - Recipient phone number
     * @param {string} params.title - Notification title
     * @param {string} params.message - Notification message
     * @returns {Object} Complete notification payload
     */
    buildNotificationPayload(params) {
        return {
            faxId: params.faxId || null,
            status: params.status || null,
            recipientNumber: params.recipientNumber || null,
            title: params.title || '',
            message: params.message || '',
            deepLink: params.faxId ? `sendfaxapp://fax/${params.faxId}` : null
        };
    }

    /**
     * Validate that a notification payload has all required fields
     * @param {Object} payload - Notification payload to validate
     * @returns {Object} Validation result with isValid and missingFields
     */
    validateNotificationPayload(payload) {
        const requiredFields = ['faxId', 'status', 'recipientNumber', 'deepLink'];
        const missingFields = [];

        for (const field of requiredFields) {
            if (!payload || payload[field] === null || payload[field] === undefined) {
                missingFields.push(field);
            }
        }

        return {
            isValid: missingFields.length === 0,
            missingFields
        };
    }
}

/**
 * Create a NotificationService instance
 * @param {Object} logger - Logger instance
 * @returns {NotificationService} Notification service instance
 */
export function createNotificationService(logger) {
    return new NotificationService(logger);
}
