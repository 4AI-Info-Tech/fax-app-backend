/**
 * Management Service - Compatible with Serverless API Gateway
 */

import { env, WorkerEntrypoint } from "cloudflare:workers";
import { Logger } from './utils.js';
import { DatabaseUtils } from './database.js';

export default class extends WorkerEntrypoint {
	constructor(ctx, env) {
		super(ctx, env);
		this.logger = null;
		this.env = env;
		this.initializeLogger(env);
	}

	async fetch(request, env) {
		this.initializeLogger(env);
		this.logger.log('INFO', 'Fetch request received');
		return new Response("Hello from Management Service");
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

		if (contentType.includes('multipart/form-data')) {
			const formData = await request.formData();
			return formData;
		} else if (contentType.includes('application/json')) {
			const jsonData = await request.json();
			return jsonData;
		} else {
			const textData = await request.text();
			return textData;
		}
	}

	async health(request, caller_env, sagContext) {
		this.logger.log('INFO', 'Health check requested');
		
		try {
			return new Response(JSON.stringify({
				status: 'healthy',
				service: 'management',
				timestamp: new Date().toISOString(),
				environment: this.env.LOG_LEVEL || 'INFO'
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `Health check failed: ${error.message}`);
			return new Response(JSON.stringify({
				status: 'unhealthy',
				error: error.message,
				service: 'management'
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		}
	}

	async healthProtected(request, caller_env, sagContext) {
		this.logger.log('INFO', 'Protected health check requested');
		
		try {
			// Parse caller environment
			const callerEnvObj = JSON.parse(caller_env || '{}');
			const sagContextObj = JSON.parse(sagContext || '{}');
			
			// Check if user is authenticated
			if (!callerEnvObj.userId) {
				return new Response(JSON.stringify({
					error: 'Unauthorized',
					message: 'Authentication required'
				}), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization'
					}
				});
			}

			return new Response(JSON.stringify({
				status: 'healthy',
				service: 'management',
				userId: callerEnvObj.userId,
				timestamp: new Date().toISOString(),
				environment: this.env.LOG_LEVEL || 'INFO'
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `Protected health check failed: ${error.message}`);
			return new Response(JSON.stringify({
				status: 'unhealthy',
				error: error.message,
				service: 'management'
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		}
	}

	async debug(request, caller_env = "{}", sagContext = "{}") {
		this.logger.log('INFO', 'Debug endpoint requested');
		
		try {
			const callerEnvObj = JSON.parse(caller_env || '{}');
			const sagContextObj = JSON.parse(sagContext || '{}');
			
			return new Response(JSON.stringify({
				service: 'management',
				callerEnvironment: callerEnvObj,
				sagContext: sagContextObj,
				serviceEnvironment: {
					LOG_LEVEL: this.env.LOG_LEVEL
				},
				timestamp: new Date().toISOString()
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `Debug endpoint failed: ${error.message}`);
			return new Response(JSON.stringify({
				error: error.message,
				service: 'management'
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		}
	}

	async appStoreWebhook(request, caller_env = "{}", sagContext = "{}") {
		this.logger.log('INFO', 'App Store webhook received');
		
		try {
			const requestBody = await this.parseRequestBody(request);
			const headers = Object.fromEntries(request.headers.entries());
			
			// Save webhook to database
			const webhookData = {
				type: 'app_store',
				payload: requestBody,
				headers: headers,
				received_at: new Date().toISOString()
			};

			const savedWebhook = await DatabaseUtils.saveWebhookEvent(webhookData, this.env, this.logger);
			
			if (!savedWebhook) {
				this.logger.log('ERROR', 'Failed to save App Store webhook to database');
				return new Response(JSON.stringify({
					error: 'Failed to save webhook',
					service: 'management'
				}), {
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization'
					}
				});
			}

			this.logger.log('INFO', 'App Store webhook saved successfully', {
				webhookId: savedWebhook.id
			});

			return new Response(JSON.stringify({
				success: true,
				message: 'Webhook received and saved',
				webhookId: savedWebhook.id,
				service: 'management'
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `App Store webhook processing failed: ${error.message}`);
			return new Response(JSON.stringify({
				error: error.message,
				service: 'management'
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		}
	}

	async signInWithAppleWebhook(request, caller_env = "{}", sagContext = "{}") {
		this.logger.log('INFO', 'Sign in with Apple webhook received');
		
		try {
			const requestBody = await this.parseRequestBody(request);
			const headers = Object.fromEntries(request.headers.entries());
			
			// Save webhook to database
			const webhookData = {
				type: 'sign_in_with_apple',
				payload: requestBody,
				headers: headers,
				received_at: new Date().toISOString()
			};

			const savedWebhook = await DatabaseUtils.saveWebhookEvent(webhookData, this.env, this.logger);
			
			if (!savedWebhook) {
				this.logger.log('ERROR', 'Failed to save Sign in with Apple webhook to database');
				return new Response(JSON.stringify({
					error: 'Failed to save webhook',
					service: 'management'
				}), {
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization'
					}
				});
			}

			this.logger.log('INFO', 'Sign in with Apple webhook saved successfully', {
				webhookId: savedWebhook.id
			});

			return new Response(JSON.stringify({
				success: true,
				message: 'Webhook received and saved',
				webhookId: savedWebhook.id,
				service: 'management'
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `Sign in with Apple webhook processing failed: ${error.message}`);
			return new Response(JSON.stringify({
				error: error.message,
				service: 'management'
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		}
	}

	/**
	 * Get usage summary for the authenticated user
	 * GET /v1/usage/summary?period=daily|weekly|monthly|all_time
	 * _Requirements: 13.1, 13.2, 13.3_
	 */
	/**
	 * Schedule account deletion (7 days from now)
	 * POST /v1/account/delete
	 * User can cancel within the 7-day period
	 */
	async scheduleAccountDeletion(request, caller_env = "{}", sagContext = "{}") {
		this.logger.log('INFO', 'Account deletion scheduling requested');
		
		try {
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});
			const sagContextObj = typeof sagContext === 'string' ? JSON.parse(sagContext || '{}') : (sagContext || {});
			
			// Get user ID from JWT
			const userId = sagContextObj.jwtPayload?.sub || sagContextObj.jwtPayload?.user_id || callerEnvObj.userId;
			
			if (!userId) {
				return new Response(JSON.stringify({
					statusCode: 401,
					error: 'Unauthorized',
					message: 'Authentication required'
				}), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			}

			// Call database function to schedule deletion
			const result = await DatabaseUtils.scheduleUserDeletion(userId, this.env, this.logger);
			
			if (!result.success) {
				return new Response(JSON.stringify({
					statusCode: 400,
					error: 'Bad Request',
					message: result.message
				}), {
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			}

			this.logger.log('INFO', 'Account deletion scheduled successfully', {
				userId,
				scheduledAt: result.scheduledAt
			});

			return new Response(JSON.stringify({
				statusCode: 200,
				message: result.message,
				data: {
					scheduledAt: result.scheduledAt,
					daysUntilDeletion: 7
				}
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `Account deletion scheduling failed: ${error.message}`);
			return new Response(JSON.stringify({
				statusCode: 500,
				error: 'Internal Server Error',
				message: error.message
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				}
			});
		}
	}

	/**
	 * Cancel scheduled account deletion
	 * DELETE /v1/account/delete
	 */
	async cancelAccountDeletion(request, caller_env = "{}", sagContext = "{}") {
		this.logger.log('INFO', 'Account deletion cancellation requested');
		
		try {
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});
			const sagContextObj = typeof sagContext === 'string' ? JSON.parse(sagContext || '{}') : (sagContext || {});
			
			// Get user ID from JWT
			const userId = sagContextObj.jwtPayload?.sub || sagContextObj.jwtPayload?.user_id || callerEnvObj.userId;
			
			if (!userId) {
				return new Response(JSON.stringify({
					statusCode: 401,
					error: 'Unauthorized',
					message: 'Authentication required'
				}), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			}

			// Call database function to cancel deletion
			const result = await DatabaseUtils.cancelUserDeletion(userId, this.env, this.logger);
			
			if (!result.success) {
				return new Response(JSON.stringify({
					statusCode: 400,
					error: 'Bad Request',
					message: result.message
				}), {
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			}

			this.logger.log('INFO', 'Account deletion cancelled successfully', { userId });

			return new Response(JSON.stringify({
				statusCode: 200,
				message: result.message
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `Account deletion cancellation failed: ${error.message}`);
			return new Response(JSON.stringify({
				statusCode: 500,
				error: 'Internal Server Error',
				message: error.message
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				}
			});
		}
	}

	/**
	 * Get account deletion status
	 * GET /v1/account/delete
	 */
	async getAccountDeletionStatus(request, caller_env = "{}", sagContext = "{}") {
		this.logger.log('INFO', 'Account deletion status requested');
		
		try {
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});
			const sagContextObj = typeof sagContext === 'string' ? JSON.parse(sagContext || '{}') : (sagContext || {});
			
			// Get user ID from JWT
			const userId = sagContextObj.jwtPayload?.sub || sagContextObj.jwtPayload?.user_id || callerEnvObj.userId;
			
			if (!userId) {
				return new Response(JSON.stringify({
					statusCode: 401,
					error: 'Unauthorized',
					message: 'Authentication required'
				}), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					}
				});
			}

			// Get deletion status
			const status = await DatabaseUtils.getUserDeletionStatus(userId, this.env, this.logger);

			return new Response(JSON.stringify({
				statusCode: 200,
				message: 'Deletion status retrieved',
				data: status
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `Account deletion status failed: ${error.message}`);
			return new Response(JSON.stringify({
				statusCode: 500,
				error: 'Internal Server Error',
				message: error.message
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*'
				}
			});
		}
	}

	async usageSummary(request, caller_env = "{}", sagContext = "{}") {
		this.logger.log('INFO', 'Usage summary requested');
		
		try {
			// Parse caller environment
			const callerEnvObj = JSON.parse(caller_env || '{}');
			
			// Check if user is authenticated
			if (!callerEnvObj.userId) {
				return new Response(JSON.stringify({
					statusCode: 401,
					error: 'Unauthorized',
					message: 'Authentication required'
				}), {
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization'
					}
				});
			}

			// Parse query parameters from URL
			const url = new URL(request.url);
			const period = url.searchParams.get('period') || 'all_time';

			// Validate period parameter
			const validPeriods = ['daily', 'weekly', 'monthly', 'all_time'];
			if (!validPeriods.includes(period)) {
				return new Response(JSON.stringify({
					statusCode: 400,
					error: 'Bad Request',
					message: `Invalid period. Must be one of: ${validPeriods.join(', ')}`
				}), {
					status: 400,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization'
					}
				});
			}

			// Get usage summary from database
			const summary = await DatabaseUtils.getUserUsageSummary(
				callerEnvObj.userId,
				{ period },
				this.env,
				this.logger
			);

			if (!summary) {
				return new Response(JSON.stringify({
					statusCode: 500,
					error: 'Internal Server Error',
					message: 'Failed to retrieve usage summary'
				}), {
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization'
					}
				});
			}

			if (summary.error) {
				return new Response(JSON.stringify({
					statusCode: 500,
					error: 'Internal Server Error',
					message: summary.error,
					data: summary
				}), {
					status: 500,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization'
					}
				});
			}

			this.logger.log('INFO', 'Usage summary retrieved successfully', {
				userId: callerEnvObj.userId,
				period,
				totalFaxesSent: summary.totalFaxesSent
			});

			return new Response(JSON.stringify({
				statusCode: 200,
				message: 'Usage summary retrieved successfully',
				data: summary
			}), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		} catch (error) {
			this.logger.log('ERROR', `Usage summary retrieval failed: ${error.message}`);
			return new Response(JSON.stringify({
				statusCode: 500,
				error: 'Internal Server Error',
				message: error.message,
				service: 'management'
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization'
				}
			});
		}
	}
} 
