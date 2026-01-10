/**
 * Database utilities for RevenueCat service
 */

import { createClient } from '@supabase/supabase-js';

export class DatabaseUtils {

	/**
	 * Validate if a string is a valid UUID format
	 * @param {string} str - The string to validate
	 * @returns {boolean} - Whether the string is a valid UUID
	 */
	static isValidUUID(str) {
		if (!str || typeof str !== 'string') {
			return false;
		}
		// UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (accepts all UUID versions)
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		return uuidRegex.test(str);
	}

	static getSupabaseAdminClient(env) {
		if (!env.SUPABASE_SERVICE_ROLE_KEY) {
			throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for backend operations');
		}

		console.log(`[DatabaseUtils] Creating Supabase admin client - Using SERVICE_ROLE key (RLS BYPASSED - Admin Access)`);

		return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
	}

	/**
	 * Store RevenueCat webhook event in database
	 * @param {Object} webhookData - The webhook data to store
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The stored webhook event or null if failed
	 */
	static async storeRevenueCatWebhookEvent(webhookData, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, skipping webhook event storage');
				logger.log('WARN', 'Supabase URL:', env.SUPABASE_URL);
				logger.log('WARN', 'Supabase SERVICE_ROLE_KEY:', env.SUPABASE_SERVICE_ROLE_KEY);
				throw new Error('Supabase not configured');
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			// Extract relevant information from webhook data
			const event = webhookData.event || {};

			// Check for duplicate webhook event first
			if (event.id) {
				const { data: existingEvent, error: checkError } = await supabase
					.from('revenuecat_webhook_events')
					.select('id, event_type, processed_at')
					.eq('event_id', event.id)
					.single();

				if (existingEvent && !checkError) {
					logger.log('WARN', 'Duplicate webhook event detected, skipping processing', {
						eventId: event.id,
						eventType: existingEvent.event_type,
						originalProcessedAt: existingEvent.processed_at
					});
					return existingEvent; // Return existing event to maintain idempotency
				}
			}

			// Use original_app_user_id as the user_id for foreign key connection to auth.users
			// Validate that it's a valid UUID format (RevenueCat anonymous IDs like $RCAnonymousID:... are not valid UUIDs)
			let userId = event.original_app_user_id;
			
			// Validate UUID format - PostgreSQL requires valid UUID format for UUID columns
			if (userId && !DatabaseUtils.isValidUUID(userId)) {
				logger.log('WARN', 'original_app_user_id is not a valid UUID, setting user_id to null', {
					original_app_user_id: userId,
					eventType: event.type,
					eventId: event.id
				});
				userId = null;
			}

			// Handle entitlement_id - check both single value and array
			let entitlementId = null;
			if (event.entitlement_id) {
				entitlementId = event.entitlement_id;
			} else if (event.entitlement_ids && Array.isArray(event.entitlement_ids) && event.entitlement_ids.length > 0) {
				entitlementId = event.entitlement_ids[0]; // Use first entitlement_id from array
			}

			// Calculate expiration date based on product configuration
			let expiresAt = null;
			if (event.product_id) {
				const product = await DatabaseUtils.getProductById(event.product_id, env, logger);
				if (product && event.purchased_at_ms) {
					const purchaseDate = new Date(parseInt(event.purchased_at_ms));
					expiresAt = DatabaseUtils.calculateExpirationDate(product, purchaseDate, logger);
					if (expiresAt) {
						expiresAt = expiresAt.toISOString();
					}
				}
			}

			// If we couldn't calculate expiration from product, use the webhook's expires_at if available
			if (!expiresAt && event.expires_at_ms) {
				expiresAt = new Date(parseInt(event.expires_at_ms)).toISOString();
			}

			// Sanitize and validate data before insertion
			const webhookRecord = {
				event_type: event.type || 'UNKNOWN',
				event_id: event.id || null,
				user_id: userId,
				product_id: event.product_id || null,
				entitlement_id: entitlementId,
				period_type: event.period_type || null,
				purchased_at: event.purchased_at_ms ? new Date(parseInt(event.purchased_at_ms)).toISOString() : null,
				expires_at: expiresAt,
				environment: event.environment || null,
				store: event.store || null,
				is_trial_conversion: Boolean(event.is_trial_conversion) || false,
				price: event.price ? parseFloat(event.price) : null,
				currency: event.currency || null,
				country_code: event.country_code || null,
				app_id: event.app_id || null,
				raw_data: webhookData,
				processed_at: new Date().toISOString()
			};

			logger.log('DEBUG', 'Storing RevenueCat webhook event', {
				eventType: webhookRecord.event_type,
				userId: webhookRecord.user_id,
				productId: webhookRecord.product_id,
				eventId: webhookRecord.event_id
			});

			let { data: storedEvent, error } = await supabase
				.from('revenuecat_webhook_events')
				.insert(webhookRecord)
				.select()
				.single();

			// If we get a foreign key constraint error, try again with user_id set to null
			if (error && error.code === '23503' && error.message.includes('user_id_fkey') && userId !== null) {
				logger.log('WARN', 'Foreign key constraint error for user_id, retrying with null', {
					userId: userId,
					eventType: webhookRecord.event_type
				});

				webhookRecord.user_id = null;
				const retryResult = await supabase
					.from('revenuecat_webhook_events')
					.insert(webhookRecord)
					.select()
					.single();

				storedEvent = retryResult.data;
				error = retryResult.error;
			}

			// Handle unique constraint violation (duplicate event_id)
			if (error && error.code === '23505' && error.message.includes('event_id')) {
				logger.log('WARN', 'Duplicate webhook event detected (unique constraint violation)', {
					eventId: webhookRecord.event_id,
					eventType: webhookRecord.event_type
				});
				
				// Fetch the existing event
				const { data: existingEvent, error: fetchError } = await supabase
					.from('revenuecat_webhook_events')
					.select('*')
					.eq('event_id', webhookRecord.event_id)
					.single();

				if (existingEvent && !fetchError) {
					logger.log('INFO', 'Returning existing webhook event', {
						eventId: existingEvent.event_id,
						eventType: existingEvent.event_type
					});
					return existingEvent;
				}
			}

			if (error) {
				logger.log('ERROR', 'Failed to store RevenueCat webhook event', {
					error: error.message,
					code: error.code,
					details: error.details,
					hint: error.hint,
					eventType: webhookRecord.event_type,
					userId: webhookRecord.user_id,
					eventId: webhookRecord.event_id
				});
				throw error;
			}

			logger.log('INFO', 'RevenueCat webhook event stored successfully', {
				eventId: storedEvent.id,
				eventType: storedEvent.event_type,
				userId: storedEvent.user_id
			});

			// Also create/update user subscription if this is a purchase event
			if (['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE'].includes(event.type) && userId && event.product_id) {
				try {
					// Get product information to determine page limit
					const product = await DatabaseUtils.getProductById(event.product_id, env, logger);
					if (product) {
						// Handle consumables (non-renewing purchases) differently
						if (event.type === 'NON_RENEWING_PURCHASE' && product.type === 'limited-usage') {
							// For consumables, add pages to existing subscription or create new one
							await DatabaseUtils.addConsumablePages(userId, event.product_id, product.credit_limit || 0, env, logger);
							logger.log('INFO', 'Consumable credits added from webhook', {
								userId: userId,
								productId: event.product_id,
								creditsAdded: product.credit_limit || 0
							});
						} else {
							// For subscriptions, create/update subscription
							const subscriptionData = {
								userId: userId,
								productId: event.product_id,
								subscriptionId: event.subscription_id,
								entitlementId: entitlementId,
								purchasedAt: event.purchased_at_ms ? new Date(parseInt(event.purchased_at_ms)).toISOString() : new Date().toISOString(),
								expiresAt: expiresAt,
								creditLimit: product.credit_limit || 0
							};

							const userSubscription = await DatabaseUtils.createOrUpdateUserSubscription(subscriptionData, env, logger);
							if (userSubscription) {
								logger.log('INFO', 'User subscription created/updated from webhook', {
									userId: userId,
									productId: event.product_id,
									subscriptionId: userSubscription.id
								});
							}
						}
					}
				} catch (subscriptionError) {
					logger.log('ERROR', 'Failed to create/update user subscription from webhook', {
						error: subscriptionError.message,
						userId: userId,
						productId: event.product_id
					});
				}
			}

			// Handle cancellation and expiration events
			if (['CANCELLATION', 'EXPIRATION'].includes(event.type) && userId && event.product_id) {
				try {
					// Find the active subscription for this user and product
					const userSubscriptions = await DatabaseUtils.getUserSubscriptions(userId, { activeOnly: true }, env, logger);
					const subscriptionToUpdate = userSubscriptions.find(sub =>
						sub.product_id === event.product_id && sub.is_active
					);

					if (subscriptionToUpdate) {
						// For UNSUBSCRIBE cancellations, update expiration date instead of deactivating immediately
						if (event.type === 'CANCELLATION' && event.cancel_reason === 'UNSUBSCRIBE' && event.expiration_at_ms) {
							const expirationDate = new Date(parseInt(event.expiration_at_ms)).toISOString();
							await DatabaseUtils.updateSubscriptionExpiration(subscriptionToUpdate.id, expirationDate, env, logger);
							logger.log('INFO', 'User subscription expiration updated from UNSUBSCRIBE cancellation', {
								userId: userId,
								productId: event.product_id,
								subscriptionId: subscriptionToUpdate.id,
								expiresAt: expirationDate
							});
						} else {
							// For other cancellations or expiration events, deactivate immediately
							await DatabaseUtils.deactivateUserSubscription(subscriptionToUpdate.id, env, logger);
							logger.log('INFO', 'User subscription deactivated from webhook', {
								userId: userId,
								productId: event.product_id,
								subscriptionId: subscriptionToUpdate.id,
								eventType: event.type,
								cancelReason: event.cancel_reason
							});
						}
					}
				} catch (updateError) {
					logger.log('ERROR', 'Failed to update user subscription from webhook', {
						error: updateError.message,
						userId: userId,
						productId: event.product_id,
						eventType: event.type
					});
				}
			}

			return storedEvent;
		} catch (error) {
			logger.log('ERROR', 'Error storing RevenueCat webhook event', {
				error: error.message,
				stack: error.stack,
				eventType: webhookData?.event?.type,
				eventId: webhookData?.event?.id
			});
			return null;
		}
	}

	/**
	 * Check if a webhook event has already been processed
	 * @param {string} eventId - The RevenueCat event ID
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The existing event if found, null otherwise
	 */
	static async checkWebhookEventExists(eventId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot check webhook event');
				return null;
			}

			if (!eventId) {
				logger.log('WARN', 'No event ID provided for duplicate check');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			const { data: existingEvent, error } = await supabase
				.from('revenuecat_webhook_events')
				.select('id, event_id, event_type, user_id, product_id, processed_at')
				.eq('event_id', eventId)
				.single();

			if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
				logger.log('ERROR', 'Error checking webhook event existence', {
					error: error.message,
					eventId: eventId
				});
				return null;
			}

			return existingEvent || null;
		} catch (error) {
			logger.log('ERROR', 'Error checking webhook event existence', {
				error: error.message,
				eventId: eventId
			});
			return null;
		}
	}

	/**
	 * Get user subscription information from user_subscriptions table
	 * @param {string} userId - The user ID
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The user subscription data or null if not found
	 */
	static async getUserSubscription(userId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get user subscription');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			// Get active subscription from user_subscriptions table
			const { data: subscription, error } = await supabase
				.from('user_subscriptions')
				.select(`
					*,
					products (
						product_id,
						display_name,
						description,
						credit_limit,
						expire_days,
						expire_period,
						type
					)
				`)
				.eq('user_id', userId)
				.eq('is_active', true)
				.order('created_at', { ascending: false })
				.limit(1)
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to get user subscription', {
					error: error.message,
					userId: userId
				});
				return null;
			}

			return subscription;
		} catch (error) {
			logger.log('ERROR', 'Error getting user subscription', {
				error: error.message,
				userId: userId
			});
			return null;
		}
	}

	/**
	 * Get product information by product ID
	 * @param {string} productId - The product ID
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The product data or null if not found
	 */
	static async getProductById(productId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get product information');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			const { data: product, error } = await supabase
				.from('products')
				.select('*')
				.eq('product_id', productId)
				.eq('is_active', true)
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to get product information', {
					error: error.message,
					productId: productId
				});
				return null;
			}

			return product;
		} catch (error) {
			logger.log('ERROR', 'Error getting product information', {
				error: error.message,
				productId: productId
			});
			return null;
		}
	}

	/**
	 * Calculate expiration date based on product configuration
	 * @param {Object} product - The product data
	 * @param {Date} purchasedAt - The purchase date
	 * @param {Object} logger - Logger instance
	 * @returns {Date|null} - The calculated expiration date or null if calculation fails
	 */
	static calculateExpirationDate(product, purchasedAt, logger) {
		try {
			if (!product || !purchasedAt) {
				logger.log('WARN', 'Missing product or purchase date for expiration calculation');
				return null;
			}

			const purchaseDate = new Date(purchasedAt);
			let expirationDate = new Date(purchaseDate);

			// Use expire_days if available, otherwise use expire_period
			if (product.expire_days && product.expire_days > 0) {
				expirationDate.setDate(purchaseDate.getDate() + product.expire_days);
				logger.log('DEBUG', 'Using expire_days for expiration calculation', {
					productId: product.product_id,
					expireDays: product.expire_days
				});
			} else if (product.expire_period) {
				switch (product.expire_period) {
					case 'day':
						expirationDate.setDate(purchaseDate.getDate() + 1);
						break;
					case 'week':
						expirationDate.setDate(purchaseDate.getDate() + 7);
						break;
					case 'month':
						expirationDate.setMonth(purchaseDate.getMonth() + 1);
						break;
					case 'year':
						expirationDate.setFullYear(purchaseDate.getFullYear() + 1);
						break;
					default:
						// Fallback to month if invalid period
						logger.log('WARN', 'Invalid expire_period, using month as fallback', {
							productId: product.product_id,
							expirePeriod: product.expire_period
						});
						expirationDate.setMonth(purchaseDate.getMonth() + 1);
				}
				logger.log('DEBUG', 'Using expire_period for expiration calculation', {
					productId: product.product_id,
					expirePeriod: product.expire_period
				});
			} else {
				// Fallback to month if no expiration configuration
				logger.log('WARN', 'No expiration configuration found, using month as fallback', {
					productId: product.product_id
				});
				expirationDate.setMonth(purchaseDate.getMonth() + 1);
			}

			return expirationDate;
		} catch (error) {
			logger.log('ERROR', 'Error calculating expiration date', {
				error: error.message,
				productId: product?.product_id
			});
			// Return null to indicate calculation failure
			return null;
		}
	}

	/**
	 * Create or update user subscription/package
	 * @param {Object} subscriptionData - The subscription data
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The created/updated subscription or null if failed
	 */
	static async createOrUpdateUserSubscription(subscriptionData, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot create/update user subscription');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const {
				userId,
				productId,
				subscriptionId,
				entitlementId,
				purchasedAt,
				expiresAt,
				creditLimit
			} = subscriptionData;

			// Validate required fields
			if (!userId || !productId || !purchasedAt) {
				logger.log('ERROR', 'Missing required fields for user subscription', {
					userId: !!userId,
					productId: !!productId,
					purchasedAt: !!purchasedAt
				});
				return null;
			}

			// Get product information to determine if it's a subscription
			const product = await DatabaseUtils.getProductById(productId, env, logger);
			if (!product) {
				logger.log('ERROR', 'Product not found for user subscription', {
					productId: productId,
					userId: userId
				});
				return null;
			}

			// Determine if this is an annual subscription (for monthly credit resets)
			// Annual subscriptions typically have "annual" in the product_id
			const isAnnualSubscription = productId.toLowerCase().includes('annual') || 
				productId.toLowerCase().includes('yearly') ||
				productId.toLowerCase().includes('year');
			
			// Calculate initial billing period for annual subscriptions with monthly limits
			let billingPeriodStart = null;
			let billingPeriodEnd = null;
			if (isAnnualSubscription) {
				const purchaseDate = new Date(purchasedAt);
				// Start from purchase date
				billingPeriodStart = new Date(purchaseDate.getFullYear(), purchaseDate.getMonth(), purchaseDate.getDate());
				// End at start of next month (first day of next month)
				billingPeriodEnd = new Date(purchaseDate.getFullYear(), purchaseDate.getMonth() + 1, 1);
			}

			// For subscription type, we need to handle the unique constraint at application level
			// since PostgreSQL doesn't support subqueries in index predicates
			if (product.type === 'subscription') {
				// Check if user already has a subscription
				const { data: existingSubscriptions, error: checkError } = await supabase
					.from('user_subscriptions')
					.select(`
						*,
						products!inner(type)
					`)
					.eq('user_id', userId)
					.eq('is_active', true)
					.eq('products.type', 'subscription');

				if (checkError) {
					logger.log('ERROR', 'Failed to check existing subscription', {
						error: checkError.message,
						userId: userId
					});
					return null;
				}

				const existingSubscription = existingSubscriptions?.[0];

				if (existingSubscription) {
					// Update existing subscription
					// For annual subscriptions, reset billing period if it's a renewal
					const updateData = {
						product_id: productId,
						subscription_id: subscriptionId,
						entitlement_id: entitlementId,
						purchased_at: purchasedAt,
						expires_at: expiresAt,
						credit_limit: creditLimit || 0,
						credits_used: 0, // Reset credits used for new subscription
						updated_at: new Date().toISOString()
					};

					// Update billing period for annual subscriptions
					if (isAnnualSubscription && billingPeriodStart && billingPeriodEnd) {
						updateData.billing_period_start = billingPeriodStart.toISOString().split('T')[0];
						updateData.billing_period_end = billingPeriodEnd.toISOString().split('T')[0];
					}

					const { data: updatedSubscription, error: updateError } = await supabase
						.from('user_subscriptions')
						.update(updateData)
						.eq('id', existingSubscription.id)
						.select()
						.single();

					if (updateError) {
						logger.log('ERROR', 'Failed to update existing subscription', {
							error: updateError.message,
							userId: userId,
							subscriptionId: existingSubscription.id
						});
						return null;
					}

					logger.log('INFO', 'Updated existing subscription', {
						userId: userId,
						subscriptionId: updatedSubscription.id,
						productId: productId
					});

					return updatedSubscription;
				}
			}

			// Create new subscription/package
			const newSubscriptionData = {
				user_id: userId,
				product_id: productId,
				subscription_id: subscriptionId,
				entitlement_id: entitlementId,
				purchased_at: purchasedAt,
				expires_at: expiresAt,
				credit_limit: creditLimit || 0,
				credits_used: 0,
				is_active: true
			};

			// Set billing period for annual subscriptions
			if (isAnnualSubscription && billingPeriodStart && billingPeriodEnd) {
				newSubscriptionData.billing_period_start = billingPeriodStart.toISOString().split('T')[0];
				newSubscriptionData.billing_period_end = billingPeriodEnd.toISOString().split('T')[0];
			}

			const { data: newSubscription, error: insertError } = await supabase
				.from('user_subscriptions')
				.insert(newSubscriptionData)
				.select()
				.single();

			if (insertError) {
				logger.log('ERROR', 'Failed to create new user subscription', {
					error: insertError.message,
					userId: userId,
					productId: productId
				});
				return null;
			}

			logger.log('INFO', 'Created new user subscription', {
				userId: userId,
				subscriptionId: newSubscription.id,
				productId: productId,
				productType: product.type
			});

			return newSubscription;
		} catch (error) {
			logger.log('ERROR', 'Error creating/updating user subscription', {
				error: error.message,
				userId: subscriptionData?.userId
			});
			return null;
		}
	}

	/**
	 * Get user subscriptions
	 * @param {string} userId - The user ID
	 * @param {Object} options - Query options
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Array>} - Array of user subscriptions
	 */
	static async getUserSubscriptions(userId, options = {}, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get user subscriptions');
				return [];
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const { activeOnly = true, productType = null } = options;

			let query = supabase
				.from('user_subscriptions')
				.select(`
					*,
					products (
						product_id,
						display_name,
						description,
						credit_limit,
						expire_days,
						expire_period,
						type
					)
				`)
				.eq('user_id', userId)
				.order('created_at', { ascending: false });

			if (activeOnly) {
				query = query.eq('is_active', true);
			}

			if (productType) {
				query = query.eq('products.type', productType);
			}

			const { data: subscriptions, error } = await query;

			if (error) {
				logger.log('ERROR', 'Failed to get user subscriptions', {
					error: error.message,
					userId: userId
				});
				return [];
			}

			return subscriptions || [];
		} catch (error) {
			logger.log('ERROR', 'Error getting user subscriptions', {
				error: error.message,
				userId: userId
			});
			return [];
		}
	}

	/**
	 * Deactivate user subscription
	 * @param {string} subscriptionId - The subscription ID
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The deactivated subscription or null if failed
	 */
	static async deactivateUserSubscription(subscriptionId, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot deactivate user subscription');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			const { data: deactivatedSubscription, error } = await supabase
				.from('user_subscriptions')
				.update({ is_active: false })
				.eq('id', subscriptionId)
				.select()
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to deactivate user subscription', {
					error: error.message,
					subscriptionId: subscriptionId
				});
				return null;
			}

			logger.log('INFO', 'Deactivated user subscription', {
				subscriptionId: subscriptionId,
				userId: deactivatedSubscription.user_id
			});

			return deactivatedSubscription;
		} catch (error) {
			logger.log('ERROR', 'Error deactivating user subscription', {
				error: error.message,
				subscriptionId: subscriptionId
			});
			return null;
		}
	}

	/**
	 * Update subscription expiration date (for UNSUBSCRIBE cancellations)
	 * @param {string} subscriptionId - The subscription ID
	 * @param {string} expiresAt - The expiration date (ISO string)
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The updated subscription or null if failed
	 */
	static async updateSubscriptionExpiration(subscriptionId, expiresAt, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot update subscription expiration');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			const { data: updatedSubscription, error } = await supabase
				.from('user_subscriptions')
				.update({ expires_at: expiresAt })
				.eq('id', subscriptionId)
				.select()
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to update subscription expiration', {
					error: error.message,
					subscriptionId: subscriptionId,
					expiresAt: expiresAt
				});
				return null;
			}

			logger.log('INFO', 'Updated subscription expiration', {
				subscriptionId: subscriptionId,
				userId: updatedSubscription.user_id,
				expiresAt: expiresAt
			});

			return updatedSubscription;
		} catch (error) {
			logger.log('ERROR', 'Error updating subscription expiration', {
				error: error.message,
				subscriptionId: subscriptionId
			});
			return null;
		}
	}

	/**
	 * Update pages used for a user subscription
	 * @param {string} subscriptionId - The subscription ID
	 * @param {number} pagesUsed - The number of pages used
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The updated subscription or null if failed
	 */
	static async updatePagesUsed(subscriptionId, pagesUsed, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot update pages used');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			const { data: updatedSubscription, error } = await supabase
				.from('user_subscriptions')
				.update({ credits_used: creditsUsed })
				.eq('id', subscriptionId)
				.select()
				.single();

			if (error) {
				logger.log('ERROR', 'Failed to update pages used', {
					error: error.message,
					subscriptionId: subscriptionId,
					pagesUsed: pagesUsed
				});
				return null;
			}

			logger.log('INFO', 'Updated pages used', {
				subscriptionId: subscriptionId,
				pagesUsed: pagesUsed
			});

			return updatedSubscription;
		} catch (error) {
			logger.log('ERROR', 'Error updating pages used', {
				error: error.message,
				subscriptionId: subscriptionId
			});
			return null;
		}
	}

	/**
	 * Get webhook events for a user
	 * @param {string} userId - The user ID
	 * @param {Object} options - Query options
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Array>} - Array of webhook events
	 */
	static async getUserWebhookEvents(userId, options = {}, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot get user webhook events');
				return [];
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const { limit = 50, offset = 0, eventType = null } = options;

			let query = supabase
				.from('revenuecat_webhook_events')
				.select('*')
				.eq('user_id', userId)
				.order('processed_at', { ascending: false })
				.range(offset, offset + limit - 1);

			if (eventType) {
				query = query.eq('event_type', eventType);
			}

			const { data: events, error } = await query;

			if (error) {
				logger.log('ERROR', 'Failed to get user webhook events', {
					error: error.message,
					userId: userId
				});
				return [];
			}

			return events || [];
		} catch (error) {
			logger.log('ERROR', 'Error getting user webhook events', {
				error: error.message,
				userId: userId
			});
			return [];
		}
	}

	/**
	 * Transfer user data from one user to another (for RevenueCat TRANSFER events)
	 * @param {string} fromUserId - The user ID to transfer from
	 * @param {string} toUserId - The user ID to transfer to
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @param {string} transferReason - Reason for transfer (e.g., 'revenuecat_transfer')
	 * @returns {Promise<Object>} - Transfer result with counts and status
	 */
	static async transferUserData(fromUserId, toUserId, env, logger, transferReason = 'revenuecat_transfer') {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot transfer user data');
				return { success: false, error: 'Supabase not configured' };
			}

			if (!fromUserId || !toUserId) {
				logger.log('ERROR', 'Missing user IDs for transfer', {
					fromUserId: !!fromUserId,
					toUserId: !!toUserId
				});
				return { success: false, error: 'Missing user IDs' };
			}

			if (fromUserId === toUserId) {
				logger.log('WARN', 'Transfer requested to same user, skipping', {
					userId: fromUserId
				});
				return { success: true, message: 'No transfer needed' };
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);
			const transferResult = {
				success: true,
				fromUserId,
				toUserId,
				transferredSubscriptions: 0,
				transferredUsage: 0,
				transferredFaxes: 0,
				oldUserDeleted: false,
				transferId: null
			};

			logger.log('INFO', 'Starting user data transfer', {
				fromUserId,
				toUserId,
				transferReason
			});

			// Validate users exist before proceeding
			const validationResult = await DatabaseUtils.validateUsersForTransfer(fromUserId, toUserId, env, logger);
			if (!validationResult.valid) {
				logger.log('ERROR', 'User validation failed for transfer', {
					fromUserId,
					toUserId,
					error: validationResult.error
				});
				return { success: false, error: validationResult.error };
			}

			// Create transfer audit record
			const transferId = await DatabaseUtils.createTransferAuditRecord(fromUserId, toUserId, transferReason, env, logger);
			transferResult.transferId = transferId;

			// Wrap all operations in a transaction
			const { data: transactionResult, error: transactionError } = await supabase.rpc('transfer_user_data_transaction', {
				p_from_user_id: fromUserId,
				p_to_user_id: toUserId,
				p_transfer_id: transferId
			});

			if (transactionError) {
				logger.log('ERROR', 'Transaction failed for user transfer', {
					error: transactionError.message,
					fromUserId,
					toUserId,
					transferId
				});
				
				// Update audit record with failure
				await DatabaseUtils.updateTransferAuditRecord(transferId, { 
					success: false, 
					error: transactionError.message 
				}, env, logger);
				
				return { success: false, error: transactionError.message };
			}

			// Update transfer result with transaction results
			if (transactionResult) {
				transferResult.transferredSubscriptions = transactionResult.transferred_subscriptions || 0;
				transferResult.transferredUsage = transactionResult.transferred_usage || 0;
				transferResult.transferredFaxes = transactionResult.transferred_faxes || 0;
			}

			// Check if old user is anonymous and delete if so
			try {
				const { data: oldUser, error: userError } = await supabase.auth.admin.getUserById(fromUserId);
				
				if (userError) {
					logger.log('ERROR', 'Failed to check if old user is anonymous', {
						error: userError.message,
						fromUserId
					});
				} else if (oldUser && oldUser.user && oldUser.user.app_metadata?.is_anonymous === true) {
					// Delete anonymous user
					const { error: deleteError } = await supabase.auth.admin.deleteUser(fromUserId);
					
					if (deleteError) {
						logger.log('ERROR', 'Failed to delete anonymous user', {
							error: deleteError.message,
							fromUserId
						});
					} else {
						transferResult.oldUserDeleted = true;
						logger.log('INFO', 'Deleted anonymous user after transfer', {
							fromUserId
						});
					}
				} else {
					logger.log('INFO', 'Old user is not anonymous, keeping user account', {
						fromUserId,
						isAnonymous: oldUser?.user?.app_metadata?.is_anonymous
					});
				}
			} catch (error) {
				logger.log('ERROR', 'Error checking/deleting old user', {
					error: error.message,
					fromUserId
				});
			}

			// Update audit record with success
			await DatabaseUtils.updateTransferAuditRecord(transferId, {
				success: true,
				transferredSubscriptions: transferResult.transferredSubscriptions,
				transferredUsage: transferResult.transferredUsage,
				transferredFaxes: transferResult.transferredFaxes,
				oldUserDeleted: transferResult.oldUserDeleted
			}, env, logger);

			logger.log('INFO', 'User data transfer completed', transferResult);
			return transferResult;

		} catch (error) {
			logger.log('ERROR', 'Error in user data transfer', {
				error: error.message,
				fromUserId,
				toUserId
			});
			return { 
				success: false, 
				error: error.message,
				fromUserId,
				toUserId
			};
		}
	}

	/**
	 * Validate users exist and are eligible for transfer
	 * @param {string} fromUserId - The user ID to transfer from
	 * @param {string} toUserId - The user ID to transfer to
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object>} - Validation result
	 */
	static async validateUsersForTransfer(fromUserId, toUserId, env, logger) {
		try {
			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			// Check if both users exist
			const { data: fromUser, error: fromUserError } = await supabase.auth.admin.getUserById(fromUserId);
			if (fromUserError || !fromUser?.user) {
				return { valid: false, error: `Source user ${fromUserId} does not exist` };
			}

			const { data: toUser, error: toUserError } = await supabase.auth.admin.getUserById(toUserId);
			if (toUserError || !toUser?.user) {
				return { valid: false, error: `Target user ${toUserId} does not exist` };
			}

			// Check if target user is anonymous (should not transfer to anonymous user)
			if (toUser.user.app_metadata?.is_anonymous === true) {
				return { valid: false, error: `Cannot transfer to anonymous user ${toUserId}` };
			}

			return { valid: true };
		} catch (error) {
			logger.log('ERROR', 'Error validating users for transfer', {
				error: error.message,
				fromUserId,
				toUserId
			});
			return { valid: false, error: error.message };
		}
	}

	/**
	 * Create audit record for transfer operation
	 * @param {string} fromUserId - The user ID to transfer from
	 * @param {string} toUserId - The user ID to transfer to
	 * @param {string} transferReason - Reason for transfer
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<string>} - Transfer ID
	 */
	static async createTransferAuditRecord(fromUserId, toUserId, transferReason, env, logger) {
		try {
			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			const { data: transferRecord, error } = await supabase
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
				logger.log('ERROR', 'Failed to create transfer audit record', {
					error: error.message,
					fromUserId,
					toUserId
				});
				return null;
			}

			logger.log('INFO', 'Created transfer audit record', {
				transferId: transferRecord.id,
				fromUserId,
				toUserId
			});

			return transferRecord.id;
		} catch (error) {
			logger.log('ERROR', 'Error creating transfer audit record', {
				error: error.message,
				fromUserId,
				toUserId
			});
			return null;
		}
	}

	/**
	 * Update transfer audit record with results
	 * @param {string} transferId - The transfer ID
	 * @param {Object} results - Transfer results
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<void>}
	 */
	static async updateTransferAuditRecord(transferId, results, env, logger) {
		try {
			if (!transferId) return;

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
				logger.log('ERROR', 'Failed to update transfer audit record', {
					error: error.message,
					transferId
				});
			} else {
				logger.log('INFO', 'Updated transfer audit record', {
					transferId,
					status: updateData.status
				});
			}
		} catch (error) {
			logger.log('ERROR', 'Error updating transfer audit record', {
				error: error.message,
				transferId
			});
		}
	}

	/**
	 * Add consumable credits to user's subscription or create new one
	 * @param {string} userId - The user ID
	 * @param {string} productId - The consumable product ID
	 * @param {number} creditsToAdd - Number of credits to add
	 * @param {Object} env - Environment variables
	 * @param {Object} logger - Logger instance
	 * @returns {Promise<Object|null>} - The updated/created subscription or null if failed
	 */
	static async addConsumablePages(userId, productId, creditsToAdd, env, logger) {
		try {
			if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
				logger.log('WARN', 'Supabase not configured, cannot add consumable credits');
				return null;
			}

			const supabase = DatabaseUtils.getSupabaseAdminClient(env);

			// Get product information
			const product = await DatabaseUtils.getProductById(productId, env, logger);
			if (!product) {
				logger.log('ERROR', 'Product not found for consumable credits', {
					productId: productId,
					userId: userId
				});
				return null;
			}

			// Check if user has an active subscription
			const { data: existingSubscriptions, error: subError } = await supabase
				.from('user_subscriptions')
				.select('*')
				.eq('user_id', userId)
				.eq('is_active', true)
				.order('created_at', { ascending: false })
				.limit(1);

			if (subError) {
				logger.log('ERROR', 'Failed to check existing subscriptions', {
					error: subError.message,
					userId: userId
				});
				return null;
			}

			if (existingSubscriptions && existingSubscriptions.length > 0) {
				// Add credits to existing subscription
				const existingSubscription = existingSubscriptions[0];
				const newCreditLimit = existingSubscription.credit_limit + creditsToAdd;

				const { data: updatedSubscription, error: updateError } = await supabase
					.from('user_subscriptions')
					.update({ 
						credit_limit: newCreditLimit,
						updated_at: new Date().toISOString()
					})
					.eq('id', existingSubscription.id)
					.select()
					.single();

				if (updateError) {
					logger.log('ERROR', 'Failed to update subscription with consumable credits', {
						error: updateError.message,
						subscriptionId: existingSubscription.id,
						userId: userId
					});
					return null;
				}

				logger.log('INFO', 'Added consumable credits to existing subscription', {
					subscriptionId: updatedSubscription.id,
					userId: userId,
					creditsAdded: creditsToAdd,
					newTotal: newCreditLimit
				});

				return updatedSubscription;
			} else {
				// Create new subscription for consumable
				const purchaseDate = new Date();
				const expiresAt = product.expire_days > 0 
					? new Date(purchaseDate.getTime() + (product.expire_days * 24 * 60 * 60 * 1000)).toISOString()
					: null;

				const newSubscriptionData = {
					user_id: userId,
					product_id: productId,
					subscription_id: null, // Consumables don't have subscription IDs
					entitlement_id: null,
					purchased_at: purchaseDate.toISOString(),
					expires_at: expiresAt,
					credit_limit: creditsToAdd,
					credits_used: 0,
					is_active: true
				};

				const { data: newSubscription, error: insertError } = await supabase
					.from('user_subscriptions')
					.insert(newSubscriptionData)
					.select()
					.single();

				if (insertError) {
					logger.log('ERROR', 'Failed to create new subscription for consumable', {
						error: insertError.message,
						userId: userId,
						productId: productId
					});
					return null;
				}

				logger.log('INFO', 'Created new subscription for consumable', {
					subscriptionId: newSubscription.id,
					userId: userId,
					productId: productId,
					creditsAdded: creditsToAdd
				});

				return newSubscription;
			}
		} catch (error) {
			logger.log('ERROR', 'Error adding consumable pages', {
				error: error.message,
				userId: userId,
				productId: productId,
				creditsToAdd: creditsToAdd
			});
			return null;
		}
	}
} 
