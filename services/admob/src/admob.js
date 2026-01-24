/**
 * AdMob Service - Server-Side Verification for Rewarded Ads
 * Compatible with Serverless API Gateway
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Logger } from './utils.js';
import { verifyAdMobCallback, parseAdMobCallback } from './verifier.js';
import { DatabaseUtils } from './database.js';

export default class extends WorkerEntrypoint {
	constructor(ctx, env) {
		super(ctx, env);
		this.logger = null;
		this.env = env;
		this.initializeLogger(this.env);
	}

	async fetch(request, env) {
		return new Response('Hello from AdMob Service');
	}

	initializeLogger(env) {
		if (!this.logger) {
			this.logger = new Logger(env);
		}
	}

	/**
	 * Handle AdMob SSV webhook callback
	 * This is called by Google when a user completes watching a rewarded ad
	 * 
	 * @param {Request} request - The incoming request
	 * @param {object} caller_env - Environment variables from the caller
	 * @param {object} sagContext - Serverless API Gateway context
	 * @returns {Promise<Response>}
	 */
	async ssvCallback(request, caller_env, sagContext) {
		try {
			this.logger.log('INFO', 'AdMob SSV callback received');

			// Parse environment
			const callerEnvObj = typeof caller_env === 'string'
				? JSON.parse(caller_env || '{}')
				: (caller_env || {});

			// Get the full URL for verification
			const url = request.url;
			this.logger.log('DEBUG', 'Full request URL', { url });
			this.logger.log('DEBUG', 'Request headers', {
				headers: Object.fromEntries(request.headers.entries())
			});
			this.logger.log('DEBUG', 'Caller env keys', {
				keys: Object.keys(callerEnvObj),
				skipVerification: callerEnvObj.ADMOB_SKIP_VERIFICATION
			});

			// Parse callback parameters
			const params = parseAdMobCallback(url);
			this.logger.log('DEBUG', 'Parsed SSV parameters', {
				adUnit: params.adUnit,
				transactionId: params.transactionId,
				userId: params.userId,
				rewardAmount: params.rewardAmount,
				rewardItem: params.rewardItem
			});

			// Validate required parameters
			// Always return 200 to prevent Google from retrying, but don't process if invalid
			if (!params.transactionId) {
				this.logger.log('ERROR', 'Missing transaction_id - not processing webhook');
				return new Response(JSON.stringify({
					success: false,
					error: 'Missing transaction_id',
					processed: false
				}), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			if (!params.userId) {
				this.logger.log('ERROR', 'Missing user_id - not processing webhook');
				return new Response(JSON.stringify({
					success: false,
					error: 'Missing user_id',
					processed: false
				}), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// Check for duplicate transaction (idempotency)
			const existingTransaction = await DatabaseUtils.checkTransactionExists(
				params.transactionId,
				callerEnvObj,
				this.logger
			);

			if (existingTransaction) {
				this.logger.log('INFO', 'Duplicate SSV callback detected', {
					transactionId: params.transactionId,
					originalCompletedAt: existingTransaction.completed_at
				});
				return new Response(JSON.stringify({
					success: true,
					message: 'Already processed',
					transactionId: params.transactionId
				}), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			// Verify signature (optional but recommended)
			// Skip verification in development/testing if ADMOB_SKIP_VERIFICATION is set
			if (!callerEnvObj.ADMOB_SKIP_VERIFICATION) {
				try {
					await verifyAdMobCallback(url, this.logger);
				} catch (verifyError) {
					this.logger.log('ERROR', 'SSV signature verification failed - not processing webhook', {
						error: verifyError.message,
						transactionId: params.transactionId
					});
					// Always return 200 to prevent Google from retrying, but don't process the webhook
					return new Response(JSON.stringify({
						success: false,
						error: 'Invalid signature',
						processed: false,
						transactionId: params.transactionId
					}), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
				}
			} else {
				this.logger.log('WARN', 'Skipping signature verification (ADMOB_SKIP_VERIFICATION is set)');
			}

			// Record completion and grant reward
			const result = await DatabaseUtils.recordRewardedVideoCompletion({
				userId: params.userId,
				transactionId: params.transactionId,
				adUnit: params.adUnit,
				rewardAmount: params.rewardAmount || 1,
				rewardItem: params.rewardItem,
				adNetwork: params.adNetwork,
				timestamp: params.timestamp
			}, callerEnvObj, this.logger);

			if (!result.success && result.reason === 'monthly_cap_reached') {
				this.logger.log('WARN', 'Monthly cap reached for user', { userId: params.userId });
				return new Response(JSON.stringify({
					success: false,
					error: 'Monthly reward cap reached',
					completionCount: result.completionCount
				}), {
					status: 200, // Return 200 to prevent Google from retrying
					headers: { 'Content-Type': 'application/json' }
				});
			}

			this.logger.log('INFO', 'SSV callback processed successfully', {
				transactionId: params.transactionId,
				userId: params.userId,
				pagesGranted: result.pagesGranted
			});

			return new Response(JSON.stringify({
				success: true,
				transactionId: params.transactionId,
				pagesGranted: result.pagesGranted
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});

		} catch (error) {
			this.logger.log('ERROR', 'Error processing AdMob SSV callback', {
				error: error.message,
				stack: error.stack
			});
			// Always return 200 to prevent Google from retrying
			return new Response(JSON.stringify({
				success: false,
				error: 'Internal server error',
				processed: false
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
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
				service: 'admob',
				timestamp: new Date().toISOString()
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			this.logger.log('ERROR', 'Error in health check', { error: error.message });
			return new Response(JSON.stringify({ error: 'Internal server error' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
}
