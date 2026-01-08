/**
 * Database utilities for Supabase integration
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

	static async saveFaxRecord(faxData, userId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, skipping fax record save');
				return null;
			}

			const supabase = this.getSupabaseAdminClient(env);

			const metadata = {
				...(faxData.providerResponse || faxData.notifyreResponse || {}),
				friendlyId: faxData.friendlyId || null
			};

			// Check if the sender number is in our own numbers table
			const isFromMobileApp = await FaxDatabaseUtils.isOwnNumber(faxData.senderId, env, logger);

			const faxRecord = {
				user_id: userId,
				status: faxData.status || 'queued',
				original_status: faxData.originalStatus || faxData.status || 'queued',
				recipients: faxData.recipients || [],
				sender_id: faxData.senderId || null,
				subject: faxData.subject || null,
				pages: faxData.pages || 0,
				document_count: faxData.document_count || 1,
				cost: faxData.cost || null,
				client_reference: faxData.clientReference || 'SendFaxPro',
				sent_at: faxData.sentAt || new Date().toISOString(),
				completed_at: faxData.completedAt || null,
				error_message: faxData.errorMessage || null,
				metadata: metadata,
				provider_fax_id: faxData.providerFaxId || faxData.id || null,
				is_from_mobile_app: isFromMobileApp
			};

			const { data: recordedFaxData, error } = await supabase
				.from('faxes')
				.insert(faxRecord)
				.select()
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to save fax record to database', {
					error: error.message,
					code: error.code,
					faxId: faxRecord.provider_fax_id
				});
				throw error;
			}

			
			logger.log('INFO', 'Fax record saved successfully to database', {
				recordId: recordedFaxData.id,
				providerFaxId: recordedFaxData.provider_fax_id,
				userId: recordedFaxData.user_id
			});

			return recordedFaxData;

		} catch (error) {
			logger.log('ERROR', 'Error saving fax record to database', {
				error: error.message,
				faxId: faxData?.id,
				userId: userId
			});
			return null;
		}
	}

	static async updateFaxRecord(faxId, updateData, env, logger, idType = 'provider_fax_id') {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, skipping fax record update');
				return null;
			}

			const supabase = this.getSupabaseAdminClient(env);

			logger.log('DEBUG', 'Updating fax record in database', {
				faxId,
				idType,
				updateFields: Object.keys(updateData)
			});

			const dataToUpdate = {
				...updateData,
				updated_at: new Date().toISOString()
			};

			const { data, error } = await supabase
				.from('faxes')
				.update(dataToUpdate)
				.eq(idType, faxId)
				.select()
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to update fax record in database', {
					error: error.message,
					code: error.code,
					faxId,
					idType
				});
				return null;
			}

			if (!data) {
				logger.log('WARN', 'Fax record not found in database, skipping update', {
					faxId,
					idType,
					message: 'This fax may not have been sent through our system'
				});
				return null;
			}

			logger.log('INFO', 'Fax record updated successfully in database', {
				recordId: data.id,
				faxId: data.provider_fax_id || data.id,
				idType
			});

			return data;

		} catch (error) {
			logger.log('ERROR', 'Error updating fax record in database', {
				error: error.message,
				faxId,
				idType
			});
			return null;
		}
	}

	static async listUserFaxes(userId, options, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('ERROR', 'Supabase not configured');
				return {
					error: "Database not configured",
					message: "Unable to retrieve fax records"
				};
			}

			const { limit = 50, offset = 0, status, fromDate, toDate } = options;
			const supabase = this.getSupabaseAdminClient(env);

			let query = supabase
				.from('faxes')
				.select('*')
				.eq('user_id', userId)
				.order('created_at', { ascending: false })
				.range(offset, offset + limit - 1);

			if (status) {
				query = query.eq('status', status);
			}
			if (fromDate) {
				query = query.gte('created_at', fromDate);
			}
			if (toDate) {
				query = query.lte('created_at', toDate);
			}

			const { data: faxes, error, count } = await query;

			if (error) {
				logger.log('ERROR', 'Failed to retrieve user faxes', {
					error: error.message,
					userId
				});
				return {
					error: "Failed to retrieve fax records",
					message: error.message
				};
			}

			logger.log('INFO', 'User faxes retrieved successfully', {
				userId,
				count: faxes.length,
				limit,
				offset
			});

			return {
				faxes: faxes || [],
				total: count || faxes.length,
				limit: parseInt(limit),
				offset: parseInt(offset)
			};

		} catch (error) {
			logger.log('ERROR', 'Error in listUserFaxes:', error);
			return {
				error: "Failed to retrieve user fax records",
				message: error.message
			};
		}
	}

	static async storeWebhookEvent(webhookData, env, logger) {
		try {
			const supabase = this.getSupabaseAdminClient(env);

			const { error } = await supabase
				.from('fax_webhook_events')
				.insert({
					event_type: webhookData.event,
					fax_id: webhookData.faxId,
					data: webhookData.processedData,
					raw_payload: webhookData.rawPayload,
					processed_at: new Date().toISOString()
				});

			if (error) {
				logger.log('ERROR', 'Failed to store webhook event', { error: error.message });
				return null;
			}

			logger.log('DEBUG', 'Webhook event stored successfully', { 
				event: webhookData.event,
				faxId: webhookData.faxId 
			});

			return true;
		} catch (error) {
			logger.log('ERROR', 'Error storing webhook event', { error: error.message });
			return null;
		}
	}

	static async recordUsage(usageData, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, skipping usage recording');
				return null;
			}

			const supabase = this.getSupabaseAdminClient(env);

			const usageRecord = {
				user_id: usageData.userId,
				type: usageData.type,
				unit_type: usageData.unitType,
				usage_amount: usageData.usageAmount,
				timestamp: usageData.timestamp || new Date().toISOString(),
				metadata: usageData.metadata || {}
			};

			logger.log('DEBUG', 'Recording usage', {
				userId: usageData.userId,
				type: usageData.type,
				unitType: usageData.unitType,
				usageAmount: usageData.usageAmount
			});

			const { data, error } = await supabase
				.from('usage')
				.insert(usageRecord)
				.select()
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to record usage', {
					error: error.message,
					usageData
				});
				return null;
			}

			logger.log('INFO', 'Usage recorded successfully', {
				usageId: data.id,
				userId: data.user_id,
				type: data.type,
				usageAmount: data.usage_amount
			});

			return data;
		} catch (error) {
			logger.log('ERROR', 'Error recording usage', {
				error: error.message,
				usageData
			});
			return null;
		}
	}

	static async saveReceivedFax(receivedFaxData, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, skipping received fax save');
				return null;
			}

			const supabase = this.getSupabaseAdminClient(env);

			// Check if the sender number is in our own numbers table
			const isFromMobileApp = await FaxDatabaseUtils.isOwnNumber(receivedFaxData.fromNumber, env, logger);

			const receivedFaxRecord = {
				webhook_id: receivedFaxData.webhookId,
				from_number: receivedFaxData.fromNumber,
				page_count: receivedFaxData.pageCount || 1,
				media_url: receivedFaxData.mediaUrl,
				original_media_url: receivedFaxData.originalMediaUrl || null,
				received_at: receivedFaxData.receivedAt || new Date().toISOString(),
				is_from_mobile_app: isFromMobileApp
			};

			const { data: recordedReceivedFax, error } = await supabase
				.from('free_fax_receives')
				.insert(receivedFaxRecord)
				.select()
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to save received fax record to database', {
					error: error.message,
					code: error.code,
					webhookId: receivedFaxData.webhookId
				});
				throw error;
			}

			logger.log('INFO', 'Received fax record saved successfully to database', {
				recordId: recordedReceivedFax.id,
				webhookId: recordedReceivedFax.webhook_id,
				fromNumber: recordedReceivedFax.from_number,
				pageCount: recordedReceivedFax.page_count
			});

			return recordedReceivedFax;

		} catch (error) {
			logger.log('ERROR', 'Error saving received fax record to database', {
				error: error.message,
				webhookId: receivedFaxData?.webhookId
			});
			return null;
		}
	}
}

export class FaxDatabaseUtils {
	/**
	 * Get Supabase admin client for direct database access
	 * @param {Object} env - Environment variables
	 * @returns {Object} Supabase client
	 */
	static getSupabaseAdminClient(env) {
		if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
			throw new Error('Supabase configuration missing');
		}

		return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
			auth: {
				autoRefreshToken: false,
				persistSession: false
			}
		});
	}

	/**
	 * Check if user has enough credits to send fax
	 * @param {string} userId - User ID
	 * @param {number} pagesRequired - Number of pages required for the fax
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object>} Credit check result
	 */
	static async checkUserCredits(userId, pagesRequired, env, logger) {
		try {
			if (!userId) {
				return {
					hasCredits: false,
					error: 'User ID is required',
					availablePages: 0,
					subscriptionId: null
				};
			}

			const supabase = this.getSupabaseAdminClient(env);

			// Get user's active subscriptions
			const { data: subscriptions, error: subError } = await supabase
				.from('user_subscriptions')
				.select(`
					id,
					product_id,
					credit_limit,
					credits_used,
					expires_at,
					is_active
				`)
				.eq('user_id', userId)
				.eq('is_active', true)
				.gt('expires_at', new Date().toISOString())
				.order('created_at', { ascending: false });

			if (subError) {
				logger.log('ERROR', 'Failed to fetch user subscriptions', {
					error: subError.message,
					userId: userId
				});
				return {
					hasCredits: false,
					error: 'Failed to check user credits',
					availablePages: 0,
					subscriptionId: null
				};
			}

			if (!subscriptions || subscriptions.length === 0) {
				return {
					hasCredits: false,
					error: 'No active subscriptions found',
					availablePages: 0,
					subscriptionId: null
				};
			}

			// Calculate total available pages across all subscriptions
			let totalAvailablePages = 0;
			let primarySubscription = null;

			for (const subscription of subscriptions) {
				const availableCredits = subscription.credit_limit - subscription.credits_used;
				if (availableCredits > 0) {
					totalAvailablePages += availableCredits;
					if (!primarySubscription) {
						primarySubscription = subscription;
					}
				}
			}

			const hasCredits = totalAvailablePages >= pagesRequired;

			logger.log('INFO', 'Credit check completed', {
				userId: userId,
				pagesRequired: pagesRequired,
				totalAvailablePages: totalAvailablePages,
				hasCredits: hasCredits,
				subscriptionCount: subscriptions.length
			});

			return {
				hasCredits: hasCredits,
				availablePages: totalAvailablePages,
				subscriptionId: primarySubscription?.id || null,
				subscriptions: subscriptions,
				error: null
			};

		} catch (error) {
			logger.log('ERROR', 'Error checking user credits', {
				error: error.message,
				userId: userId,
				pagesRequired: pagesRequired
			});
			return {
				hasCredits: false,
				error: error.message,
				availablePages: 0,
				subscriptionId: null
			};
		}
	}

	/**
	 * Update user's credit usage after fax is delivered (called from webhook handlers)
	 * Note: This method is now only used when faxes are confirmed delivered via webhooks.
	 * Usage is no longer recorded immediately upon fax submission to avoid counting failed faxes.
	 * @param {string} userId - User ID
	 * @param {number} creditsUsed - Number of credits used
	 * @param {string} subscriptionId - Subscription ID to update
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object>} Update result
	 */
	static async updatePageUsage(userId, creditsUsed, subscriptionId, env, logger) {
		try {
			const supabase = this.getSupabaseAdminClient(env);

			// First get the current subscription to calculate new credits_used
			const { data: currentSubscription, error: fetchError } = await supabase
				.from('user_subscriptions')
				.select('credits_used')
				.eq('id', subscriptionId)
				.eq('user_id', userId)
				.single();

			if (fetchError) {
				logger.log('ERROR', 'Failed to fetch current subscription', {
					error: fetchError.message,
					userId: userId,
					subscriptionId: subscriptionId
				});
				return {
					success: false,
					error: fetchError.message
				};
			}

			const newCreditsUsed = (currentSubscription.credits_used || 0) + creditsUsed;

			// Update the primary subscription's credits_used
			const { data: updatedSubscription, error: updateError } = await supabase
				.from('user_subscriptions')
				.update({ 
					credits_used: newCreditsUsed,
					updated_at: new Date().toISOString()
				})
				.eq('id', subscriptionId)
				.eq('user_id', userId)
				.select()
				.single();

			if (updateError) {
				logger.log('ERROR', 'Failed to update credit usage', {
					error: updateError.message,
					userId: userId,
					subscriptionId: subscriptionId,
					creditsUsed: creditsUsed
				});
				return {
					success: false,
					error: updateError.message
				};
			}

			// Also record usage in the usage table for analytics
			const { error: usageError } = await supabase
				.from('usage')
				.insert({
					user_id: userId,
					type: 'fax',
					unit_type: 'page',
					usage_amount: creditsUsed,
					metadata: {
						subscription_id: subscriptionId,
						action: 'fax_sent'
					}
				});

			if (usageError) {
				logger.log('WARN', 'Failed to record usage analytics', {
					error: usageError.message,
					userId: userId,
					creditsUsed: creditsUsed
				});
				// Don't fail the operation if analytics recording fails
			}

			logger.log('INFO', 'Credit usage updated successfully', {
				userId: userId,
				subscriptionId: subscriptionId,
				creditsUsed: creditsUsed,
				newCreditsUsed: updatedSubscription.credits_used
			});

			return {
				success: true,
				updatedSubscription: updatedSubscription
			};

		} catch (error) {
			logger.log('ERROR', 'Error updating credit usage', {
				error: error.message,
				userId: userId,
				subscriptionId: subscriptionId,
				creditsUsed: creditsUsed
			});
			return {
				success: false,
				error: error.message
			};
		}
	}

	/**
	 * Get user's fax usage statistics
	 * @param {string} userId - User ID
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object>} Usage statistics
	 */
	static async getUserFaxUsage(userId, env, logger) {
		try {
			const supabase = this.getSupabaseAdminClient(env);

			// Get successful faxes (non-failed) for the user
			const { data: faxes, error: faxError } = await supabase
				.from('faxes')
				.select('pages, status, created_at')
				.eq('user_id', userId)
				.neq('status', 'failed')
				.order('created_at', { ascending: false });

			if (faxError) {
				logger.log('ERROR', 'Failed to fetch user fax usage', {
					error: faxError.message,
					userId: userId
				});
				return {
					success: false,
					error: faxError.message,
					totalPages: 0,
					faxCount: 0
				};
			}

			const totalPages = faxes.reduce((sum, fax) => sum + (fax.pages || 0), 0);
			const faxCount = faxes.length;

			return {
				success: true,
				totalPages: totalPages,
				faxCount: faxCount,
				faxes: faxes
			};

		} catch (error) {
			logger.log('ERROR', 'Error getting user fax usage', {
				error: error.message,
				userId: userId
			});
			return {
				success: false,
				error: error.message,
				totalPages: 0,
				faxCount: 0
			};
		}
	}

	/**
	 * Check if a phone number is in our own numbers table
	 * @param {string} phoneNumber - Phone number to check (e.g., +1234567890)
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<boolean>} True if the number is in our own numbers table
	 */
	static async isOwnNumber(phoneNumber, env, logger) {
		try {
			if (!phoneNumber) {
				return false;
			}

			const supabase = this.getSupabaseAdminClient(env);

			// Check if the phone number exists in our own_numbers table
			const { data: ownNumber, error } = await supabase
				.from('own_numbers')
				.select('id')
				.eq('phone_number', phoneNumber)
				.eq('is_active', true)
				.single();

			if (error) {
				if (error.code === 'PGRST116') {
					// No rows returned - number not found
					return false;
				}
				logger.log('ERROR', 'Failed to check own number', {
					error: error.message,
					phoneNumber: phoneNumber
				});
				return false;
			}

			return !!ownNumber;

		} catch (error) {
			logger.log('ERROR', 'Error checking own number', {
				error: error.message,
				phoneNumber: phoneNumber
			});
			return false;
		}
	}

	/**
	 * Get all received faxes from the last 24 hours
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object>} List of received faxes
	 */
	static async getReceivedFaxesLast24Hours(env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot fetch received faxes');
				return {
					success: false,
					error: 'Database not configured',
					faxes: []
				};
			}

			const supabase = this.getSupabaseAdminClient(env);

			// Calculate 24 hours ago
			const twentyFourHoursAgo = new Date();
			twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

			// Get received faxes from the last 24 hours
			const { data: faxes, error } = await supabase
				.from('free_fax_receives')
				.select(`
					id,
					from_number,
					page_count,
					media_url,
					received_at,
					is_from_mobile_app,
					created_at
				`)
				.gte('received_at', twentyFourHoursAgo.toISOString())
				.order('received_at', { ascending: false });

			if (error) {
				logger.log('ERROR', 'Failed to fetch received faxes', {
					error: error.message
				});
				return {
					success: false,
					error: error.message,
					faxes: []
				};
			}

			logger.log('INFO', 'Successfully fetched received faxes from last 24 hours', {
				count: faxes.length
			});

			return {
				success: true,
				faxes: faxes
			};

		} catch (error) {
			logger.log('ERROR', 'Error fetching received faxes', {
				error: error.message
			});
			return {
				success: false,
				error: error.message,
				faxes: []
			};
		}
	}
} 
