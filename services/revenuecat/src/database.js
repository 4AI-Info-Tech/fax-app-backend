/**
 * Database utilities for RevenueCat service
 */

import { createClient } from '@supabase/supabase-js';

function toIsoOrNull(timestampMs) {
	const parsed = Number(timestampMs);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return null;
	}
	return new Date(parsed).toISOString();
}

function extractEntitlementId(event) {
	if (!event || typeof event !== 'object') {
		return null;
	}
	if (event.entitlement_id) {
		return event.entitlement_id;
	}
	if (Array.isArray(event.entitlement_ids) && event.entitlement_ids.length > 0) {
		return event.entitlement_ids[0];
	}
	return null;
}

export class DatabaseUtils {
	/**
	 * Validate if a string is a valid UUID format
	 * @param {string} str - The string to validate
	 * @returns {boolean}
	 */
	static isValidUUID(str) {
		if (!str || typeof str !== 'string') {
			return false;
		}
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		return uuidRegex.test(str);
	}

	static isSupabaseConfigured(env) {
		return Boolean(env?.SUPABASE_URL && env?.SUPABASE_SERVICE_ROLE_KEY);
	}

	static getSupabaseAdminClient(env) {
		if (!DatabaseUtils.isSupabaseConfigured(env)) {
			throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
		}
		return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
	}

	/**
	 * Store RevenueCat webhook event in database
	 * @param {Object} webhookData - The webhook data to store
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>}
	 */
	static async storeRevenueCatWebhookEvent(webhookData, env, logger) {
		try {
			if (!DatabaseUtils.isSupabaseConfigured(env)) {
				logger.log('WARN', 'Supabase not configured, skipping webhook event storage');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const event = webhookData?.event || {};

			if (event.id) {
				const existingEvent = await DatabaseUtils.checkWebhookEventExists(event.id, env, logger);
				if (existingEvent) {
					logger.log('INFO', 'Duplicate RevenueCat event detected, returning existing event', {
						eventId: event.id,
						eventType: existingEvent.event_type
					});
					return existingEvent;
				}
			}

			let userId = event.original_app_user_id || null;
			if (userId && !DatabaseUtils.isValidUUID(userId)) {
				logger.log('WARN', 'Skipping invalid UUID user id from RevenueCat event', {
					userId,
					eventType: event.type,
					eventId: event.id
				});
				userId = null;
			}

			const webhookRecord = {
				event_type: event.type || 'UNKNOWN',
				event_id: event.id || null,
				user_id: userId,
				product_id: event.product_id || null,
				entitlement_id: extractEntitlementId(event),
				period_type: event.period_type || null,
				purchased_at: toIsoOrNull(event.purchased_at_ms),
				expires_at: toIsoOrNull(event.expires_at_ms),
				environment: event.environment || null,
				store: event.store || null,
				is_trial_conversion: Boolean(event.is_trial_conversion) || false,
				price: event.price !== undefined && event.price !== null ? Number(event.price) : null,
				currency: event.currency || null,
				country_code: event.country_code || null,
				app_id: event.app_id || null,
				raw_data: webhookData,
				processed_at: new Date().toISOString()
			};

			let { data: storedEvent, error } = await supabase
				.from('revenuecat_webhook_events')
				.insert(webhookRecord)
				.select('*')
				.single();

			if (error && error.code === '23503' && String(error.message || '').includes('user_id_fkey') && webhookRecord.user_id) {
				logger.log('WARN', 'Retrying webhook insert with user_id=null due to foreign key mismatch', {
					eventId: webhookRecord.event_id,
					userId: webhookRecord.user_id
				});
				webhookRecord.user_id = null;
				const retry = await supabase
					.from('revenuecat_webhook_events')
					.insert(webhookRecord)
					.select('*')
					.single();
				storedEvent = retry.data;
				error = retry.error;
			}

			if (error && error.code === '23505' && String(error.message || '').includes('event_id')) {
				return await DatabaseUtils.checkWebhookEventExists(webhookRecord.event_id, env, logger);
			}

			if (error) {
				logger.log('ERROR', 'Failed to store RevenueCat webhook event', {
					error: error.message,
					code: error.code,
					eventType: webhookRecord.event_type,
					eventId: webhookRecord.event_id
				});
				return null;
			}

			logger.log('INFO', 'RevenueCat webhook event stored successfully', {
				eventId: storedEvent.event_id,
				eventType: storedEvent.event_type,
				userId: storedEvent.user_id
			});

			return storedEvent;
		} catch (error) {
			logger.log('ERROR', 'Error storing RevenueCat webhook event', {
				error: error.message,
				stack: error.stack,
				eventId: webhookData?.event?.id,
				eventType: webhookData?.event?.type
			});
			return null;
		}
	}

	/**
	 * Check if a webhook event has already been processed
	 * @param {string} eventId - RevenueCat event ID
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>}
	 */
	static async checkWebhookEventExists(eventId, env, logger) {
		try {
			if (!DatabaseUtils.isSupabaseConfigured(env) || !eventId) {
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const { data, error } = await supabase
				.from('revenuecat_webhook_events')
				.select('*')
				.eq('event_id', eventId)
				.single();

			if (error && error.code !== 'PGRST116') {
				logger.log('ERROR', 'Failed checking duplicate RevenueCat event', {
					eventId,
					error: error.message
				});
				return null;
			}

			return data || null;
		} catch (error) {
			logger.log('ERROR', 'Error checking webhook event existence', {
				eventId,
				error: error.message
			});
			return null;
		}
	}

	/**
	 * Transfer user data from one user to another for RevenueCat TRANSFER events.
	 * Subscription and credit state are managed by RevenueCat directly.
	 */
	static async transferUserData(fromUserId, toUserId, env, logger, transferReason = 'revenuecat_transfer') {
		try {
			if (!DatabaseUtils.isSupabaseConfigured(env)) {
				return { success: false, error: 'Supabase not configured' };
			}

			if (!fromUserId || !toUserId) {
				return { success: false, error: 'Missing user IDs' };
			}

			if (fromUserId === toUserId) {
				return { success: true, message: 'No transfer needed', fromUserId, toUserId };
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const validation = await DatabaseUtils.validateUsersForTransfer(fromUserId, toUserId, env, logger);
			if (!validation.valid) {
				return { success: false, error: validation.error };
			}

			const transferId = await DatabaseUtils.createTransferAuditRecord(fromUserId, toUserId, transferReason, env, logger);

			const transferResult = {
				success: true,
				fromUserId,
				toUserId,
				transferId,
				transferredSubscriptions: 0,
				transferredUsage: 0,
				transferredFaxes: 0,
				transferredWebhookEvents: 0,
				oldUserDeleted: false
			};

			transferResult.transferredFaxes = await DatabaseUtils.moveRowsByUserId(
				supabase,
				'faxes',
				fromUserId,
				toUserId,
				logger
			);

			transferResult.transferredUsage = await DatabaseUtils.moveRowsByUserId(
				supabase,
				'usage',
				fromUserId,
				toUserId,
				logger
			);

			transferResult.transferredWebhookEvents = await DatabaseUtils.moveRowsByUserId(
				supabase,
				'revenuecat_webhook_events',
				fromUserId,
				toUserId,
				logger
			);

			try {
				const { data: oldUser, error: userError } = await supabase.auth.admin.getUserById(fromUserId);
				if (!userError && oldUser?.user?.app_metadata?.is_anonymous === true) {
					const { error: deleteError } = await supabase.auth.admin.deleteUser(fromUserId);
					if (!deleteError) {
						transferResult.oldUserDeleted = true;
					} else {
						logger.log('WARN', 'Failed to delete anonymous source user after transfer', {
							fromUserId,
							error: deleteError.message
						});
					}
				}
			} catch (userCleanupError) {
				logger.log('WARN', 'Error while cleaning up source user after transfer', {
					fromUserId,
					error: userCleanupError.message
				});
			}

			await DatabaseUtils.updateTransferAuditRecord(transferId, {
				success: true,
				transferredSubscriptions: 0,
				transferredUsage: transferResult.transferredUsage,
				transferredFaxes: transferResult.transferredFaxes,
				oldUserDeleted: transferResult.oldUserDeleted
			}, env, logger);

			return transferResult;
		} catch (error) {
			logger.log('ERROR', 'Error in user transfer', {
				fromUserId,
				toUserId,
				error: error.message
			});
			return {
				success: false,
				error: error.message,
				fromUserId,
				toUserId
			};
		}
	}

	static async moveRowsByUserId(supabase, tableName, fromUserId, toUserId, logger) {
		const { count, error: countError } = await supabase
			.from(tableName)
			.select('*', { count: 'exact', head: true })
			.eq('user_id', fromUserId);

		if (countError) {
			logger.log('ERROR', 'Failed counting rows for transfer', {
				tableName,
				fromUserId,
				error: countError.message
			});
			throw countError;
		}

		const rowCount = count || 0;
		if (rowCount === 0) {
			return 0;
		}

		const { error: updateError } = await supabase
			.from(tableName)
			.update({ user_id: toUserId })
			.eq('user_id', fromUserId);

		if (updateError) {
			logger.log('ERROR', 'Failed moving rows for transfer', {
				tableName,
				fromUserId,
				toUserId,
				error: updateError.message
			});
			throw updateError;
		}

		return rowCount;
	}

	static async validateUsersForTransfer(fromUserId, toUserId, env, logger) {
		try {
			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const { data: fromUser, error: fromError } = await supabase.auth.admin.getUserById(fromUserId);
			if (fromError || !fromUser?.user) {
				return { valid: false, error: `Source user ${fromUserId} does not exist` };
			}

			const { data: toUser, error: toError } = await supabase.auth.admin.getUserById(toUserId);
			if (toError || !toUser?.user) {
				return { valid: false, error: `Target user ${toUserId} does not exist` };
			}

			if (toUser.user.app_metadata?.is_anonymous === true) {
				return { valid: false, error: `Cannot transfer to anonymous user ${toUserId}` };
			}

			return { valid: true };
		} catch (error) {
			logger.log('ERROR', 'Failed validating users for transfer', {
				fromUserId,
				toUserId,
				error: error.message
			});
			return { valid: false, error: error.message };
		}
	}

	static async createTransferAuditRecord(fromUserId, toUserId, transferReason, env, logger) {
		try {
			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const { data, error } = await supabase
				.from('user_transfers')
				.insert({
					from_user_id: fromUserId,
					to_user_id: toUserId,
					transfer_reason: transferReason,
					status: 'in_progress'
				})
				.select('id')
				.single();

			if (error) {
				logger.log('WARN', 'Could not create transfer audit record', {
					fromUserId,
					toUserId,
					error: error.message
				});
				return null;
			}

			return data?.id || null;
		} catch (error) {
			logger.log('WARN', 'Error creating transfer audit record', {
				fromUserId,
				toUserId,
				error: error.message
			});
			return null;
		}
	}

	static async updateTransferAuditRecord(transferId, results, env, logger) {
		try {
			if (!transferId) {
				return;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const updateData = {
				status: results.success ? 'completed' : 'failed',
				completed_at: new Date().toISOString(),
				transferred_subscriptions: results.transferredSubscriptions || 0,
				transferred_usage: results.transferredUsage || 0,
				transferred_faxes: results.transferredFaxes || 0,
				old_user_deleted: results.oldUserDeleted || false
			};

			if (!results.success && results.error) {
				updateData.error_message = results.error;
			}

			const { error } = await supabase
				.from('user_transfers')
				.update(updateData)
				.eq('id', transferId);

			if (error) {
				logger.log('WARN', 'Failed updating transfer audit record', {
					transferId,
					error: error.message
				});
			}
		} catch (error) {
			logger.log('WARN', 'Error updating transfer audit record', {
				transferId,
				error: error.message
			});
		}
	}
}
