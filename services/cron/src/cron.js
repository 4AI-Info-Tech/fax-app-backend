/**
 * SendFax Pro - Cron Service
 * Handles scheduled tasks for fax status polling, cleanup, and maintenance
 */

import { Logger, NotifyreApiUtils, NOTIFYRE_STATUS_MAP, DatabaseUtils, mapNotifyreStatus } from './utils.js';

export default {
	/**
	 * Handle scheduled events (cron triggers)
	 * @param {Event} event - Scheduled event
	 * @param {object} env - Environment variables  
	 * @param {object} ctx - Execution context
	 */
	async scheduled(event, env, ctx) {
		const logger = new Logger(env);
		
		try {
			logger.log('INFO', 'Scheduled cron job triggered', {
				scheduledTime: event.scheduledTime,
				cron: event.cron,
				type: event.type
			});

			// Determine which task to run based on cron schedule
			const cronExpression = event.cron;
			
			if (cronExpression === '* * * * *') {
				// Every minute - fetch faxes from last 12 hours and update Supabase
				// Note: Consider changing to "* * * * *" (every minute) to avoid rate limiting
				await handleFaxStatusPolling(env, logger);
			} else if (cronExpression === '0 0 * * *') {
				// Daily at midnight - reset monthly credits for annual subscriptions
				await handleMonthlyCreditReset(env, logger);
				// Also process scheduled user anonymizations
				await handleUserAnonymization(env, logger);
			} else if (cronExpression === '0 */6 * * *') {
				// Every 6 hours - process scheduled user anonymizations
				await handleUserAnonymization(env, logger);
			} else {
				logger.log('WARN', 'Unknown cron schedule', { cronExpression });
			}

			logger.log('INFO', 'Scheduled cron job completed successfully');

		} catch (error) {
			logger.log('ERROR', 'Error in scheduled cron job', {
				error: error.message,
				stack: error.stack,
				scheduledTime: event.scheduledTime,
				cron: event.cron
			});
		}
	},

	/**
	 * Handle fetch requests (for health checks or manual triggers)
	 * @param {Request} request - Incoming request
	 * @param {object} env - Environment variables
	 * @param {object} ctx - Execution context
	 */
	async fetch(request, env, ctx) {
		const logger = new Logger(env);
		const url = new URL(request.url);

		try {
			if (url.pathname === '/health') {
				return new Response(JSON.stringify({
					status: 'healthy',
					service: 'cron',
					timestamp: new Date().toISOString(),
					version: '1.0.0'
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
			}

			if (url.pathname === '/trigger/fax-polling') {
				// Manual trigger for fax status polling
				logger.log('INFO', 'Manual fax polling trigger received');
				await handleFaxStatusPolling(env, logger);
				return new Response(JSON.stringify({
					message: 'Fax status polling completed',
					timestamp: new Date().toISOString()
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
			}

			if (url.pathname === '/trigger/cleanup') {
				// Manual trigger for cleanup
				logger.log('INFO', 'Manual cleanup trigger received');
				await handleDailyCleanup(env, logger);
				return new Response(JSON.stringify({
					message: 'Cleanup completed',
					timestamp: new Date().toISOString()
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
			}

			if (url.pathname === '/trigger/reset-monthly-credits') {
				// Manual trigger for monthly credit reset
				logger.log('INFO', 'Manual monthly credit reset trigger received');
				await handleMonthlyCreditReset(env, logger);
				return new Response(JSON.stringify({
					message: 'Monthly credit reset completed',
					timestamp: new Date().toISOString()
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
			}

			if (url.pathname === '/trigger/anonymize-users') {
				// Manual trigger for user anonymization
				logger.log('INFO', 'Manual user anonymization trigger received');
				const result = await handleUserAnonymization(env, logger);
				return new Response(JSON.stringify({
					message: 'User anonymization completed',
					result,
					timestamp: new Date().toISOString()
				}), {
					headers: { 'Content-Type': 'application/json' }
				});
			}

			return new Response('SendFax Pro - Cron Service', {
				headers: { 'Content-Type': 'text/plain' }
			});

		} catch (error) {
			logger.log('ERROR', 'Error handling fetch request', {
				error: error.message,
				path: url.pathname,
				method: request.method
			});

			return new Response(JSON.stringify({
				error: 'Internal server error',
				message: error.message
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
};
/**
 * Handle fax status polling - get faxes from last 12 hours and update Supabase
 * @param {object} env - Environment variables
 * @param {Logger} logger - Logger instance
 */
async function handleFaxStatusPolling(env, logger) {
	logger.log('INFO', 'Starting fax status polling for last 12 hours');

	try {
		// Get API key
		const apiKey = env.NOTIFYRE_API_KEY;
		if (!apiKey) {
			logger.log('ERROR', 'NOTIFYRE_API_KEY not configured');
			return;
		}

		// Get faxes from last 12 hours from Notifyre API
		const faxesFromNotifyre = await NotifyreApiUtils.getFaxesFromLast12Hours(apiKey, logger);
		
		if (faxesFromNotifyre.length === 0) {
			logger.log('INFO', 'No faxes found from last 12 hours');
			return;
		}

		logger.log('INFO', 'Processing fax status updates from Notifyre', {
			faxCount: faxesFromNotifyre.length
		});

		let updated = 0;
		let errors = 0;

		// Process each fax from Notifyre
		for (const faxDetails of faxesFromNotifyre) {
			try {
							// Map status and prepare update data
			const mappedStatus = mapNotifyreStatus(faxDetails.status, logger);
				
				const updateData = {
					status: mappedStatus,
					original_status: faxDetails.status,
					pages: faxDetails.pages || 1,
					cost: faxDetails.cost || null,
					error_message: faxDetails.failedMessage || faxDetails.errorMessage || null,
					completed_at: faxDetails.completedAt || null,
					metadata: {
						...faxDetails,
						pollingTimestamp: new Date().toISOString(),
						source: 'cron-polling'
					}
				};

				// Update in database by notifyre_fax_id
				const updatedRecord = await DatabaseUtils.updateFaxRecord(
					faxDetails.id, 
					updateData, 
					env, 
					logger
				);

				if (updatedRecord) {
					updated++;
					logger.log('DEBUG', 'Updated fax status', {
						faxId: faxDetails.id,
						newStatus: mappedStatus,
						pages: faxDetails.pages,
						cost: faxDetails.cost
					});
				}

			} catch (error) {
				errors++;
				logger.log('ERROR', 'Failed to update fax status', {
					faxId: faxDetails.id,
					error: error.message
				});
			}

			// Add small delay to avoid rate limiting
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		logger.log('INFO', 'Fax status polling completed', {
			totalProcessed: faxesFromNotifyre.length,
			updated,
			errors
		});

	} catch (error) {
		logger.log('ERROR', 'Error in fax status polling', {
			error: error.message,
			stack: error.stack
		});
	}
}

/**
 * Handle daily cleanup tasks
 * @param {object} env - Environment variables
 * @param {Logger} logger - Logger instance
 */
async function handleDailyCleanup(env, logger) {
	logger.log('INFO', 'Starting daily cleanup tasks');

	try {
		// Add cleanup logic here if needed
		// For now, just log that the cleanup was called
		logger.log('INFO', 'Daily cleanup completed - no tasks implemented yet');

	} catch (error) {
		logger.log('ERROR', 'Error in daily cleanup', {
			error: error.message,
			stack: error.stack
		});
	}
}

/**
 * Handle monthly credit reset for annual subscriptions
 * Resets credits_used to 0 and updates billing period for annual subscriptions
 * that have passed their billing_period_end date
 * @param {object} env - Environment variables
 * @param {Logger} logger - Logger instance
 */
async function handleMonthlyCreditReset(env, logger) {
	logger.log('INFO', 'Starting monthly credit reset for annual subscriptions');

	try {
		if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
			logger.log('ERROR', 'Supabase not configured for monthly credit reset');
			return;
		}

		const { createClient } = await import('@supabase/supabase-js');
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
			auth: {
				autoRefreshToken: false,
				persistSession: false
			}
		});

		const now = new Date();
		const today = now.toISOString().split('T')[0]; // YYYY-MM-DD format

		// Find annual subscriptions with expired billing periods
		// Annual subscriptions typically have "annual", "yearly", or "year" in product_id
		const { data: expiredBillingPeriods, error: fetchError } = await supabase
			.from('user_subscriptions')
			.select(`
				id,
				user_id,
				product_id,
				credit_limit,
				billing_period_start,
				billing_period_end,
				products!inner(product_id)
			`)
			.eq('is_active', true)
			.not('billing_period_end', 'is', null)
			.lte('billing_period_end', today)
			.or('product_id.ilike.%annual%,product_id.ilike.%yearly%,product_id.ilike.%year%');

		if (fetchError) {
			logger.log('ERROR', 'Failed to fetch subscriptions for monthly reset', {
				error: fetchError.message
			});
			return;
		}

		if (!expiredBillingPeriods || expiredBillingPeriods.length === 0) {
			logger.log('INFO', 'No annual subscriptions found with expired billing periods');
			return;
		}

		logger.log('INFO', 'Found annual subscriptions with expired billing periods', {
			count: expiredBillingPeriods.length
		});

		let resetCount = 0;
		let errorCount = 0;

		// Reset each subscription's credits and update billing period
		for (const subscription of expiredBillingPeriods) {
			try {
				const oldPeriodEnd = new Date(subscription.billing_period_end);
				const newPeriodStart = new Date(oldPeriodEnd);
				newPeriodStart.setDate(newPeriodStart.getDate() + 1); // Start of next month
				
				const newPeriodEnd = new Date(newPeriodStart);
				newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1); // End of next month

				// Call the database function to reset credits
				const { data: resetResult, error: resetError } = await supabase
					.rpc('reset_subscription_credits', {
						p_user_id: subscription.user_id,
						p_new_credit_limit: subscription.credit_limit,
						p_billing_start: newPeriodStart.toISOString().split('T')[0],
						p_billing_end: newPeriodEnd.toISOString().split('T')[0]
					});

				if (resetError) {
					logger.log('ERROR', 'Failed to reset subscription credits', {
						subscriptionId: subscription.id,
						userId: subscription.user_id,
						error: resetError.message
					});
					errorCount++;
				} else if (resetResult) {
					resetCount++;
					logger.log('INFO', 'Reset monthly credits for annual subscription', {
						subscriptionId: subscription.id,
						userId: subscription.user_id,
						productId: subscription.product_id,
						creditLimit: subscription.credit_limit,
						newPeriodStart: newPeriodStart.toISOString().split('T')[0],
						newPeriodEnd: newPeriodEnd.toISOString().split('T')[0]
					});
				}
			} catch (error) {
				logger.log('ERROR', 'Error resetting subscription credits', {
					subscriptionId: subscription.id,
					error: error.message
				});
				errorCount++;
			}
		}

		logger.log('INFO', 'Monthly credit reset completed', {
			totalFound: expiredBillingPeriods.length,
			resetCount,
			errorCount
		});

	} catch (error) {
		logger.log('ERROR', 'Error in monthly credit reset', {
			error: error.message,
			stack: error.stack
		});
	}
}

/**
 * Handle user anonymization - process users whose scheduled deletion time has passed
 * This function:
 * 1. Finds users with scheduled_deletion_at <= NOW() and is_anonymized = false
 * 2. For each user, anonymizes their data (deletes contacts, nullifies fax user_id)
 * 3. Marks the profile as anonymized
 * 4. Deletes the auth user
 * @param {object} env - Environment variables
 * @param {Logger} logger - Logger instance
 * @returns {object} Results of the anonymization process
 */
async function handleUserAnonymization(env, logger) {
	logger.log('INFO', 'Starting scheduled user anonymization');

	try {
		if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
			logger.log('ERROR', 'Supabase not configured for user anonymization');
			return { success: false, processed: 0, message: 'Supabase not configured' };
		}

		const { createClient } = await import('@supabase/supabase-js');
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
			auth: {
				autoRefreshToken: false,
				persistSession: false
			}
		});

		// Find users scheduled for deletion whose time has passed
		const { data: usersToAnonymize, error: fetchError } = await supabase
			.from('profiles')
			.select('id, scheduled_deletion_at')
			.eq('is_anonymized', false)
			.not('scheduled_deletion_at', 'is', null)
			.lte('scheduled_deletion_at', new Date().toISOString());

		if (fetchError) {
			logger.log('ERROR', 'Failed to fetch users for anonymization', {
				error: fetchError.message
			});
			return { success: false, processed: 0, message: fetchError.message };
		}

		if (!usersToAnonymize || usersToAnonymize.length === 0) {
			logger.log('INFO', 'No users scheduled for anonymization');
			return { success: true, processed: 0, message: 'No users to anonymize' };
		}

		logger.log('INFO', 'Found users scheduled for anonymization', {
			count: usersToAnonymize.length
		});

		let successCount = 0;
		let errorCount = 0;
		const results = [];

		// Process each user
		for (const user of usersToAnonymize) {
			try {
				logger.log('INFO', 'Anonymizing user', { userId: user.id });

				// Call the database function to anonymize user data
				const { data: anonymizeResult, error: anonymizeError } = await supabase
					.rpc('anonymize_user', { p_user_id: user.id });

				if (anonymizeError) {
					logger.log('ERROR', 'Failed to anonymize user data', {
						userId: user.id,
						error: anonymizeError.message
					});
					errorCount++;
					results.push({
						userId: user.id,
						success: false,
						error: anonymizeError.message
					});
					continue;
				}

				const result = anonymizeResult?.[0] || {};

				if (!result.success) {
					logger.log('ERROR', 'User anonymization returned failure', {
						userId: user.id,
						message: result.message
					});
					errorCount++;
					results.push({
						userId: user.id,
						success: false,
						error: result.message
					});
					continue;
				}

				// Delete the auth user after successful data anonymization
				const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);

				if (deleteError) {
					logger.log('ERROR', 'Failed to delete auth user after anonymization', {
						userId: user.id,
						error: deleteError.message
					});
					// Data is already anonymized, so we count this as partial success
					results.push({
						userId: user.id,
						success: true,
						authDeleted: false,
						contactsDeleted: result.contacts_deleted,
						faxesAnonymized: result.faxes_anonymized,
						error: `Auth deletion failed: ${deleteError.message}`
					});
					successCount++;
				} else {
					logger.log('INFO', 'User fully anonymized and deleted', {
						userId: user.id,
						contactsDeleted: result.contacts_deleted,
						faxesAnonymized: result.faxes_anonymized,
						subscriptionsDeleted: result.subscriptions_deleted,
						freeCreditsDeleted: result.free_credits_deleted
					});
					results.push({
						userId: user.id,
						success: true,
						authDeleted: true,
						contactsDeleted: result.contacts_deleted,
						faxesAnonymized: result.faxes_anonymized,
						subscriptionsDeleted: result.subscriptions_deleted,
						freeCreditsDeleted: result.free_credits_deleted
					});
					successCount++;
				}

			} catch (error) {
				logger.log('ERROR', 'Error processing user anonymization', {
					userId: user.id,
					error: error.message
				});
				errorCount++;
				results.push({
					userId: user.id,
					success: false,
					error: error.message
				});
			}
		}

		logger.log('INFO', 'User anonymization completed', {
			totalProcessed: usersToAnonymize.length,
			successCount,
			errorCount
		});

		return {
			success: true,
			processed: usersToAnonymize.length,
			successCount,
			errorCount,
			results
		};

	} catch (error) {
		logger.log('ERROR', 'Error in user anonymization', {
			error: error.message,
			stack: error.stack
		});
		return { success: false, processed: 0, message: error.message };
	}
}
