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
        this.logger.log('DEBUG', 'sendPushNotification called', {
            userId,
            notification: {
                faxId: notification?.faxId,
                status: notification?.status,
                title: notification?.title,
                message: notification?.message?.substring(0, 100), // Truncate long messages
                recipientNumber: notification?.recipientNumber
            }
        });

        try {
            // Validate required environment variables
            this.logger.log('DEBUG', 'Validating environment variables', {
                hasAppId: !!env.ONESIGNAL_APP_ID,
                hasApiKey: !!env.ONESIGNAL_REST_API_KEY,
                appIdLength: env.ONESIGNAL_APP_ID?.length || 0,
                apiKeyLength: env.ONESIGNAL_REST_API_KEY?.length || 0
            });

            if (!env.ONESIGNAL_APP_ID) {
                this.logger.log('WARN', 'OneSignal App ID not configured, skipping push notification', {
                    userId,
                    faxId: notification?.faxId
                });
                return { success: false, error: 'OneSignal App ID not configured' };
            }

            if (!env.ONESIGNAL_REST_API_KEY) {
                this.logger.log('WARN', 'OneSignal REST API Key not configured, skipping push notification', {
                    userId,
                    faxId: notification?.faxId
                });
                return { success: false, error: 'OneSignal REST API Key not configured' };
            }

            if (!userId) {
                this.logger.log('WARN', 'User ID not provided, skipping push notification', {
                    faxId: notification?.faxId,
                    notificationProvided: !!notification
                });
                return { success: false, error: 'User ID not provided' };
            }

            // Validate notification object
            if (!notification) {
                this.logger.log('WARN', 'Notification object not provided', { userId });
                return { success: false, error: 'Notification object not provided' };
            }

            // Ensure userId is a string (convert UUID if needed)
            let userIdString = typeof userId === 'string' ? userId : String(userId);
            
            // Normalize UUID to uppercase for OneSignal external_user_id matching
            // OneSignal's external_user_id matching is case-sensitive, and the iOS app
            // sets it in uppercase format (e.g., "3C16173C-8B0C-4F77-898D-F984021C7CC9")
            // PostgreSQL stores UUIDs in lowercase, so we need to convert to uppercase
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (uuidRegex.test(userIdString)) {
                // Convert UUID to uppercase to match OneSignal's external_user_id format
                userIdString = userIdString.toUpperCase();
                this.logger.log('DEBUG', 'Normalized user ID to uppercase for OneSignal', {
                    original: userId,
                    normalized: userIdString
                });
            } else {
                this.logger.log('WARN', 'User ID does not match UUID format - OneSignal may reject if external_user_id not set', {
                    userId: userIdString,
                    faxId: notification?.faxId,
                    note: 'This may be expected in test environments'
                });
                // Don't block - let OneSignal handle validation
            }

            // Build the notification payload
            const payload = {
                app_id: env.ONESIGNAL_APP_ID,
                include_external_user_ids: [userIdString],
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

            this.logger.log('DEBUG', 'Built OneSignal payload', {
                userId: userIdString,
                faxId: notification.faxId,
                status: notification.status,
                payloadSize: JSON.stringify(payload).length,
                payloadPreview: {
                    app_id: payload.app_id,
                    external_user_ids: payload.include_external_user_ids,
                    title: payload.headings.en,
                    messageLength: payload.contents.en?.length || 0,
                    dataKeys: Object.keys(payload.data)
                }
            });

            this.logger.log('DEBUG', 'Sending push notification via OneSignal', {
                userId: userIdString,
                faxId: notification.faxId,
                status: notification.status,
                apiUrl: this.oneSignalApiUrl,
                timestamp: new Date().toISOString()
            });

            // OneSignal REST API v1 uses Basic auth
            // Format: Authorization: Basic <REST_API_KEY>
            // Note: OneSignal accepts the REST API Key directly (some implementations base64 encode it)
            // We'll use the key directly as per OneSignal's common practice
            const authHeader = `Basic ${env.ONESIGNAL_REST_API_KEY}`;
            
            this.logger.log('DEBUG', 'Prepared OneSignal API request', {
                userId: userIdString,
                faxId: notification.faxId,
                apiUrl: this.oneSignalApiUrl,
                hasAuthHeader: !!authHeader,
                authHeaderPrefix: authHeader.substring(0, 10) + '...' // Log partial header for security
            });

            const requestStartTime = Date.now();
            const response = await fetch(this.oneSignalApiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const requestDuration = Date.now() - requestStartTime;
            this.logger.log('DEBUG', 'OneSignal API request completed', {
                userId: userIdString,
                faxId: notification.faxId,
                statusCode: response.status,
                statusText: response.statusText,
                durationMs: requestDuration,
                headers: Object.fromEntries(response.headers.entries())
            });

            // Parse response - handle both JSON and text responses
            let responseData;
            try {
                const contentType = response.headers?.get?.('content-type') || '';
                if (contentType.includes('application/json')) {
                    responseData = await response.json();
                } else {
                    const textResponse = await response.text();
                    this.logger.log('WARN', 'OneSignal API returned non-JSON response', {
                        userId: userIdString,
                        faxId: notification.faxId,
                        statusCode: response.status,
                        responseText: textResponse.substring(0, 500)
                    });
                    responseData = { error: textResponse };
                }
            } catch (parseError) {
                // If response parsing fails, try to get text
                try {
                    const textResponse = await response.text();
                    responseData = { error: textResponse || 'Failed to parse response' };
                } catch (textError) {
                    this.logger.log('ERROR', 'Failed to parse OneSignal API response', {
                        userId: userIdString,
                        faxId: notification.faxId,
                        parseError: parseError.message,
                        textError: textError.message
                    });
                    responseData = { error: 'Failed to parse response' };
                }
            }

            this.logger.log('DEBUG', 'OneSignal API response received', {
                userId: userIdString,
                faxId: notification.faxId,
                responseStatus: response.status,
                responseData: {
                    id: responseData.id,
                    recipients: responseData.recipients,
                    errors: responseData.errors,
                    invalid_external_user_ids: responseData.invalid_external_user_ids,
                    hasErrors: !!responseData.errors,
                    hasInvalidUserIds: !!responseData.invalid_external_user_ids
                }
            });

            // Check for invalid external user IDs (user not found in OneSignal)
            if (responseData.invalid_external_user_ids && responseData.invalid_external_user_ids.length > 0) {
                this.logger.log('WARN', 'OneSignal returned invalid external user IDs', {
                    userId: userIdString,
                    faxId: notification.faxId,
                    invalidUserIds: responseData.invalid_external_user_ids,
                    message: 'User may not have OneSignal external_user_id set. Ensure OneSignal.login() is called in the app.'
                });
            }

            if (!response.ok) {
                this.logger.log('ERROR', 'OneSignal API returned error', {
                    userId: userIdString,
                    faxId: notification.faxId,
                    status: response.status,
                    statusText: response.statusText,
                    error: responseData.errors || responseData.error || responseData,
                    invalid_external_user_ids: responseData.invalid_external_user_ids,
                    fullResponse: responseData,
                    requestDurationMs: requestDuration
                });
                return {
                    success: false,
                    error: responseData.errors || responseData.error || 'OneSignal API error',
                    statusCode: response.status,
                    invalid_external_user_ids: responseData.invalid_external_user_ids
                };
            }

            // Check if notification was actually sent (recipients > 0)
            const recipientCount = responseData.recipients || 0;
            if (recipientCount === 0) {
                this.logger.log('WARN', 'OneSignal API returned success but no recipients', {
                    userId: userIdString,
                    faxId: notification.faxId,
                    oneSignalId: responseData.id,
                    invalid_external_user_ids: responseData.invalid_external_user_ids,
                    message: 'Notification may not have been delivered. Check if external_user_id is set correctly.'
                });
            }

            this.logger.log('INFO', 'Push notification sent successfully', {
                userId: userIdString,
                faxId: notification.faxId,
                status: notification.status,
                oneSignalId: responseData.id,
                recipients: responseData.recipients,
                recipientCount: recipientCount,
                requestDurationMs: requestDuration,
                timestamp: new Date().toISOString()
            });

            return {
                success: true,
                id: responseData.id,
                recipients: responseData.recipients
            };

        } catch (error) {
            this.logger.log('ERROR', 'Error sending push notification', {
                error: error.message,
                errorStack: error.stack,
                errorName: error.name,
                userId: typeof userId === 'string' ? userId : String(userId),
                faxId: notification?.faxId,
                notificationProvided: !!notification,
                notificationKeys: notification ? Object.keys(notification) : []
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
        this.logger.log('DEBUG', 'sendFaxStatusNotification called', {
            faxId: fax?.id,
            userId: fax?.user_id,
            status: fax?.status,
            hasRecipients: Array.isArray(fax?.recipients),
            recipientCount: Array.isArray(fax?.recipients) ? fax.recipients.length : 0,
            hasErrorMessage: !!fax?.error_message,
            errorMessage: fax?.error_message?.substring(0, 200) // Truncate long error messages
        });

        try {
            if (!fax || !fax.user_id) {
                this.logger.log('WARN', 'Invalid fax data for notification', {
                    faxProvided: !!fax,
                    hasUserId: !!fax?.user_id,
                    faxKeys: fax ? Object.keys(fax) : [],
                    faxData: fax
                });
                return { success: false, error: 'Invalid fax data' };
            }

            this.logger.log('DEBUG', 'Fetching user notification preferences', {
                userId: fax.user_id,
                faxId: fax.id
            });

            // Check if user has notifications enabled
            const userPreferences = await this.getUserNotificationPreferences(env, fax.user_id);
            
            this.logger.log('DEBUG', 'User notification preferences retrieved', {
                userId: fax.user_id,
                faxId: fax.id,
                hasPreferences: !!userPreferences,
                preferences: userPreferences ? {
                    fax_delivered_enabled: userPreferences.fax_delivered_enabled,
                    fax_failed_enabled: userPreferences.fax_failed_enabled
                } : null
            });
            
            const isSuccess = fax.status === 'delivered';
            this.logger.log('DEBUG', 'Determined notification type', {
                userId: fax.user_id,
                faxId: fax.id,
                faxStatus: fax.status,
                isSuccess,
                notificationType: isSuccess ? 'delivered' : 'failed'
            });
            
            // Check user preferences for this notification type
            if (isSuccess && userPreferences && !userPreferences.fax_delivered_enabled) {
                this.logger.log('DEBUG', 'User has disabled delivered notifications', {
                    userId: fax.user_id,
                    faxId: fax.id,
                    preferences: userPreferences
                });
                return { success: false, skipped: true, reason: 'User disabled delivered notifications' };
            }
            
            if (!isSuccess && userPreferences && !userPreferences.fax_failed_enabled) {
                this.logger.log('DEBUG', 'User has disabled failed notifications', {
                    userId: fax.user_id,
                    faxId: fax.id,
                    preferences: userPreferences
                });
                return { success: false, skipped: true, reason: 'User disabled failed notifications' };
            }

            // Format recipient number for display
            const recipientNumber = Array.isArray(fax.recipients) && fax.recipients.length > 0
                ? fax.recipients[0]
                : 'Unknown';

            this.logger.log('DEBUG', 'Processing recipient number', {
                userId: fax.user_id,
                faxId: fax.id,
                rawRecipientNumber: recipientNumber,
                recipientCount: Array.isArray(fax.recipients) ? fax.recipients.length : 0,
                allRecipients: fax.recipients
            });

            const formattedNumber = this.formatPhoneNumber(recipientNumber);
            this.logger.log('DEBUG', 'Formatted phone number', {
                userId: fax.user_id,
                faxId: fax.id,
                original: recipientNumber,
                formatted: formattedNumber
            });

            // Build notification content
            const notification = {
                faxId: fax.id,
                status: fax.status,
                recipientNumber: recipientNumber,
                title: isSuccess ? 'Fax Delivered!' : 'Fax Failed',
                message: isSuccess
                    ? `Your fax to ${formattedNumber} was delivered successfully.`
                    : `Your fax to ${formattedNumber} could not be delivered.${fax.error_message ? ` Reason: ${fax.error_message}` : ''}`
            };

            this.logger.log('DEBUG', 'Built notification object', {
                userId: fax.user_id,
                faxId: fax.id,
                notification: {
                    faxId: notification.faxId,
                    status: notification.status,
                    title: notification.title,
                    messageLength: notification.message.length,
                    recipientNumber: notification.recipientNumber
                }
            });

            const result = await this.sendPushNotification(env, fax.user_id, notification);
            
            this.logger.log('DEBUG', 'sendFaxStatusNotification completed', {
                userId: fax.user_id,
                faxId: fax.id,
                result: {
                    success: result.success,
                    skipped: result.skipped,
                    error: result.error,
                    oneSignalId: result.id
                }
            });

            return result;

        } catch (error) {
            this.logger.log('ERROR', 'Error sending fax status notification', {
                error: error.message,
                errorStack: error.stack,
                errorName: error.name,
                faxId: fax?.id,
                userId: fax?.user_id,
                faxProvided: !!fax,
                faxKeys: fax ? Object.keys(fax) : []
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
        this.logger.log('DEBUG', 'getUserNotificationPreferences called', {
            userId,
            hasSupabaseUrl: !!env.SUPABASE_URL,
            hasServiceRoleKey: !!env.SUPABASE_SERVICE_ROLE_KEY,
            supabaseUrlLength: env.SUPABASE_URL?.length || 0,
            serviceRoleKeyLength: env.SUPABASE_SERVICE_ROLE_KEY?.length || 0
        });

        try {
            if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
                this.logger.log('DEBUG', 'Supabase not configured, using default notification preferences', {
                    userId,
                    hasSupabaseUrl: !!env.SUPABASE_URL,
                    hasServiceRoleKey: !!env.SUPABASE_SERVICE_ROLE_KEY
                });
                return null;
            }

            this.logger.log('DEBUG', 'Creating Supabase client', {
                userId,
                supabaseUrl: env.SUPABASE_URL.substring(0, 30) + '...' // Log partial URL for debugging
            });

            const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
                auth: {
                    autoRefreshToken: false,
                    persistSession: false
                }
            });

            this.logger.log('DEBUG', 'Querying user_notification_settings table', {
                userId,
                table: 'user_notification_settings'
            });

            const queryStartTime = Date.now();
            const { data, error } = await supabase
                .from('user_notification_settings')
                .select('*')
                .eq('user_id', userId)
                .single();

            const queryDuration = Date.now() - queryStartTime;

            this.logger.log('DEBUG', 'Supabase query completed', {
                userId,
                queryDurationMs: queryDuration,
                hasError: !!error,
                errorCode: error?.code,
                errorMessage: error?.message,
                hasData: !!data,
                dataKeys: data ? Object.keys(data) : []
            });

            if (error) {
                if (error.code === 'PGRST116') {
                    // No preferences found - use defaults (all enabled)
                    this.logger.log('DEBUG', 'No notification preferences found for user, using defaults', {
                        userId,
                        errorCode: error.code,
                        queryDurationMs: queryDuration
                    });
                    return null;
                }
                this.logger.log('ERROR', 'Error fetching notification preferences', {
                    error: error.message,
                    errorCode: error.code,
                    errorDetails: error.details,
                    errorHint: error.hint,
                    userId,
                    queryDurationMs: queryDuration
                });
                return null;
            }

            this.logger.log('DEBUG', 'User notification preferences retrieved successfully', {
                userId,
                preferences: data,
                queryDurationMs: queryDuration
            });

            return data;

        } catch (error) {
            this.logger.log('ERROR', 'Error getting user notification preferences', {
                error: error.message,
                errorStack: error.stack,
                errorName: error.name,
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
        this.logger.log('DEBUG', 'formatPhoneNumber called', {
            phoneNumber,
            type: typeof phoneNumber,
            isString: typeof phoneNumber === 'string',
            length: phoneNumber?.length
        });

        if (!phoneNumber || typeof phoneNumber !== 'string') {
            this.logger.log('DEBUG', 'Invalid phone number input, returning Unknown', {
                phoneNumber,
                type: typeof phoneNumber
            });
            return 'Unknown';
        }

        // Remove all non-digit characters except +
        const cleaned = phoneNumber.replace(/[^\d+]/g, '');
        this.logger.log('DEBUG', 'Cleaned phone number', {
            original: phoneNumber,
            cleaned,
            cleanedLength: cleaned.length
        });
        
        // If it's a US number (starts with +1 and has 11 digits)
        if (cleaned.startsWith('+1') && cleaned.length === 12) {
            const areaCode = cleaned.slice(2, 5);
            const firstPart = cleaned.slice(5, 8);
            const lastPart = cleaned.slice(8);
            const formatted = `+1 (${areaCode}) ${firstPart}-${lastPart}`;
            this.logger.log('DEBUG', 'Formatted US phone number', {
                original: phoneNumber,
                cleaned,
                formatted
            });
            return formatted;
        }

        // Return as-is for international numbers
        this.logger.log('DEBUG', 'Phone number not US format, returning as-is', {
            original: phoneNumber,
            cleaned,
            isUSFormat: cleaned.startsWith('+1') && cleaned.length === 12
        });
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
