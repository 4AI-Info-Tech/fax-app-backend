/**
 * RevenueCat Service - Compatible with Serverless API Gateway
 */

import { env, WorkerEntrypoint } from "cloudflare:workers";
import { Logger } from './utils.js';
import { DatabaseUtils } from './database.js';

export default class extends WorkerEntrypoint {
	constructor(ctx, env) {
		super(ctx, env);
		this.logger = null;
		this.env = env;
		this.initializeLogger(this.env);
	}

	async fetch() {
		return new Response(JSON.stringify({
			error: "Not found",
			message: "RevenueCat webhook is handled via API Gateway at /v1/revenuecat/webhook"
		}), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	initializeLogger(env) {
		if (!this.logger) {
			this.logger = new Logger(env);
		}
	}

	async parseRequestBody(request) {
		this.logger.log('DEBUG', 'Starting request body processing');

		if (!request.body) {
			return null;
		}

		const contentType = request.headers.get('content-type') || '';

		if (contentType.includes('application/json')) {
			const jsonData = await request.json();
			return jsonData;
		} else {
			const textData = await request.text();
			return textData;
		}
	}

	/**
	 * Handle RevenueCat webhooks
	 * @param {Request} request - The incoming request
	 * @param {string} caller_env - Environment variables from the caller
	 * @param {string} sagContext - Serverless API Gateway context
	 * @returns {Promise<Response>}
	 */
	async webhook(request, caller_env, sagContext) {
		try {
			this.logger.log('INFO', 'RevenueCat webhook received');
			// Ensure we have usable objects regardless of whether inputs are strings
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});
			const sagContextObj = typeof sagContext === 'string' ? JSON.parse(sagContext || '{}') : (sagContext || {});

			// Parse request body
			const webhookData = await this.parseRequestBody(request);
			if (!webhookData) {
				this.logger.log('ERROR', 'No webhook data received');
				return new Response(JSON.stringify({ error: 'No webhook data received' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			this.logger.log('DEBUG', 'Webhook data received', webhookData);

			// Verify webhook signature if secret is provided
			const webhookSecret = callerEnvObj.REVENUECAT_WEBHOOK_SECRET;
			if (webhookSecret) {
				const authorization = request.headers.get('authorization');
				if (!authorization) {
					this.logger.log('ERROR', 'No authorization header provided');
					return new Response(JSON.stringify({ error: 'Unauthorized' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				// Direct comparison of webhook secret and authorization header
				if (authorization !== webhookSecret) {
					this.logger.log('ERROR', 'Invalid webhook secret');
					return new Response(JSON.stringify({ error: 'Unauthorized' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' }
					});
				}
			}

			// Process webhook based on event type
			const eventType = webhookData.event?.type;
			if (!eventType) {
				this.logger.log('ERROR', 'No event type in webhook data');
				return new Response(JSON.stringify({ error: 'Invalid webhook data' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// Check for duplicate webhook early in the process
			const eventId = webhookData.event?.id;
			if (eventId) {
				const existingEvent = await DatabaseUtils.checkWebhookEventExists(eventId, callerEnvObj, this.logger);
				if (existingEvent) {
					this.logger.log('INFO', 'Duplicate webhook event detected, returning success without processing', {
						eventId: eventId,
						eventType: existingEvent.event_type,
						originalProcessedAt: existingEvent.processed_at
					});
					return new Response(JSON.stringify({ 
						success: true, 
						message: 'Event already processed',
						eventId: eventId,
						processedAt: existingEvent.processed_at
					}), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
				}
			}

			this.logger.log('INFO', `Processing webhook event: ${eventType}`);

			// Handle different event types
			switch (eventType) {
				case 'INITIAL_PURCHASE':
					await this.handleInitialPurchase(webhookData, callerEnvObj);
					break;
				case 'RENEWAL':
					await this.handleRenewal(webhookData, callerEnvObj);
					break;
				case 'CANCELLATION':
					await this.handleCancellation(webhookData, callerEnvObj);
					break;
				case 'UNCANCELLATION':
					await this.handleUncancellation(webhookData, callerEnvObj);
					break;
				case 'NON_RENEWING_PURCHASE':
					await this.handleNonRenewingPurchase(webhookData, callerEnvObj);
					break;
				case 'EXPIRATION':
					await this.handleExpiration(webhookData, callerEnvObj);
					break;
				case 'BILLING_ISSUE':
					await this.handleBillingIssue(webhookData, callerEnvObj);
					break;
				case 'PRODUCT_CHANGE':
					await this.handleProductChange(webhookData, callerEnvObj);
					break;
				case 'TRANSFER':
					await this.handleTransfer(webhookData, callerEnvObj);
					break;
				default:
					this.logger.log('WARN', `Unhandled event type: ${eventType}`);
			}

			// Store webhook event in database (this also handles subscription updates)
			const storedEvent = await DatabaseUtils.storeRevenueCatWebhookEvent(webhookData, callerEnvObj, this.logger);

			return new Response(JSON.stringify({ 
				success: true,
				eventId: storedEvent?.event_id,
				processedAt: storedEvent?.processed_at
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		} catch (error) {
			this.logger.log('ERROR', 'Error processing RevenueCat webhook', error);
			return new Response(JSON.stringify({ error: 'Internal server error' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}



	/**
	 * Handle initial purchase events
	 */
	async handleInitialPurchase(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling initial purchase', webhookData.event);
		// Implement initial purchase logic
		// Update user subscription status, grant access to premium features, etc.
	}

	/**
	 * Handle renewal events
	 */
	async handleRenewal(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling renewal', webhookData.event);
		// Implement renewal logic
	}

	/**
	 * Handle cancellation events
	 */
	async handleCancellation(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling cancellation', webhookData.event);
		// Implement cancellation logic
		// Revoke access to premium features, etc.
	}

	/**
	 * Handle uncancellation events
	 */
		async handleUncancellation(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling uncancellation', webhookData.event);
		// Implement uncancellation logic
	}

	/**
	 * Handle non-renewing purchase events (consumables)
	 */
	async handleNonRenewingPurchase(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling non-renewing purchase (consumable)', {
			eventId: webhookData.event.id,
			productId: webhookData.event.product_id,
			userId: webhookData.event.app_user_id,
			price: webhookData.event.price,
			currency: webhookData.event.currency
		});
		// The actual logic is handled in storeRevenueCatWebhookEvent method
		// This method provides additional logging and can be extended for specific consumable logic
	}

	/**
	 * Handle expiration events
	 */
	async handleExpiration(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling expiration', webhookData.event);
		// Implement expiration logic
	}

	/**
	 * Handle billing issue events
	 */
	async handleBillingIssue(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling billing issue', webhookData.event);
		// Implement billing issue logic
	}

	/**
	 * Handle product change events
	 */
	async handleProductChange(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling product change', webhookData.event);
		// Implement product change logic
	}

	/**
	 * Handle transfer events
	 * Transfer occurs when user 1 logs in, makes a purchase, logs out, 
	 * and then user 2 logs in on the same device with the same underlying 
	 * App/Play Store account and restores their purchases.
	 * Entitlements are removed from user 1 and added to user 2.
	 */
	async handleTransfer(webhookData, callerEnvObj) {
		this.logger.log('INFO', 'Handling transfer event', JSON.stringify(webhookData.event));
		
		const event = webhookData.event;
		
		// Extract user IDs from the transfer event
		const transferredFrom = event.transferred_from;
		const transferredTo = event.transferred_to;
		
		if (!transferredFrom || !Array.isArray(transferredFrom) || transferredFrom.length === 0) {
			this.logger.log('ERROR', 'Missing or invalid transferred_from in transfer event', {
				transferredFrom,
				eventId: event.id
			});
			return;
		}
		
		if (!transferredTo || !Array.isArray(transferredTo) || transferredTo.length === 0) {
			this.logger.log('ERROR', 'Missing or invalid transferred_to in transfer event', {
				transferredTo,
				eventId: event.id
			});
			return;
		}
		
		// For now, we'll transfer from the first user in the array to the first user in the array
		// In most cases, there should only be one user in each array
		const fromUserId = transferredFrom[0];
		const toUserId = transferredTo[0];
		
		this.logger.log('INFO', 'Processing transfer', {
			fromUserId,
			toUserId,
			eventId: event.id
		});
		
		// Perform the transfer using the database utility
		const transferResult = await DatabaseUtils.transferUserData(fromUserId, toUserId, callerEnvObj, this.logger, 'revenuecat_transfer');
		
		if (transferResult.success) {
			this.logger.log('INFO', 'Transfer completed successfully', {
				eventId: event.id,
				fromUserId,
				toUserId,
				transferredSubscriptions: transferResult.transferredSubscriptions,
				transferredUsage: transferResult.transferredUsage,
				transferredFaxes: transferResult.transferredFaxes,
				oldUserDeleted: transferResult.oldUserDeleted
			});
		} else {
			this.logger.log('ERROR', 'Transfer failed', {
				eventId: event.id,
				fromUserId,
				toUserId,
				error: transferResult.error
			});
		}
	}



	/**
	 * Health check endpoint
	 */
	async health(request, caller_env, sagContext) {
		try {
			this.logger.log('INFO', 'Health check requested');

			return new Response(JSON.stringify({
				status: 'healthy',
				service: 'revenuecat',
				callerEnv: JSON.stringify(caller_env),
				sagContext: JSON.stringify(sagContext),
				env: JSON.stringify(this.env),
				timestamp: new Date().toISOString()
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			this.logger.log('ERROR', 'Error in health check', error);
			return new Response(JSON.stringify({ error: 'Internal server error' }), {
				status: 500,
				error: error.message,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
} 
