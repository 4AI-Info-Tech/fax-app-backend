/**
 * Database utilities for Management Service
 */

import { createClient } from '@supabase/supabase-js';

export class DatabaseUtils {
	/**
	 * Get Supabase admin client for direct database access
	 * @param {Object} env - Environment variables
	 * @returns {Object} Supabase client
	 */
	static getSupabaseAdminClient(env) {
		if (!env.SUPABASE_SERVICE_ROLE_KEY) {
			throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for backend operations');
		}
		
		console.log(`[DatabaseUtils] Creating Supabase admin client - Using SERVICE_ROLE key (RLS BYPASSED - Admin Access)`);
		
		return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
	}

	/**
	 * Save webhook event to database
	 * @param {Object} webhookData - Webhook data to save
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object|null} Saved webhook data or null
	 */
	static async saveWebhookEvent(webhookData, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot save webhook event');
				return null;
			}

			const supabase = this.getSupabaseAdminClient(env);

			const webhookRecord = {
				type: webhookData.type,
				payload: webhookData.payload,
				headers: webhookData.headers,
				received_at: webhookData.received_at,
				processed: false,
				created_at: new Date().toISOString()
			};

			const { data: savedWebhook, error } = await supabase
				.from('webhook_events')
				.insert(webhookRecord)
				.select()
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to save webhook event to database', {
					error: error.message,
					code: error.code,
					type: webhookData.type
				});
				throw error;
			}

			logger.log('INFO', 'Webhook event saved successfully to database', {
				webhookId: savedWebhook.id,
				type: savedWebhook.type,
				receivedAt: savedWebhook.received_at
			});

			return savedWebhook;

		} catch (error) {
			logger.log('ERROR', 'Error saving webhook event to database', {
				error: error.message,
				type: webhookData?.type
			});
			return null;
		}
	}

	/**
	 * Get user information
	 * @param {string} userId - User ID
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object|null} User data or null
	 */
	static async getUser(userId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get user');
				return null;
			}

			const supabase = this.getSupabaseAdminClient(env);

			const { data: user, error } = await supabase
				.from('users')
				.select('*')
				.eq('id', userId)
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to get user from database', {
					error: error.message,
					code: error.code,
					userId
				});
				return null;
			}

			logger.log('INFO', 'User retrieved successfully', {
				userId: user.id
			});

			return user;

		} catch (error) {
			logger.log('ERROR', 'Error getting user from database', {
				error: error.message,
				userId
			});
			return null;
		}
	}

	/**
	 * Get system statistics
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object} System statistics
	 */
	static async getSystemStats(env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get system stats');
				return null;
			}

			const supabase = this.getSupabaseAdminClient(env);

			// Get total users count
			const { count: totalUsers, error: usersError } = await supabase
				.from('users')
				.select('*', { count: 'exact', head: true });

			if (usersError) {
				logger.log('ERROR', 'Failed to get users count', {
					error: usersError.message
				});
			}

			// Get total faxes count
			const { count: totalFaxes, error: faxesError } = await supabase
				.from('faxes')
				.select('*', { count: 'exact', head: true });

			if (faxesError) {
				logger.log('ERROR', 'Failed to get faxes count', {
					error: faxesError.message
				});
			}

			// Get total webhook events count
			const { count: totalWebhooks, error: webhooksError } = await supabase
				.from('webhook_events')
				.select('*', { count: 'exact', head: true });

			if (webhooksError) {
				logger.log('ERROR', 'Failed to get webhook events count', {
					error: webhooksError.message
				});
			}

			const stats = {
				totalUsers: totalUsers || 0,
				totalFaxes: totalFaxes || 0,
				totalWebhooks: totalWebhooks || 0,
				timestamp: new Date().toISOString()
			};

			logger.log('INFO', 'System statistics retrieved successfully', stats);

			return stats;

		} catch (error) {
			logger.log('ERROR', 'Error getting system statistics', {
				error: error.message
			});
			return null;
		}
	}

	/**
	 * Get usage summary for a user
	 * @param {string} userId - User ID
	 * @param {Object} options - Query options (period: 'daily', 'weekly', 'monthly', 'all_time')
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object} Usage summary statistics
	 * _Requirements: 13.1, 13.2, 13.3_
	 */
	static async getUserUsageSummary(userId, options = {}, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get usage summary');
				return null;
			}

			const supabase = this.getSupabaseAdminClient(env);
			const period = options.period || 'all_time';

			// Calculate start date based on period
			let startDate = null;
			const now = new Date();
			
			switch (period) {
				case 'daily':
					startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
					break;
				case 'weekly':
					const dayOfWeek = now.getDay();
					startDate = new Date(now);
					startDate.setDate(now.getDate() - dayOfWeek);
					startDate.setHours(0, 0, 0, 0);
					break;
				case 'monthly':
					startDate = new Date(now.getFullYear(), now.getMonth(), 1);
					break;
				case 'all_time':
				default:
					startDate = null;
					break;
			}

			// Build query for faxes
			let query = supabase
				.from('faxes')
				.select('id, pages, status, created_at')
				.eq('user_id', userId)
				.order('created_at', { ascending: false });

			if (startDate) {
				query = query.gte('created_at', startDate.toISOString());
			}

			const { data: faxes, error: faxesError } = await query;

			if (faxesError) {
				logger.log('ERROR', 'Failed to get user faxes for usage summary', {
					error: faxesError.message,
					userId
				});
				return {
					error: faxesError.message,
					totalFaxesSent: 0,
					totalPagesUsed: 0,
					successfulFaxes: 0,
					failedFaxes: 0,
					successRate: 0,
					period,
					periodStartDate: startDate ? startDate.toISOString() : null,
					periodEndDate: now.toISOString()
				};
			}

			// Calculate statistics
			const totalFaxesSent = faxes.length;
			const totalPagesUsed = faxes.reduce((sum, fax) => sum + (fax.pages || 0), 0);
			const successfulFaxes = faxes.filter(fax => fax.status === 'delivered').length;
			const failedFaxes = faxes.filter(fax => fax.status === 'failed').length;
			const successRate = totalFaxesSent > 0 
				? (successfulFaxes / totalFaxesSent) * 100 
				: 0;

			const summary = {
				totalFaxesSent,
				totalPagesUsed,
				successfulFaxes,
				failedFaxes,
				successRate: Math.round(successRate * 100) / 100, // Round to 2 decimal places
				period,
				periodStartDate: startDate ? startDate.toISOString() : null,
				periodEndDate: now.toISOString()
			};

			logger.log('INFO', 'Usage summary retrieved successfully', {
				userId,
				period,
				totalFaxesSent,
				totalPagesUsed,
				successRate: summary.successRate
			});

			return summary;

		} catch (error) {
			logger.log('ERROR', 'Error getting usage summary', {
				error: error.message,
				userId
			});
			return null;
		}
	}

	/**
	 * Get recent activity
	 * @param {Object} options - Query options
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Array} Recent activity data
	 */
	static async getRecentActivity(options = {}, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get recent activity');
				return [];
			}

			const supabase = this.getSupabaseAdminClient(env);
			const limit = options.limit || 50;

			// Get recent faxes
			const { data: recentFaxes, error: faxesError } = await supabase
				.from('faxes')
				.select('*')
				.order('sent_at', { ascending: false })
				.limit(limit);

			if (faxesError) {
				logger.log('ERROR', 'Failed to get recent faxes', {
					error: faxesError.message
				});
			}

			// Get recent webhook events
			const { data: recentWebhooks, error: webhooksError } = await supabase
				.from('webhook_events')
				.select('*')
				.order('received_at', { ascending: false })
				.limit(limit);

			if (webhooksError) {
				logger.log('ERROR', 'Failed to get recent webhook events', {
					error: webhooksError.message
				});
			}

			const faxActivity = (recentFaxes || []).map(fax => ({
				type: 'fax',
				id: fax.id,
				userId: fax.user_id,
				status: fax.status,
				timestamp: fax.sent_at,
				recipients: fax.recipients
			}));

			const webhookActivity = (recentWebhooks || []).map(webhook => ({
				type: 'webhook',
				id: webhook.id,
				webhookType: webhook.type,
				timestamp: webhook.received_at,
				processed: webhook.processed
			}));

			// Combine and sort by timestamp
			const allActivity = [...faxActivity, ...webhookActivity]
				.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
				.slice(0, limit);

			logger.log('INFO', 'Recent activity retrieved successfully', {
				count: allActivity.length
			});

			return allActivity;

		} catch (error) {
			logger.log('ERROR', 'Error getting recent activity', {
				error: error.message
			});
			return [];
		}
	}

	/**
	 * Schedule user account for deletion (7 days from now)
	 * @param {string} userId - User ID
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object} Result with success status and scheduled date
	 */
	static async scheduleUserDeletion(userId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot schedule user deletion');
				return { success: false, message: 'Database not configured' };
			}

			const supabase = this.getSupabaseAdminClient(env);

			const { data, error } = await supabase
				.rpc('schedule_user_deletion', { p_user_id: userId });

			if (error) {
				logger.log('ERROR', 'Failed to schedule user deletion', {
					error: error.message,
					code: error.code,
					userId
				});
				return { success: false, message: error.message };
			}

			if (!data || data.length === 0) {
				return { success: false, message: 'No result from database function' };
			}

			const result = data[0];
			logger.log('INFO', 'User deletion scheduled', {
				userId,
				success: result.success,
				scheduledAt: result.scheduled_at,
				message: result.message
			});

			return {
				success: result.success,
				scheduledAt: result.scheduled_at,
				message: result.message
			};

		} catch (error) {
			logger.log('ERROR', 'Error scheduling user deletion', {
				error: error.message,
				userId
			});
			return { success: false, message: error.message };
		}
	}

	/**
	 * Cancel scheduled user account deletion
	 * @param {string} userId - User ID
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object} Result with success status
	 */
	static async cancelUserDeletion(userId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot cancel user deletion');
				return { success: false, message: 'Database not configured' };
			}

			const supabase = this.getSupabaseAdminClient(env);

			const { data, error } = await supabase
				.rpc('cancel_user_deletion', { p_user_id: userId });

			if (error) {
				logger.log('ERROR', 'Failed to cancel user deletion', {
					error: error.message,
					code: error.code,
					userId
				});
				return { success: false, message: error.message };
			}

			if (!data || data.length === 0) {
				return { success: false, message: 'No result from database function' };
			}

			const result = data[0];
			logger.log('INFO', 'User deletion cancellation result', {
				userId,
				success: result.success,
				message: result.message
			});

			return {
				success: result.success,
				message: result.message
			};

		} catch (error) {
			logger.log('ERROR', 'Error cancelling user deletion', {
				error: error.message,
				userId
			});
			return { success: false, message: error.message };
		}
	}

	/**
	 * Get user account deletion status
	 * @param {string} userId - User ID
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object} Deletion status
	 */
	static async getUserDeletionStatus(userId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get deletion status');
				return { isScheduled: false, isAnonymized: false };
			}

			const supabase = this.getSupabaseAdminClient(env);

			const { data, error } = await supabase
				.rpc('get_user_deletion_status', { p_user_id: userId });

			if (error) {
				logger.log('ERROR', 'Failed to get user deletion status', {
					error: error.message,
					code: error.code,
					userId
				});
				return { isScheduled: false, isAnonymized: false, error: error.message };
			}

			if (!data || data.length === 0) {
				return { isScheduled: false, isAnonymized: false };
			}

			const result = data[0];
			logger.log('INFO', 'User deletion status retrieved', {
				userId,
				isScheduled: result.is_scheduled,
				scheduledAt: result.scheduled_at,
				isAnonymized: result.is_anonymized,
				daysRemaining: result.days_remaining
			});

			return {
				isScheduled: result.is_scheduled,
				scheduledAt: result.scheduled_at,
				isAnonymized: result.is_anonymized,
				daysRemaining: result.days_remaining
			};

		} catch (error) {
			logger.log('ERROR', 'Error getting user deletion status', {
				error: error.message,
				userId
			});
			return { isScheduled: false, isAnonymized: false, error: error.message };
		}
	}

	/**
	 * Process all scheduled anonymizations (for cron job)
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object} Processing results
	 */
	static async processScheduledAnonymizations(env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot process anonymizations');
				return { success: false, processed: 0, message: 'Database not configured' };
			}

			const supabase = this.getSupabaseAdminClient(env);

			const { data, error } = await supabase
				.rpc('process_scheduled_anonymizations');

			if (error) {
				logger.log('ERROR', 'Failed to process scheduled anonymizations', {
					error: error.message,
					code: error.code
				});
				return { success: false, processed: 0, message: error.message };
			}

			const results = data || [];
			const successCount = results.filter(r => r.success).length;
			const failedCount = results.filter(r => !r.success).length;

			logger.log('INFO', 'Scheduled anonymizations processed', {
				totalProcessed: results.length,
				successCount,
				failedCount,
				results: results.map(r => ({
					userId: r.user_id,
					success: r.success,
					contactsDeleted: r.contacts_deleted,
					faxesAnonymized: r.faxes_anonymized
				}))
			});

			return {
				success: true,
				processed: results.length,
				successCount,
				failedCount,
				results
			};

		} catch (error) {
			logger.log('ERROR', 'Error processing scheduled anonymizations', {
				error: error.message
			});
			return { success: false, processed: 0, message: error.message };
		}
	}

	/**
	 * Delete auth user after anonymization
	 * @param {string} userId - User ID to delete
	 * @param {Object} env - Environment variables
	 * @param {Logger} logger - Logger instance
	 * @returns {Object} Deletion result
	 */
	static async deleteAuthUser(userId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot delete auth user');
				return { success: false, message: 'Database not configured' };
			}

			const supabase = this.getSupabaseAdminClient(env);

			const { error } = await supabase.auth.admin.deleteUser(userId);

			if (error) {
				logger.log('ERROR', 'Failed to delete auth user', {
					error: error.message,
					userId
				});
				return { success: false, message: error.message };
			}

			logger.log('INFO', 'Auth user deleted successfully', { userId });
			return { success: true };

		} catch (error) {
			logger.log('ERROR', 'Error deleting auth user', {
				error: error.message,
				userId
			});
			return { success: false, message: error.message };
		}
	}
} 
