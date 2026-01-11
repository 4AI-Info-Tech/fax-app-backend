/**
 * Fax Service - Compatible with Serverless API Gateway
 */

import { env, WorkerEntrypoint } from "cloudflare:workers";
import { Logger } from './utils.js';
import { DatabaseUtils, FaxDatabaseUtils } from './database.js';
import { NotifyreProvider } from './providers/notifyre-provider.js';
import { TelnyxProvider } from './providers/telnyx-provider.js';
import { R2Utils } from './r2-utils.js';
import { NotificationService } from './notifications.js';
import { digitsOnly, calculateRate, getRateTables, calculateCreditPerPage } from './rates.js';

export default class extends WorkerEntrypoint {
	constructor(ctx, env) {
		super(ctx, env);
		this.logger = null;
		this.env = env;
		this.initializeLogger(env);
		this.notificationService = null;
	}

	async fetch(request, env) {
		this.initializeLogger(env);
		this.logger.log('INFO', 'Fetch request received');
		return new Response("Hello from Fax Service");
	}

	initializeLogger(env) {
		if (!this.logger) {
			this.logger = new Logger(env);
		}
		// Initialize notification service after logger is available
		if (!this.notificationService && this.logger) {
			this.notificationService = new NotificationService(this.logger);
		}
	}

	/**
	 * Send push notification for fax status change
	 * Handles notification sending gracefully - failures don't affect webhook processing
	 * @param {Object} fax - Fax record with status information
	 * @param {Object} callerEnvObj - Environment variables
	 * @returns {Promise<void>}
	 */
	async sendFaxStatusPushNotification(fax, callerEnvObj) {
		try {
			// Only send notifications for terminal statuses (delivered or failed)
			const terminalStatuses = ['delivered', 'failed'];
			if (!terminalStatuses.includes(fax.status)) {
				this.logger.log('DEBUG', 'Skipping notification for non-terminal status', {
					faxId: fax.id,
					status: fax.status
				});
				return;
			}

			// Ensure notification service is initialized
			if (!this.notificationService) {
				this.notificationService = new NotificationService(this.logger);
			}

			// Send the notification
			const result = await this.notificationService.sendFaxStatusNotification(callerEnvObj, fax);

			if (result.success) {
				this.logger.log('INFO', 'Push notification sent for fax status change', {
					faxId: fax.id,
					status: fax.status,
					userId: fax.user_id
				});
			} else if (result.skipped) {
				this.logger.log('DEBUG', 'Push notification skipped', {
					faxId: fax.id,
					reason: result.reason
				});
			} else {
				this.logger.log('WARN', 'Failed to send push notification', {
					faxId: fax.id,
					error: result.error
				});
			}
		} catch (error) {
			// Log error but don't throw - notification failures shouldn't break webhook processing
			this.logger.log('ERROR', 'Error sending push notification', {
				faxId: fax?.id,
				error: error.message
			});
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



	async createFaxProvider(apiProviderName, caller_env) {
		let apiKey;
		let options = {};

		switch (apiProviderName) {
			case 'notifyre':
				// env parameter contains caller environment (passed from sendFax)
				apiKey = caller_env.NOTIFYRE_API_KEY;
				break;
			case 'telnyx':
				// env parameter contains caller environment (passed from sendFax)
				apiKey = caller_env.TELNYX_API_KEY;
				options = {
					connectionId: caller_env.TELNYX_CONNECTION_ID,
					senderId: caller_env.TELNYX_SENDER_ID,
					r2Utils: new R2Utils(this.logger, this.env), // Service-level binding
					env: caller_env
				};
				break;
			default:
				throw new Error(`Unsupported API provider: ${apiProviderName}`);
		}

		if (!apiKey) {
			throw new Error(`API key not found for ${apiProviderName} provider`);
		}

		if (apiProviderName=== 'telnyx') {
			if (!options.connectionId) {
				throw new Error('TELNYX_CONNECTION_ID is required for Telnyx provider');
			}
			if (!options.r2Utils.validateConfiguration()) {
				throw new Error('R2 configuration is invalid for Telnyx provider');
			}
		}

		if (apiProviderName === 'notifyre') {
			return new NotifyreProvider(apiKey, this.logger);
		}
		if (apiProviderName === 'telnyx') {
			return new TelnyxProvider(apiKey, this.logger, options);
		}
		throw new Error(`Unsupported API provider: ${apiProviderName}`);
	}

	normaliseProviderName(raw) {
		if (!raw || typeof raw !== 'string') return null;
		const name = raw.trim().toLowerCase();
		if (name === 'telynx') return 'telnyx';
		return name;
	}

	async getApiProviderName(request, requestBody, caller_env) {
		let apiProviderName = null;
		let source = null;

		// 1. Check URL search params first
		const urlObj = new URL(request.url);
		apiProviderName = urlObj.searchParams.get('provider');
		if (apiProviderName) {
			source = 'URL search parameter';
			this.logger.log('DEBUG', 'API provider name found in URL search params', { 
				provider: apiProviderName, 
				source 
			});

			return apiProviderName;
		}

		// 2. Check request body if not found in URL
		if (!apiProviderName) {
			if (requestBody instanceof FormData) {
				apiProviderName = requestBody.get('provider') || requestBody.get('apiProvider');
				if (apiProviderName) {
					source = requestBody.get('provider') ? 'FormData provider field' : 'FormData apiProvider field';
				}
			} else if (typeof requestBody === 'object' && requestBody !== null) {
				apiProviderName = requestBody.provider || requestBody.apiProvider;
				if (apiProviderName) {
					source = requestBody.provider ? 'JSON body provider field' : 'JSON body apiProvider field';
				}
			}

			if (apiProviderName) {
				this.logger.log('DEBUG', 'API provider name found in request body', { 
					provider: apiProviderName, 
					source 
				});
				return apiProviderName;
			}
		}

		// 3. Fall back to environment variable
		if (!apiProviderName) {
			apiProviderName = caller_env.FAX_PROVIDER || 'notifyre';
			source = caller_env.FAX_PROVIDER ? 'Environment variable FAX_PROVIDER' : 'Default fallback';
			this.logger.log('DEBUG', 'API provider name using fallback', { 
				provider: apiProviderName, 
				source 
			});
		}

		// 4. Normalize the provider name
		const normalizedProvider = this.normaliseProviderName(apiProviderName) || 'notifyre';
		if (normalizedProvider !== apiProviderName) {
			this.logger.log('DEBUG', 'API provider name normalized', { 
				original: apiProviderName,
				normalized: normalizedProvider,
				source: source + ' (normalized)'
			});
			source = source + ' (normalized)';
		}

		this.logger.log('INFO', 'Final API provider name determined', { 
			provider: normalizedProvider, 
			source 
		});

		return normalizedProvider;
	}

	async sendFax(request, caller_env, sagContext) {
		try {
			// Ensure we have usable objects regardless of whether inputs are strings
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});
			const sagContextObj = typeof sagContext === 'string' ? JSON.parse(sagContext || '{}') : (sagContext || {});

			// Store for access in helper methods
			this.callerEnvObj = callerEnvObj;

			this.logger.log('INFO', 'Send fax request received', {
				method: request.method,
				url: request.url,
				hasBody: !!request.body,
				contentType: request.headers.get('content-type')
			});

			const requestBody = await this.parseRequestBody(request);

			const apiProviderName = await this.getApiProviderName(request, requestBody, callerEnvObj);

			const faxProvider = await this.createFaxProvider(apiProviderName, callerEnvObj);
			const faxRequest = await faxProvider.prepareFaxRequest(requestBody);

			const userId = sagContextObj.jwtPayload?.sub || sagContextObj.jwtPayload?.user_id || sagContextObj.user?.id || null;
			
			// Calculate total pages and document count from files
			const documentCount = faxRequest.files?._documentCount || (faxRequest.files?.length || 0) || 1;
			const totalPages = faxRequest.files?._totalPages || faxRequest.pages || 1;
			
			// Get recipient phone number and calculate credits required
			const recipientNumber = faxRequest.recipients?.[0] || null;
			const creditCalculation = await this.calculateFaxCredits(
				recipientNumber,
				totalPages,
				callerEnvObj,
				request
			);
			
			const creditPerPage = creditCalculation.creditPerPage;
			const creditsRequired = creditCalculation.creditsRequired;
			const rateInfo = creditCalculation.rateInfo;
			
			// Check user credits before sending fax
			// Note: The database stores credits as pages, so we need to check if availablePages >= creditsRequired
			// Use caller environment for database operations (contains Supabase configuration)
			let creditCheck = await FaxDatabaseUtils.checkUserCredits(userId, creditsRequired, callerEnvObj, this.logger);
			
			// If user has no active subscriptions, try to create a freemium subscription
			if (!creditCheck.hasCredits && creditCheck.error === 'No active subscriptions found' && userId) {
				this.logger.log('INFO', 'No active subscriptions found, attempting to create freemium subscription', {
					userId: userId
				});
				
				try {
					// Call the database function to create freemium subscription
					const { createClient } = await import('@supabase/supabase-js');
					const supabase = createClient(callerEnvObj.SUPABASE_URL, callerEnvObj.SUPABASE_SERVICE_ROLE_KEY, {
						auth: {
							autoRefreshToken: false,
							persistSession: false
						}
					});
					
					const { data: freemiumResult, error: freemiumError } = await supabase
						.rpc('create_freemium_subscription_for_user', { user_uuid: userId });
					
					if (freemiumError) {
						this.logger.log('ERROR', 'Failed to create freemium subscription', {
							userId: userId,
							error: freemiumError.message
						});
					} else if (freemiumResult && freemiumResult.length > 0 && freemiumResult[0].created) {
						this.logger.log('INFO', 'Freemium subscription created successfully', {
							userId: userId,
							subscriptionId: freemiumResult[0].subscription_id
						});
						
						// Re-check credits after creating freemium subscription
						creditCheck = await FaxDatabaseUtils.checkUserCredits(userId, creditsRequired, callerEnvObj, this.logger);
					} else {
						this.logger.log('INFO', 'Freemium subscription not created (user may already have subscriptions)', {
							userId: userId
						});
					}
				} catch (error) {
					this.logger.log('ERROR', 'Error creating freemium subscription', {
						userId: userId,
						error: error.message
					});
				}
			}
			
			if (!creditCheck.hasCredits) {
				this.logger.log('WARN', 'Insufficient credits for fax', {
					userId: userId,
					pages: totalPages,
					creditPerPage: creditPerPage,
					creditsRequired: creditsRequired,
					availablePages: creditCheck.availablePages,
					error: creditCheck.error
				});
				
				// Check if user has freemium subscription to provide specific messaging
				const isFreemiumUser = creditCheck.subscriptions && 
					creditCheck.subscriptions.some(sub => sub.product_id === 'freemium_monthly');
				
				let errorMessage = creditCheck.error || "You don't have enough credits to send this fax";
				let errorTitle = "Insufficient credits";
				
				if (isFreemiumUser) {
					// For freemium users, check pages (not credits) since they have a page limit
					if (totalPages > 5) {
						errorTitle = "Page limit exceeded";
						errorMessage = `Your free plan allows up to 5 pages per month. You're trying to send ${totalPages} pages. Please upgrade to a paid plan for higher limits.`;
					} else {
						errorTitle = "Monthly limit reached";
						errorMessage = `You've used all 5 free pages for this month. Your limit will reset in 30 days from when you signed up, or upgrade to a paid plan for more pages.`;
					}
				}
				
				return {
					statusCode: 402,
					error: errorTitle,
					message: errorMessage,
					data: {
						pages: totalPages,
						creditPerPage: creditPerPage,
						creditsRequired: creditsRequired,
						availablePages: creditCheck.availablePages,
						subscriptionId: creditCheck.subscriptionId,
						isFreemiumUser: isFreemiumUser,
						upgradeRequired: isFreemiumUser
					},
					timestamp: new Date().toISOString()
				};
			}
			
			this.logger.log('INFO', 'Credit check passed', {
				userId: userId,
				pages: totalPages,
				creditPerPage: creditPerPage,
				creditsRequired: creditsRequired,
				availablePages: creditCheck.availablePages,
				subscriptionId: creditCheck.subscriptionId
			});
			
			let faxResult;

			if (faxProvider.getProviderName() === 'telnyx') {
				this.logger.log('INFO', 'Using Telnyx custom workflow');
				faxResult = await faxProvider.sendFaxWithCustomWorkflow(faxRequest, userId, creditsRequired);
			} else {
				this.logger.log('INFO', 'Using standard provider workflow');
				const providerPayload = await faxProvider.buildPayload(faxRequest);
				faxResult = await faxProvider.sendFax(providerPayload);
				await this.saveFaxRecordForStandardWorkflow(faxResult, faxRequest, userId, faxProvider.getProviderName(), callerEnvObj, creditsRequired);
			}

			if (!faxResult.id) {
				this.logger.log('ERROR', 'Fax provider did not return a valid fax ID');
				throw new Error('Fax provider did not return a valid fax ID');
			}

			this.logger.log('INFO', 'Fax submitted successfully', { 
				faxId: faxResult.id, 
				friendlyId: faxResult.friendlyId,
				apiProvider: faxProvider.getProviderName()
			});

			// Note: Credit usage is NOT updated here - it will be updated when the fax is actually delivered
			// via webhook handlers. This ensures failed faxes don't count against user's quota.
			this.logger.log('INFO', 'Fax submitted - usage will be recorded when delivered via webhook', {
				userId: userId,
				subscriptionId: creditCheck.subscriptionId,
				pages: totalPages,
				creditPerPage: creditPerPage,
				creditsRequired: creditsRequired
			});

			return {
				statusCode: 200,
				message: "Fax submitted successfully",
				data: {
					id: faxResult.id,
					friendlyId: faxResult.friendlyId,
					status: faxResult.status || 'queued',
					originalStatus: faxResult.originalStatus || 'Submitted',
					message: "Fax is now queued for processing",
					timestamp: new Date().toISOString(),
					recipient: faxRequest.recipients?.[0] || 'unknown',
					pages: totalPages,
					document_count: documentCount,
					creditPerPage: creditPerPage,
					creditsRequired: creditsRequired,
					creditsUsed: creditsRequired,
					rateInfo: rateInfo,
					cost: null,
					apiProvider: faxProvider.getProviderName(),
					providerResponse: faxResult.providerResponse
				}
			};

		} catch (error) {
			this.logger.log('ERROR', 'Error in sendFax', {
				errorMessage: error.message,
				errorStack: error.stack
			});

			return {
				statusCode: 500,
				error: "Fax sending failed",
				message: error.message,
				details: error.stack,
				timestamp: new Date().toISOString()
			};
		}
	}

	async debug(request, caller_env = "{}", sagContext = "{}") {
		console.log("[FAX-SERVICE][DEBUG] Caller Environment:", caller_env);
		console.log("[FAX-SERVICE][DEBUG] SAG Context:", sagContext);
		console.log("[FAX-SERVICE][DEBUG] Service Environment:", this.env);

		return {
			statusCode: 200,
			message: "Debug information logged successfully",
			data: {
				callerEnv: JSON.stringify(caller_env),
				sagContext: JSON.stringify(sagContext),
				env: JSON.stringify(this.env),
				timestamp: new Date().toISOString()
			}
		};
	}

	async health(request, caller_env, sagContext) {
		try {
			
			this.logger.log('INFO', 'Health check request received');

			return {
				statusCode: 200,
				message: "Fax service healthy",
				data: {
					service: "fax",
					timestamp: new Date().toISOString(),
					version: "2.0.0",
					currentApiProvider: caller_env?.FAX_PROVIDER || 'notifyre',
					supportedApiProviders: ['notifyre', 'telnyx'],
					features: [
						"send-fax",
						"webhooks",
						"multi-api-provider-support"
					]
				}
			};
		} catch (error) {
			if (this.logger) {
				this.logger.log('ERROR', 'Error in health check:', error);
			} else {
				console.error('Error in health check:', error);
			}
			return {
				statusCode: 500,
				error: "Health check failed",
				message: error.message
			};
		}
	}

	async healthProtected(request, caller_env, sagContext) {
		try {
			
			this.logger.log('INFO', 'Protected health check request received');

			return {
				statusCode: 200,
				message: "Fax service healthy (authenticated)",
				data: {
					service: "fax",
					user: sagContext.jwtPayload || null,
					timestamp: new Date().toISOString(),
					version: "2.0.0",
					authenticated: true,
					currentApiProvider: caller_env?.FAX_PROVIDER || 'notifyre',
					supportedApiProviders: ['notifyre', 'telnyx'],
					features: [
						"send-fax",
						"webhooks",
						"multi-api-provider-support"
					]
				}
			};
		} catch (error) {
			if (this.logger) {
				this.logger.log('ERROR', 'Error in healthProtected:', error);
			} else {
				console.error('Error in healthProtected:', error);
			}
			return {
				statusCode: 500,
				error: "Authenticated health check failed",
				message: error.message
			};
		}
	}

	async uploadFilesToR2(request, caller_env, sagContext) {
		try {
			

			this.logger.log('INFO', 'Upload-to-R2 debug endpoint called', {
				method: request.method,
				url: request.url,
				contentType: request.headers.get('content-type')
			});

			const requestBody = await this.parseRequestBody(request);
			
			// Create a temporary provider for request preparation (defaulting to notifyre)
			const tempProvider = await this.createFaxProvider('notifyre', { NOTIFYRE_API_KEY: 'temp' });
			const faxRequest = await tempProvider.prepareFaxRequest(requestBody);

			if (!faxRequest.files || faxRequest.files.length === 0) {
				throw new Error('No files provided in request');
			}

			const r2Utils = new R2Utils(this.logger, this.env);

			if (!r2Utils.validateConfiguration()) {
				throw new Error('R2 configuration invalid – check FAX_FILES_BUCKET binding');
			}

			const uploaded = [];
			for (let i = 0; i < faxRequest.files.length; i++) {
				const file = faxRequest.files[i];
				let buffer;
				let contentType = 'application/pdf';

				if (file instanceof Blob || (file && typeof file.arrayBuffer === 'function')) {
					buffer = await file.arrayBuffer();
					contentType = file.type || contentType;
				} else if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
					buffer = file;
				} else {
					buffer = new TextEncoder().encode(String(file));
					contentType = 'text/plain';
				}

				const timestamp = Date.now();
				const filename = `debug/${timestamp}_${i + 1}` + (contentType === 'application/pdf' ? '.pdf' : '');

				const url = await r2Utils.uploadFile(filename, buffer, contentType);
				uploaded.push({ filename, url });
			}

			this.logger.log('INFO', 'Files uploaded to R2 via debug endpoint', { count: uploaded.length });

			return {
				statusCode: 200,
				message: 'Files uploaded successfully',
				data: {
					fileCount: uploaded.length,
					files: uploaded,
					timestamp: new Date().toISOString()
				}
			};

		} catch (error) {
			if (this.logger) {
				this.logger.log('ERROR', 'Upload-to-R2 debug endpoint failed', {
					error: error.message,
					stack: error.stack
				});
			}

			return {
				statusCode: 500,
				error: 'File upload failed',
				message: error.message
			};
		}
	}

	async saveFaxRecordForStandardWorkflow(faxResult, faxRequest, userId, providerName, callerEnvObj, creditsRequired = 0) {
		try {
			this.logger.log('DEBUG', 'Saving fax record for standard workflow', {
				userId: userId || 'anonymous',
				providerName,
				creditsRequired
			});

			// Calculate document count and total pages from files
			const documentCount = faxRequest.files?._documentCount || (faxRequest.files?.length || 0) || 1;
			const totalPages = faxRequest.files?._totalPages || 1;

			const faxDataForSave = {
				id: faxResult.id,
				status: faxResult.status || 'queued',
				originalStatus: faxResult.originalStatus || 'Submitted',
				recipients: faxRequest.recipients || [],
				senderId: faxRequest.senderId,
				subject: faxRequest.subject || faxRequest.message,
				pages: totalPages,
				document_count: documentCount,
				cost: Math.ceil(creditsRequired) || 0,
				clientReference: faxRequest.clientReference || 'SendFaxPro',
				sentAt: new Date().toISOString(),
				completedAt: null,
				errorMessage: null,
				providerResponse: faxResult.providerResponse,
				friendlyId: faxResult.friendlyId,
				apiProvider: providerName
			};

			// Use caller environment for database operations (contains Supabase configuration)
			const savedFaxRecord = await DatabaseUtils.saveFaxRecord(faxDataForSave, userId, callerEnvObj, this.logger);

			this.logger.log('DEBUG', 'Fax record saved successfully', {
				faxId: savedFaxRecord?.id,
				providerName
			});

			return savedFaxRecord;

		} catch (error) {
			this.logger.log('ERROR', 'Failed to save fax record', {
				error: error.message,
				providerName
			});
			return null;
		}
	}

	async telnyxWebhook(request, caller_env = "{}", sagContext = "{}") {
		try {
			
			// Ensure caller_env is an object for downstream DB utils
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});

			this.logger.log('INFO', 'Telnyx webhook received (sending events only)');

			// Parse JSON body safely
			const body = await request.json();

			const eventType = body?.data?.event_type || 'unknown';
			// Handle both nested payload structure and direct payload structure
			const payload = body?.data?.payload || body?.payload || body || {};
			const telnyxFaxId = payload.fax_id || null;
			const statusFromPayload = payload.hasOwnProperty('status') ? payload.status : null;
			const failureReason = payload.hasOwnProperty('failure_reason') ? payload.failure_reason : null;
			const pageCount = payload.hasOwnProperty('page_count') ? payload.page_count : null;
			const toNumber = payload.to || null;

			// Check if this is a fax receiving event and if the 'to' number matches our sender ID
			const receivingEvents = ['fax.receiving.started', 'fax.media.processing.started', 'fax.received', 'fax.failed'];
			const isReceivingEvent = receivingEvents.includes(eventType);
			const isOurNumber = toNumber === callerEnvObj.TELNYX_SENDER_ID;

			if (isReceivingEvent && isOurNumber) {
				this.logger.log('INFO', 'Fax receiving event detected in main webhook, redirecting to public receive endpoint', {
					eventType,
					toNumber,
					senderId: callerEnvObj.TELNYX_SENDER_ID
				});
				// Redirect receiving events to the public endpoint
				return await this.telnyxFaxReceiveWebhook(request, caller_env, sagContext);
			}

			// Only process sending-related events in this webhook
			if (!telnyxFaxId) {
				this.logger.log('ERROR', 'Telnyx webhook missing fax_id in payload');
				return { statusCode: 400, error: 'Invalid webhook payload: missing fax_id' };
			}

			// Create a temporary TelnyxProvider instance to reuse its status mapping helper
			const tempProvider = new TelnyxProvider('temp', this.logger, { connectionId: 'temp' });
			// Use failure_reason for status mapping if available (it provides more specific error info),
			// otherwise use the status field
			const statusForMapping = failureReason || statusFromPayload;
			const standardizedStatus = tempProvider.mapStatus(statusForMapping);

			// Build update data for Supabase - only include fields that exist in the payload
			const updateData = {
				status: standardizedStatus,
				metadata: payload
			};

			// Only include original_status if status exists in payload
			if (statusFromPayload !== null) {
				updateData.original_status = statusFromPayload;
			}

			// Always save failure_reason as error_message when status is "failed" and failure_reason exists
			// Also save it if it exists regardless of status (for edge cases)
			if (failureReason !== null) {
				updateData.error_message = failureReason;
			} else if (standardizedStatus === 'failed' && statusFromPayload === 'failed') {
				// If status is "failed" but no failure_reason provided, log a warning
				this.logger.log('WARN', 'Fax status is "failed" but no failure_reason provided in webhook', {
					faxId: telnyxFaxId,
					eventType
				});
			}

			// Only include completed_at if status is terminal
			if (['delivered', 'failed', 'cancelled'].includes(standardizedStatus)) {
				updateData.completed_at = new Date().toISOString();
			}

			// Add page count if available and valid in the webhook payload
			// Don't update page_count to 0 when status is "failed"
			if (pageCount !== null && pageCount !== undefined && pageCount > 0) {
				updateData.pages = pageCount;
			} else if (pageCount === 0 && standardizedStatus !== 'failed') {
				// Only update to 0 if status is not "failed"
				updateData.pages = 0;
			}

			// Update fax record using provider_fax_id as lookup key
			const updatedFaxRecord = await DatabaseUtils.updateFaxRecord(telnyxFaxId, updateData, callerEnvObj, this.logger, 'provider_fax_id');

			// Log updated fax record for debugging
			this.logger.log('DEBUG', 'Fax record updated from webhook', {
				telnyxFaxId,
				hasUpdatedFaxRecord: !!updatedFaxRecord,
				hasUserId: !!(updatedFaxRecord && updatedFaxRecord.user_id),
				hasRecipients: !!(updatedFaxRecord && updatedFaxRecord.recipients),
				recipientsType: updatedFaxRecord?.recipients ? typeof updatedFaxRecord.recipients : 'none',
				recipientsValue: updatedFaxRecord?.recipients,
				status: standardizedStatus
			});

			// Store webhook event for audit/logging
			await DatabaseUtils.storeWebhookEvent({
				event: eventType,
				faxId: telnyxFaxId,
				processedData: updateData,
				rawPayload: body
			}, callerEnvObj, this.logger);

			// Record usage if fax was successfully delivered
			if (standardizedStatus === 'delivered' && updatedFaxRecord && updatedFaxRecord.user_id) {
				// Use cost from fax record (credit cost), fallback to pageCount if cost is not available
				const creditsToDeduct = updatedFaxRecord.cost !== undefined && updatedFaxRecord.cost !== null 
					? Math.ceil(updatedFaxRecord.cost) 
					: (pageCount || updatedFaxRecord.pages || 1);
				const finalPageCount = pageCount || updatedFaxRecord.pages || 1;
				
				// Record usage in analytics table (using page count for analytics)
				await DatabaseUtils.recordUsage({
					userId: updatedFaxRecord.user_id,
					type: 'fax',
					unitType: 'page',
					usageAmount: finalPageCount,
					timestamp: new Date().toISOString(),
					metadata: {
						fax_id: telnyxFaxId,
						provider: 'telnyx',
						event_type: eventType,
						status: standardizedStatus,
						credits_deducted: creditsToDeduct
					}
				}, callerEnvObj, this.logger);
				
				// Update subscription's credits_used field (using actual credit cost)
				try {
					// Find the user's active subscription to update
					const { createClient } = await import('@supabase/supabase-js');
					const supabase = createClient(callerEnvObj.SUPABASE_URL, callerEnvObj.SUPABASE_SERVICE_ROLE_KEY, {
						auth: {
							autoRefreshToken: false,
							persistSession: false
						}
					});
					
					// Get user's active subscriptions
					// Filter: is_active = true AND (expires_at IS NULL OR expires_at > NOW())
					// This handles both non-expiring subscriptions (NULL) and UNSUBSCRIBE cancellations (expires_at set)
					const { data: allSubscriptions, error: subError } = await supabase
						.from('user_subscriptions')
						.select('id, credits_used, expires_at')
						.eq('user_id', updatedFaxRecord.user_id)
						.eq('is_active', true)
						.order('created_at', { ascending: false });
					
					// Filter subscriptions: include if expires_at is NULL (doesn't expire) or expires_at > NOW()
					const now = new Date();
					const subscriptions = (allSubscriptions || []).filter(sub => {
						if (!sub.expires_at) {
							// NULL expires_at means subscription doesn't expire - include it
							return true;
						}
						// Check if expiration date is in the future
						const expiresAt = new Date(sub.expires_at);
						return expiresAt > now;
					});
					
					if (!subError && subscriptions && subscriptions.length > 0) {
						// Update the first (most recent) active subscription
						const subscription = subscriptions[0];
						const newCreditsUsed = (subscription.credits_used || 0) + creditsToDeduct;
						
						const { error: updateError } = await supabase
							.from('user_subscriptions')
							.update({ 
								credits_used: newCreditsUsed,
								updated_at: new Date().toISOString()
							})
							.eq('id', subscription.id);
						
						if (updateError) {
							this.logger.log('ERROR', 'Failed to update subscription credits_used in webhook', {
								userId: updatedFaxRecord.user_id,
								subscriptionId: subscription.id,
								creditsUsed: creditsToDeduct,
								error: updateError.message
							});
						} else {
							this.logger.log('INFO', 'Added used credits to subscription credits_used in webhook', {
								userId: updatedFaxRecord.user_id,
								subscriptionId: subscription.id,
								creditsAdded: creditsToDeduct,
								previousCreditsUsed: subscription.credits_used || 0,
								newCreditsUsed: newCreditsUsed
							});
						}
					}
				} catch (error) {
					this.logger.log('ERROR', 'Error updating subscription credits_used in webhook', {
						userId: updatedFaxRecord.user_id,
						error: error.message
					});
				}
			}

			// Send push notification for terminal statuses (delivered or failed)
			if (updatedFaxRecord && updatedFaxRecord.user_id && ['delivered', 'failed'].includes(standardizedStatus)) {
				// Ensure recipients is an array (handle JSONB from database)
				let recipients = updatedFaxRecord.recipients || [];
				
				// Parse if recipients is a JSON string
				if (typeof recipients === 'string') {
					try {
						recipients = JSON.parse(recipients);
					} catch (e) {
						this.logger.log('WARN', 'Failed to parse recipients JSON string', {
							faxId: updatedFaxRecord.id,
							recipientsString: recipients,
							error: e.message
						});
						recipients = [];
					}
				}
				
				// Ensure recipients is an array
				if (!Array.isArray(recipients)) {
					this.logger.log('WARN', 'Recipients is not an array, converting', {
						faxId: updatedFaxRecord.id,
						recipientsType: typeof recipients,
						recipientsValue: recipients
					});
					recipients = recipients ? [recipients] : [];
				}
				
				// Fallback: if no recipients in database, try to get from webhook payload
				if (recipients.length === 0) {
					const toNumber = payload.to || null;
					if (toNumber) {
						this.logger.log('INFO', 'Using recipient from webhook payload as fallback', {
							faxId: updatedFaxRecord.id,
							toNumber
						});
						recipients = [toNumber];
					}
				}
				
				this.logger.log('INFO', 'Preparing to send push notification from webhook', {
					faxId: updatedFaxRecord.id,
					userId: updatedFaxRecord.user_id,
					status: standardizedStatus,
					recipientsCount: recipients.length,
					recipients: recipients,
					hasErrorMessage: !!updateData.error_message
				});
				
				await this.sendFaxStatusPushNotification({
					id: updatedFaxRecord.id,
					user_id: updatedFaxRecord.user_id,
					status: standardizedStatus,
					recipients: recipients,
					error_message: updateData.error_message
				}, callerEnvObj);
			} else {
				this.logger.log('DEBUG', 'Skipping push notification from webhook', {
					hasUpdatedFaxRecord: !!updatedFaxRecord,
					hasUserId: !!(updatedFaxRecord && updatedFaxRecord.user_id),
					status: standardizedStatus,
					isTerminalStatus: ['delivered', 'failed'].includes(standardizedStatus)
				});
			}

			this.logger.log('INFO', 'Telnyx webhook processed successfully', { 
				telnyxFaxId, 
				eventType,
				pageCount: pageCount || 'not provided'
			});

			return {
				statusCode: 200,
				message: 'Webhook processed successfully',
				data: {
					faxId: telnyxFaxId,
					standardizedStatus,
					timestamp: new Date().toISOString()
				}
			};

		} catch (error) {
			if (this.logger) {
				this.logger.log('ERROR', 'Error processing Telnyx webhook', {
					error: error.message,
					stack: error.stack
				});
			}
			return {
				statusCode: 500,
				error: 'Webhook processing failed',
				message: error.message
			};
		}
	}

	async notifyreWebhook(request, caller_env = "{}", sagContext = "{}") {
		try {
			// Ensure caller_env is an object for downstream DB utils
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});

			this.logger.log('INFO', 'Notifyre webhook received');

			// Parse JSON body safely
			const body = await request.json();

			const eventType = body?.event || 'unknown';
			const payload = body?.data || {};
			const notifyreFaxId = payload.id || null;
			const statusFromPayload = payload.status || null;
			const pageCount = payload.pages || null;
			const userId = payload.user_id || null;

			if (!notifyreFaxId) {
				this.logger.log('ERROR', 'Notifyre webhook missing fax id in payload');
				return { statusCode: 400, error: 'Invalid webhook payload: missing fax id' };
			}

			// Map Notifyre status to standardized status
			let standardizedStatus = 'queued';
			switch (statusFromPayload?.toLowerCase()) {
				case 'sent':
				case 'delivered':
					standardizedStatus = 'delivered';
					break;
				case 'failed':
				case 'error':
					standardizedStatus = 'failed';
					break;
				case 'cancelled':
					standardizedStatus = 'cancelled';
					break;
				case 'processing':
					standardizedStatus = 'processing';
					break;
				default:
					standardizedStatus = statusFromPayload || 'queued';
			}

			// Build update data for Supabase
			const updateData = {
				status: standardizedStatus,
				original_status: statusFromPayload,
				metadata: payload,
				completed_at: ['delivered', 'failed', 'cancelled'].includes(standardizedStatus) ? new Date().toISOString() : null
			};

			// Add page count if available and valid in the webhook payload
			if (pageCount !== null && pageCount !== undefined && pageCount > 0) {
				updateData.pages = pageCount;
			}

			// Update fax record using provider_fax_id as lookup key
			const updatedFaxRecord = await DatabaseUtils.updateFaxRecord(notifyreFaxId, updateData, callerEnvObj, this.logger, 'provider_fax_id');

			// Store webhook event for audit/logging
			await DatabaseUtils.storeWebhookEvent({
				event: eventType,
				faxId: notifyreFaxId,
				processedData: updateData,
				rawPayload: body
			}, callerEnvObj, this.logger);

			// Record usage if fax was successfully delivered
			if (standardizedStatus === 'delivered' && updatedFaxRecord && updatedFaxRecord.user_id) {
				// Use cost from fax record (credit cost), fallback to pageCount if cost is not available
				const creditsToDeduct = updatedFaxRecord.cost !== undefined && updatedFaxRecord.cost !== null 
					? Math.ceil(updatedFaxRecord.cost) 
					: (pageCount || updatedFaxRecord.pages || 1);
				const finalPageCount = pageCount || updatedFaxRecord.pages || 1;
				
				// Record usage in analytics table (using page count for analytics)
				await DatabaseUtils.recordUsage({
					userId: updatedFaxRecord.user_id,
					type: 'fax',
					unitType: 'page',
					usageAmount: finalPageCount,
					timestamp: new Date().toISOString(),
					metadata: {
						fax_id: notifyreFaxId,
						provider: 'notifyre',
						event_type: eventType,
						status: standardizedStatus,
						credits_deducted: creditsToDeduct
					}
				}, callerEnvObj, this.logger);
				
				// Update subscription's credits_used field (using actual credit cost)
				try {
					// Find the user's active subscription to update
					const { createClient } = await import('@supabase/supabase-js');
					const supabase = createClient(callerEnvObj.SUPABASE_URL, callerEnvObj.SUPABASE_SERVICE_ROLE_KEY, {
						auth: {
							autoRefreshToken: false,
							persistSession: false
						}
					});
					
					// Get user's active subscriptions
					// Filter: is_active = true AND (expires_at IS NULL OR expires_at > NOW())
					// This handles both non-expiring subscriptions (NULL) and UNSUBSCRIBE cancellations (expires_at set)
					const { data: allSubscriptions, error: subError } = await supabase
						.from('user_subscriptions')
						.select('id, credits_used, expires_at')
						.eq('user_id', updatedFaxRecord.user_id)
						.eq('is_active', true)
						.order('created_at', { ascending: false });
					
					// Filter subscriptions: include if expires_at is NULL (doesn't expire) or expires_at > NOW()
					const now = new Date();
					const subscriptions = (allSubscriptions || []).filter(sub => {
						if (!sub.expires_at) {
							// NULL expires_at means subscription doesn't expire - include it
							return true;
						}
						// Check if expiration date is in the future
						const expiresAt = new Date(sub.expires_at);
						return expiresAt > now;
					});
					
					if (!subError && subscriptions && subscriptions.length > 0) {
						// Update the first (most recent) active subscription
						const subscription = subscriptions[0];
						const newCreditsUsed = (subscription.credits_used || 0) + creditsToDeduct;
						
						const { error: updateError } = await supabase
							.from('user_subscriptions')
							.update({ 
								credits_used: newCreditsUsed,
								updated_at: new Date().toISOString()
							})
							.eq('id', subscription.id);
						
						if (updateError) {
							this.logger.log('ERROR', 'Failed to update subscription credits_used in webhook', {
								userId: updatedFaxRecord.user_id,
								subscriptionId: subscription.id,
								creditsUsed: creditsToDeduct,
								error: updateError.message
							});
						} else {
							this.logger.log('INFO', 'Added used credits to subscription credits_used in webhook', {
								userId: updatedFaxRecord.user_id,
								subscriptionId: subscription.id,
								creditsAdded: creditsToDeduct,
								previousCreditsUsed: subscription.credits_used || 0,
								newCreditsUsed: newCreditsUsed
							});
						}
					}
				} catch (error) {
					this.logger.log('ERROR', 'Error updating subscription credits_used in webhook', {
						userId: updatedFaxRecord.user_id,
						error: error.message
					});
				}
			}

			// Send push notification for terminal statuses (delivered or failed)
			if (updatedFaxRecord && updatedFaxRecord.user_id && ['delivered', 'failed'].includes(standardizedStatus)) {
				// Ensure recipients is an array (handle JSONB from database)
				let recipients = updatedFaxRecord.recipients || [];
				
				// Parse if recipients is a JSON string
				if (typeof recipients === 'string') {
					try {
						recipients = JSON.parse(recipients);
					} catch (e) {
						this.logger.log('WARN', 'Failed to parse recipients JSON string', {
							faxId: updatedFaxRecord.id,
							recipientsString: recipients,
							error: e.message
						});
						recipients = [];
					}
				}
				
				// Ensure recipients is an array
				if (!Array.isArray(recipients)) {
					this.logger.log('WARN', 'Recipients is not an array, converting', {
						faxId: updatedFaxRecord.id,
						recipientsType: typeof recipients,
						recipientsValue: recipients
					});
					recipients = recipients ? [recipients] : [];
				}
				
				this.logger.log('INFO', 'Preparing to send push notification from webhook', {
					faxId: updatedFaxRecord.id,
					userId: updatedFaxRecord.user_id,
					status: standardizedStatus,
					recipientsCount: recipients.length,
					recipients: recipients
				});
				
				await this.sendFaxStatusPushNotification({
					id: updatedFaxRecord.id,
					user_id: updatedFaxRecord.user_id,
					status: standardizedStatus,
					recipients: recipients,
					error_message: null // Notifyre doesn't provide error message in the same way
				}, callerEnvObj);
			} else {
				this.logger.log('DEBUG', 'Skipping push notification from webhook', {
					hasUpdatedFaxRecord: !!updatedFaxRecord,
					hasUserId: !!(updatedFaxRecord && updatedFaxRecord.user_id),
					status: standardizedStatus,
					isTerminalStatus: ['delivered', 'failed'].includes(standardizedStatus)
				});
			}

			this.logger.log('INFO', 'Notifyre webhook processed successfully', { 
				notifyreFaxId, 
				eventType,
				pageCount: pageCount || 'not provided'
			});

			return {
				statusCode: 200,
				message: 'Webhook processed successfully',
				data: {
					faxId: notifyreFaxId,
					standardizedStatus,
					timestamp: new Date().toISOString()
				}
			};

		} catch (error) {
			if (this.logger) {
				this.logger.log('ERROR', 'Error processing Notifyre webhook', {
					error: error.message,
					stack: error.stack
				});
			}
			return {
				statusCode: 500,
				error: 'Webhook processing failed',
				message: error.message
			};
		}
	}

	async telnyxFaxReceiveWebhook(request, caller_env = "{}", sagContext = "{}") {
		try {
			// Ensure caller_env is an object for downstream DB utils
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});

			this.logger.log('INFO', 'Processing Telnyx fax receiving webhook (public endpoint)');

			// Parse JSON body safely
			const body = await request.json();

			const eventType = body?.data?.event_type || 'unknown';
			const payload = body?.data?.payload || {};
			const webhookId = body?.data?.id || null;
			const toNumber = payload.to || null;
			const fromNumber = payload.from || null;
			const faxId = payload.fax_id || null;
			const status = payload.status || null;
			const failureReason = payload.failure_reason || null;
			const pageCount = payload.page_count || null;
			const mediaUrl = payload.media_url || null;
			const timestamp = body?.data?.occurred_at || new Date().toISOString();

			// Check if this is a fax.received event with media_url
			if (eventType === 'fax.received' && mediaUrl) {
				this.logger.log('INFO', 'Processing fax.received event with media', {
					eventType,
					webhookId,
					fromNumber,
					pageCount,
					hasMediaUrl: !!mediaUrl
				});

				// Download and upload the fax file to R2
				const r2Utils = new R2Utils(this.logger, this.env);
				
				if (!r2Utils.validateConfiguration()) {
					throw new Error('R2 configuration invalid for fax receiving');
				}

				try {
					// Download the fax file from Telnyx
					this.logger.log('INFO', 'Downloading fax file from Telnyx', { mediaUrl });
					
					const response = await fetch(mediaUrl);
					if (!response.ok) {
						throw new Error(`Failed to download fax file: ${response.status} ${response.statusText}`);
					}

					const fileBuffer = await response.arrayBuffer();
					
					// Generate filename for R2 storage
					const timestamp = Date.now();
					const filename = `received/${timestamp}_${webhookId}.pdf`;
					
					// Upload to R2
					this.logger.log('INFO', 'Uploading fax file to R2', { filename });
					const r2MediaUrl = await r2Utils.uploadFile(filename, fileBuffer, 'application/pdf');
					
					this.logger.log('INFO', 'Fax file uploaded to R2 successfully', { 
						filename, 
						r2MediaUrl,
						originalMediaUrl: mediaUrl
					});

					// Save to database
					const receivedFaxData = {
						webhookId: webhookId,
						fromNumber: fromNumber,
						pageCount: pageCount || 1,
						mediaUrl: r2MediaUrl,
						originalMediaUrl: mediaUrl,
						receivedAt: new Date().toISOString(),
						provider: 'telnyx'
					};

					const savedRecord = await DatabaseUtils.saveReceivedFax(receivedFaxData, callerEnvObj, this.logger);
					
					if (savedRecord) {
						this.logger.log('INFO', 'Received fax record saved to database', {
							recordId: savedRecord.id,
							webhookId: savedRecord.webhook_id
						});

						// Check if we're in production environment before sending Slack notification
						const environment = callerEnvObj.ENVIRONMENT || this.env.ENVIRONMENT;
						
						if (environment === 'prod') {
							// Send Slack notification for successful fax receive in production
							await this.sendSlackNotificationForSuccessfulFaxReceive(
								callerEnvObj,
								{
									fromNumber,
									pageCount,
									webhookId: savedRecord.webhook_id,
									recordId: savedRecord.id,
									provider: 'telnyx'
								}
							);
						}
					} else {
						this.logger.log('ERROR', 'Failed to save received fax record to database');
					}

				} catch (downloadError) {
					this.logger.log('ERROR', 'Failed to process fax file', {
						error: downloadError.message,
						mediaUrl
					});
					// Continue processing even if file download/upload fails
				}
			} else {
				this.logger.log('INFO', 'Skipping fax processing - not a fax.received event or no media URL', {
					eventType,
					hasMediaUrl: !!mediaUrl
				});
			}

			// Log the parsed webhook data
			this.logger.log('INFO', 'Telnyx fax receiving webhook processed', {
				eventType,
				webhookId,
				toNumber,
				fromNumber,
				faxId,
				status,
				failureReason,
				pageCount,
				hasMediaUrl: !!mediaUrl,
				timestamp
			});

			return {
				statusCode: 200,
				message: 'Fax receiving webhook processed successfully',
				data: {
					eventType,
					webhookId,
					toNumber,
					fromNumber,
					faxId,
					status,
					failureReason,
					pageCount,
					hasMediaUrl: !!mediaUrl,
					timestamp: new Date().toISOString()
				}
			};

		} catch (error) {
			this.logger.log('ERROR', 'Error processing Telnyx fax receiving webhook', {
				error: error.message,
				stack: error.stack
			});
			return {
				statusCode: 500,
				error: 'Fax receiving webhook processing failed',
				message: error.message
			};
		}
	}



	/**
	 * General fax receiving webhook (public endpoint) - handles any provider
	 * @param {Request} request - The HTTP request
	 * @param {Object} caller_env - Environment variables
	 * @param {Object} sagContext - Serverless API Gateway context
	 * @returns {Promise<Object>} Response object
	 */
	async generalFaxReceiveWebhook(request, caller_env = "{}", sagContext = "{}") {
		try {
			// Ensure caller_env is an object for downstream DB utils
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});

			this.logger.log('INFO', 'Processing general fax receiving webhook (public endpoint)');

			// Parse JSON body safely
			const body = await request.json();

			// Try to detect the provider from the webhook payload structure
			let provider = 'unknown';
			let eventType = 'unknown';
			let payload = {};
			let webhookId = null;
			let fromNumber = null;
			let toNumber = null;
			let faxId = null;
			let status = null;
			let pageCount = null;
			let mediaUrl = null;
			let timestamp = new Date().toISOString();

			// Detect Telnyx webhook format
			if (body?.data?.event_type) {
				provider = 'telnyx';
				eventType = body.data.event_type;
				payload = body.data.payload || {};
				webhookId = body.data.id;
				fromNumber = payload.from;
				toNumber = payload.to;
				faxId = payload.fax_id;
				status = payload.status;
				pageCount = payload.page_count;
				mediaUrl = payload.media_url;
				timestamp = body.data.occurred_at || timestamp;
			}


			this.logger.log('INFO', 'Detected provider from webhook payload', {
				provider,
				eventType,
				hasMediaUrl: !!mediaUrl
			});

			// Check if this is a fax receiving event with media
			const receivingEvents = ['fax.received', 'fax.receiving.started', 'fax.media.processing.started'];
			if (receivingEvents.includes(eventType) && mediaUrl) {
				this.logger.log('INFO', 'Processing fax receiving event with media', {
					provider,
					eventType,
					webhookId,
					fromNumber,
					pageCount,
					hasMediaUrl: !!mediaUrl
				});

				// Download and upload the fax file to R2
				const r2Utils = new R2Utils(this.logger, this.env);
				
				if (!r2Utils.validateConfiguration()) {
					throw new Error('R2 configuration invalid for fax receiving');
				}

				try {
					// Download the fax file from provider
					this.logger.log('INFO', 'Downloading fax file from provider', { mediaUrl, provider });
					
					const response = await fetch(mediaUrl);
					if (!response.ok) {
						throw new Error(`Failed to download fax file: ${response.status} ${response.statusText}`);
					}

					const fileBuffer = await response.arrayBuffer();
					
					// Generate filename for R2 storage
					const timestamp = Date.now();
					const filename = `received/${provider}_${timestamp}_${webhookId}.pdf`;
					
					// Upload to R2
					this.logger.log('INFO', 'Uploading fax file to R2', { filename });
					const r2MediaUrl = await r2Utils.uploadFile(filename, fileBuffer, 'application/pdf');
					
					this.logger.log('INFO', 'Fax file uploaded to R2 successfully', { 
						filename, 
						r2MediaUrl,
						originalMediaUrl: mediaUrl
					});

					// Save to database
					const receivedFaxData = {
						webhookId: webhookId,
						fromNumber: fromNumber,
						pageCount: pageCount || 1,
						mediaUrl: r2MediaUrl,
						originalMediaUrl: mediaUrl,
						receivedAt: new Date().toISOString(),
						provider: provider
					};

					const savedRecord = await DatabaseUtils.saveReceivedFax(receivedFaxData, callerEnvObj, this.logger);
					
					if (savedRecord) {
						this.logger.log('INFO', 'Received fax record saved to database', {
							recordId: savedRecord.id,
							webhookId: savedRecord.webhook_id,
							provider
						});

						// Check if we're in production environment before sending Slack notification
						const environment = callerEnvObj.ENVIRONMENT || this.env.ENVIRONMENT;
						
						if (environment === 'prod') {
							// Send Slack notification for successful fax receive in production
							await this.sendSlackNotificationForSuccessfulFaxReceive(
								callerEnvObj,
								{
									fromNumber,
									pageCount,
									webhookId: savedRecord.webhook_id,
									recordId: savedRecord.id,
									provider: provider
								}
							);
						}
					} else {
						this.logger.log('ERROR', 'Failed to save received fax record to database');
					}

				} catch (downloadError) {
					this.logger.log('ERROR', 'Failed to process fax file', {
						error: downloadError.message,
						mediaUrl,
						provider
					});
					// Continue processing even if file download/upload fails
				}
			} else {
				this.logger.log('INFO', 'Skipping fax processing - not a receiving event or no media URL', {
					provider,
					eventType,
					hasMediaUrl: !!mediaUrl
				});
			}

			// Log the parsed webhook data
			this.logger.log('INFO', 'General fax receiving webhook processed', {
				provider,
				eventType,
				webhookId,
				toNumber,
				fromNumber,
				faxId,
				status,
				pageCount,
				hasMediaUrl: !!mediaUrl,
				timestamp
			});

			return {
				statusCode: 200,
				message: 'General fax receiving webhook processed successfully',
				data: {
					provider,
					eventType,
					webhookId,
					toNumber,
					fromNumber,
					faxId,
					status,
					pageCount,
					hasMediaUrl: !!mediaUrl,
					timestamp: new Date().toISOString()
				}
			};

		} catch (error) {
			this.logger.log('ERROR', 'Error processing general fax receiving webhook', {
				error: error.message,
				stack: error.stack
			});
			return {
				statusCode: 500,
				error: 'General fax receiving webhook processing failed',
				message: error.message
			};
		}
	}

	/**
	 * Get all received faxes from the last 24 hours (unauthenticated endpoint)
	 * @param {Request} request - The HTTP request
	 * @param {Object} caller_env - Environment variables
	 * @param {Object} sagContext - Serverless API Gateway context
	 * @returns {Promise<Object>} Response object
	 */
	async getReceivedFaxesLast24Hours(request, caller_env = "{}", sagContext = "{}") {
		try {
			this.logger.log('INFO', 'Received request to get received faxes from last 24 hours');

			// Parse environment variables
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env) : caller_env;

			// Get received faxes from the last 24 hours
			const result = await FaxDatabaseUtils.getReceivedFaxesLast24Hours(callerEnvObj, this.logger);

			if (!result.success) {
				this.logger.log('ERROR', 'Failed to fetch received faxes', {
					error: result.error
				});
				return {
					statusCode: 500,
					error: 'Failed to fetch received faxes',
					message: result.error
				};
			}

			// Mask phone numbers in the response for privacy
			const maskedFaxes = result.faxes.map(fax => {
				const maskedFax = { ...fax };
				
				// Mask from_number if it exists
				if (maskedFax.from_number) {
					maskedFax.from_number = this.maskPhoneNumber(maskedFax.from_number);
				}
				
				// Mask to_number if it exists
				if (maskedFax.to_number) {
					maskedFax.to_number = this.maskPhoneNumber(maskedFax.to_number);
				}
				
				return maskedFax;
			});

			this.logger.log('INFO', 'Successfully retrieved received faxes with masked phone numbers', {
				count: result.count
			});

			return {
				statusCode: 200,
				message: 'Received faxes retrieved successfully',
				data: maskedFaxes
			};

		} catch (error) {
			this.logger.log('ERROR', 'Error in getReceivedFaxesLast24Hours endpoint', {
				error: error.message,
				stack: error.stack
			});
			return {
				statusCode: 500,
				error: 'Internal server error',
				message: error.message
			};
		}
	}

	/**
	 * Mask a phone number for privacy (shows only last 4 digits)
	 * @param {string} phoneNumber - The phone number to mask
	 * @returns {string} Masked phone number
	 */
	maskPhoneNumber(phoneNumber) {
		if (!phoneNumber || typeof phoneNumber !== 'string') {
			return phoneNumber;
		}

		// Remove all non-digit characters
		const digits = phoneNumber.replace(/\D/g, '');
		
		if (digits.length < 4) {
			return phoneNumber; // Return original if too short
		}

		// Keep the last 4 digits and mask the rest with asterisks
		const lastFour = digits.slice(-4);
		const maskedPart = '*'.repeat(Math.max(0, digits.length - 4));
		
		// Format with original structure (preserve +, -, etc.)
		if (phoneNumber.startsWith('+')) {
			return `+${maskedPart}${lastFour}`;
		} else if (phoneNumber.includes('-')) {
			// Try to preserve some formatting
			const parts = phoneNumber.split('-');
			if (parts.length >= 2) {
				return `${'*'.repeat(parts[0].length)}-${'*'.repeat(parts[1].length)}-${lastFour}`;
			}
		}
		
		// Default format
		return `${maskedPart}${lastFour}`;
	}

	/**
	 * Get country code from phone number
	 * @param {string} phoneNumber - The phone number
	 * @returns {string} Country code or 'Unknown'
	 */
	getCountryCode(phoneNumber) {
		if (!phoneNumber || typeof phoneNumber !== 'string') {
			return 'Unknown';
		}

		// Remove all non-digit characters except +
		const cleanNumber = phoneNumber.replace(/[^\d+]/g, '');
		
		// Common country code patterns
		const countryCodes = {
			'1': 'US/Canada',
			'44': 'UK',
			'33': 'France',
			'49': 'Germany',
			'39': 'Italy',
			'34': 'Spain',
			'31': 'Netherlands',
			'32': 'Belgium',
			'46': 'Sweden',
			'47': 'Norway',
			'45': 'Denmark',
			'358': 'Finland',
			'48': 'Poland',
			'420': 'Czech Republic',
			'36': 'Hungary',
			'43': 'Austria',
			'41': 'Switzerland',
			'61': 'Australia',
			'64': 'New Zealand',
			'81': 'Japan',
			'82': 'South Korea',
			'86': 'China',
			'91': 'India',
			'971': 'UAE',
			'966': 'Saudi Arabia',
			'972': 'Israel',
			'90': 'Turkey',
			'7': 'Russia',
			'55': 'Brazil',
			'54': 'Argentina',
			'56': 'Chile',
			'57': 'Colombia',
			'58': 'Venezuela',
			'593': 'Ecuador',
			'51': 'Peru',
			'52': 'Mexico',
			'27': 'South Africa',
			'234': 'Nigeria',
			'254': 'Kenya',
			'256': 'Uganda',
			'255': 'Tanzania'
		};

		// Check for country codes starting with +
		if (cleanNumber.startsWith('+')) {
			const numberWithoutPlus = cleanNumber.substring(1);
			
			// Check 3-digit codes first
			if (numberWithoutPlus.length >= 3) {
				const code3 = numberWithoutPlus.substring(0, 3);
				if (countryCodes[code3]) {
					return countryCodes[code3];
				}
			}
			
			// Check 2-digit codes
			if (numberWithoutPlus.length >= 2) {
				const code2 = numberWithoutPlus.substring(0, 2);
				if (countryCodes[code2]) {
					return countryCodes[code2];
				}
			}
			
			// Check 1-digit codes
			if (numberWithoutPlus.length >= 1) {
				const code1 = numberWithoutPlus.substring(0, 1);
				if (countryCodes[code1]) {
					return countryCodes[code1];
				}
			}
		}
		
		// If no + prefix, assume US/Canada (1)
		if (cleanNumber.length >= 10 && cleanNumber.startsWith('1')) {
			return 'US/Canada';
		}
		
		return 'Unknown';
	}

	/**
	 * Send Slack notification for successful fax receive in production
	 * @param {Object} callerEnvObj - Caller environment object
	 * @param {Object} faxData - Fax data object
	 * @returns {Promise<void>}
	 */
	async sendSlackNotificationForSuccessfulFaxReceive(callerEnvObj, faxData) {
		try {
			// Check if Slack webhook URL is configured
			const slackWebhookUrl = callerEnvObj.SLACK_PUBLIC_RECEIVE_WEBHOOK;
			
			if (!slackWebhookUrl) {
				this.logger.log('WARN', 'Slack webhook URL not configured for fax receive notifications', {
					environment: callerEnvObj.ENVIRONMENT || this.env.ENVIRONMENT
				});
				return;
			}

			// Get country code and check if it's from own numbers
			const countryCode = this.getCountryCode(faxData.fromNumber);
			const isFromOwnNumbers = await FaxDatabaseUtils.isOwnNumber(faxData.fromNumber, callerEnvObj, this.logger);
			
			// Prepare Slack message
			const maskedFromNumber = this.maskPhoneNumber(faxData.fromNumber);
			const timestamp = new Date().toISOString();
			
			const slackMessage = {
				text: `📠 *New Fax Received*`,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: "📠 New Public Fax Received",
							emoji: true
						}
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*From:*\n${maskedFromNumber}`
							},
							{
								type: "mrkdwn",
								text: `*Country:*\n${countryCode}`
							},
							{
								type: "mrkdwn",
								text: `*Pages:*\n${faxData.pageCount || 1}`
							},
							{
								type: "mrkdwn",
								text: `*Own Number:*\n${isFromOwnNumbers ? 'Yes' : 'No'}`
							}
						]
					},
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `Received at ${timestamp}`
							}
						]
					}
				]
			};

			// Send to Slack
			const response = await fetch(slackWebhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(slackMessage)
			});

			if (response.ok) {
				this.logger.log('INFO', 'Slack notification sent successfully for fax receive', {
					recordId: faxData.recordId,
					webhookId: faxData.webhookId
				});
			} else {
				this.logger.log('ERROR', 'Failed to send Slack notification', {
					status: response.status,
					statusText: response.statusText,
					recordId: faxData.recordId
				});
			}

		} catch (error) {
			this.logger.log('ERROR', 'Error sending Slack notification for fax receive', {
				error: error.message,
				recordId: faxData.recordId
			});
			// Don't throw error - we don't want Slack notification failures to break fax processing
		}
	}

	/**
	 * Number lookup endpoint for pricing
	 * Performs Telnyx lookup, extracts LRN, and determines pricing using LRN-first logic
	 * @param {Request} request - The HTTP request
	 * @param {Object} caller_env - Environment variables
	 * @param {Object} sagContext - Serverless API Gateway context
	 * @returns {Promise<Object>} Response object with pricing information
	 */
	async numberLookup(request, caller_env = "{}", sagContext = "{}") {
		try {
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});
			
			this.logger.log('INFO', 'Number lookup request received');

			const url = new URL(request.url);
			const to = url.searchParams.get('to') || '';
			
			if (!to) {
				return {
					statusCode: 400,
					error: 'Missing parameter',
					message: "Missing 'to' parameter. Use /v1/fax/lookup?to=1-330-341-7001"
				};
			}

			const dialedDigits = digitsOnly(to);
			if (!dialedDigits) {
				return {
					statusCode: 400,
					error: 'Invalid phone number',
					message: "Invalid 'to' parameter. Could not extract digits."
				};
			}

			const phoneE164 = to.startsWith("+") ? to : `+${dialedDigits}`;

			// Check if Telnyx API key is available
			if (!callerEnvObj.TELNYX_API_KEY) {
				return {
					statusCode: 500,
					error: 'Configuration error',
					message: 'TELNYX_API_KEY not configured'
				};
			}

			// Perform Telnyx lookup with caching
			const lookupData = await this.performTelnyxLookup(
				phoneE164,
				callerEnvObj,
				request
			);

			if (!lookupData) {
				return {
					statusCode: 500,
					error: 'Lookup failed',
					message: 'Failed to perform Telnyx number lookup'
				};
			}

			// Get rate tables and calculate rate
			const rateTables = getRateTables(callerEnvObj);
			const prefixes = rateTables.prefixes || [];
			const rates = rateTables.rates || [];

			const rateCalculation = calculateRate(lookupData, dialedDigits, prefixes, rates);

			if (!rateCalculation.billed) {
				return {
					statusCode: 404,
					error: 'No rate match found',
					message: 'No matching rate found for this number',
					input: to,
					phone_e164: phoneE164,
					dialed_digits: dialedDigits,
					lrn_prefix_used_for_rating: rateCalculation.lrnPrefix,
					credit_per_page: null,
					debug: {
						lrn_match: rateCalculation.lrnMatch,
						dialed_match: rateCalculation.dialedMatch,
						portability: lookupData?.portability || null,
					}
				};
			}

			return {
				statusCode: 200,
				message: 'Number lookup successful',
				input: to,
				phone_e164: phoneE164,
				dialed_digits: dialedDigits,
				lrn_prefix_used_for_rating: rateCalculation.lrnPrefix,
				billed_rate: rateCalculation.billed,
				credit_per_page: rateCalculation.creditPerPage,
				debug: {
					lrn_match: rateCalculation.lrnMatch,
					dialed_match: rateCalculation.dialedMatch,
					portability: lookupData?.portability || null,
				}
			};

		} catch (error) {
			this.logger.log('ERROR', 'Error in numberLookup', {
				error: error.message,
				stack: error.stack
			});

			return {
				statusCode: 500,
				error: 'Number lookup failed',
				message: error.message
			};
		}
	}

	/**
	 * Calculate total credits required for a fax
	 * @param {string} destinationNumber - Recipient phone number
	 * @param {number} pageCount - Number of pages in the fax
	 * @param {Object} callerEnvObj - Environment variables
	 * @param {Request} request - Original request for cache API access
	 * @returns {Promise<Object>} Credit calculation result with creditPerPage, creditsRequired, and rateInfo
	 */
	async calculateFaxCredits(destinationNumber, pageCount, callerEnvObj, request) {
		const DEFAULT_CREDIT_PER_PAGE = 1;
		
		let creditPerPage = DEFAULT_CREDIT_PER_PAGE;
		let rateInfo = null;
		
		if (!destinationNumber || !callerEnvObj.TELNYX_API_KEY) {
			this.logger.log('DEBUG', 'Skipping rate lookup - no destination number or Telnyx API key', {
				hasDestination: !!destinationNumber,
				hasApiKey: !!callerEnvObj.TELNYX_API_KEY
			});
			return {
				creditPerPage: DEFAULT_CREDIT_PER_PAGE,
				creditsRequired: DEFAULT_CREDIT_PER_PAGE * pageCount,
				rateInfo: null
			};
		}
		
		try {
			const dialedDigits = digitsOnly(destinationNumber);
			if (!dialedDigits) {
				this.logger.log('WARN', 'Could not extract digits from destination number', {
					destinationNumber
				});
				return {
					creditPerPage: DEFAULT_CREDIT_PER_PAGE,
					creditsRequired: DEFAULT_CREDIT_PER_PAGE * pageCount,
					rateInfo: null
				};
			}
			
			const phoneE164 = destinationNumber.startsWith("+") ? destinationNumber : `+${dialedDigits}`;
			
			// Perform Telnyx lookup to get rate
			const lookupData = await this.performTelnyxLookup(
				phoneE164,
				callerEnvObj,
				request
			);
			
			if (!lookupData) {
				this.logger.log('WARN', 'Rate lookup returned no data, using default credit per page', {
					destinationNumber
				});
				return {
					creditPerPage: DEFAULT_CREDIT_PER_PAGE,
					creditsRequired: DEFAULT_CREDIT_PER_PAGE * pageCount,
					rateInfo: null
				};
			}
			
			// Get rate tables and calculate rate
			const rateTables = getRateTables(callerEnvObj);
			const prefixes = rateTables.prefixes || [];
			const rates = rateTables.rates || [];
			
			const rateCalculation = calculateRate(lookupData, dialedDigits, prefixes, rates);
			
			if (rateCalculation.billed && rateCalculation.creditPerPage !== null) {
				creditPerPage = rateCalculation.creditPerPage;
				rateInfo = {
					rate_usd_per_min: rateCalculation.billed.rate_usd_per_min,
					prefix: rateCalculation.billed.prefix,
					lrn_prefix_used: rateCalculation.lrnPrefix
				};
				this.logger.log('INFO', 'Rate lookup successful for fax', {
					destinationNumber,
					creditPerPage: creditPerPage,
					rate: rateCalculation.billed.rate_usd_per_min
				});
			} else {
				this.logger.log('WARN', 'Rate calculation failed, using default credit per page', {
					destinationNumber
				});
			}
		} catch (error) {
			// Log error but continue with default credit per page
			this.logger.log('WARN', 'Error during rate lookup for fax, using default credit', {
				destinationNumber,
				error: error.message
			});
		}
		
		// Calculate total credits required and ceil to integer
		const creditsRequired = Math.ceil(creditPerPage) * pageCount;
		
		return {
			creditPerPage,
			creditsRequired,
			rateInfo
		};
	}

	/**
	 * Perform Telnyx number lookup with caching
	 * @param {string} phoneE164 - Phone number in E.164 format
	 * @param {Object} callerEnvObj - Environment variables
	 * @param {Request} request - Original request for cache API access
	 * @returns {Promise<Object|null>} Lookup data or null if failed
	 */
	async performTelnyxLookup(phoneE164, callerEnvObj, request) {
		const TELNYX_BASE = "https://api.telnyx.com/v2/number_lookup/";
		const ttl = Number(callerEnvObj.LOOKUP_TTL_SECONDS || 86400); // Default 24 hours
		
		// Generate cache key
		const dialedDigits = digitsOnly(phoneE164);
		const typesKey = ''; // Empty for basic lookup
		const cacheKey = `https://lookup.local/number/${dialedDigits}?types=${typesKey}`;
		const kvKey = `lookup:${dialedDigits}:types:${typesKey}`;

		// Try to get from cache
		const cache = caches.default;
		let lookupData = await this.getCachedLookup(callerEnvObj, cache, cacheKey, kvKey);

		if (lookupData) {
			this.logger.log('DEBUG', 'Number lookup cache hit', { phoneE164 });
			return lookupData;
		}

		// Perform Telnyx lookup
		this.logger.log('DEBUG', 'Performing Telnyx number lookup', { phoneE164 });
		
		const url = new URL(TELNYX_BASE + encodeURIComponent(phoneE164));
		// Don't request carrier/cnam by default to keep lookup cheap
		// Add types if needed: url.searchParams.append("type", "carrier");

		const response = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${callerEnvObj.TELNYX_API_KEY}` },
		});

		if (!response.ok) {
			this.logger.log('ERROR', 'Telnyx lookup failed', {
				status: response.status,
				statusText: response.statusText,
				phoneE164
			});
			throw new Error(`Telnyx lookup failed: ${response.status}`);
		}

		const json = await response.json();
		lookupData = json?.data ?? null;

		if (lookupData) {
			// Cache the result
			await this.putCachedLookup(callerEnvObj, request, cache, cacheKey, kvKey, ttl, lookupData);
			this.logger.log('DEBUG', 'Number lookup cached', { phoneE164 });
		}

		return lookupData;
	}

	/**
	 * Get cached lookup data
	 * @param {Object} callerEnvObj - Environment variables
	 * @param {Cache} cache - Cache API instance
	 * @param {string} cacheKey - Cache API key
	 * @param {string} kvKey - KV namespace key (if available)
	 * @returns {Promise<Object|null>} Cached data or null
	 */
	async getCachedLookup(callerEnvObj, cache, cacheKey, kvKey) {
		// Try KV first if available
		if (this.env.LOOKUP_KV) {
			try {
				const v = await this.env.LOOKUP_KV.get(kvKey, "json");
				if (v) return v;
			} catch (error) {
				this.logger.log('DEBUG', 'KV lookup failed, trying cache API', { error: error.message });
			}
		}

		// Try Cache API
		try {
			const r = await cache.match(cacheKey);
			return r ? await r.json() : null;
		} catch (error) {
			this.logger.log('DEBUG', 'Cache API lookup failed', { error: error.message });
			return null;
		}
	}

	/**
	 * Store lookup data in cache
	 * @param {Object} callerEnvObj - Environment variables
	 * @param {Request} request - Original request
	 * @param {Cache} cache - Cache API instance
	 * @param {string} cacheKey - Cache API key
	 * @param {string} kvKey - KV namespace key (if available)
	 * @param {number} ttl - Time to live in seconds
	 * @param {Object} data - Data to cache
	 */
	async putCachedLookup(callerEnvObj, request, cache, cacheKey, kvKey, ttl, data) {
		// Store in KV if available
		if (this.env.LOOKUP_KV) {
			try {
				await this.env.LOOKUP_KV.put(kvKey, JSON.stringify(data), { expirationTtl: ttl });
			} catch (error) {
				this.logger.log('DEBUG', 'KV cache put failed', { error: error.message });
			}
		}

		// Store in Cache API
		try {
			const response = new Response(JSON.stringify(data), {
				headers: {
					"content-type": "application/json; charset=utf-8",
					"cache-control": `public, max-age=${ttl}`,
				},
			});

			await cache.put(cacheKey, response);
		} catch (error) {
			this.logger.log('DEBUG', 'Cache API put failed', { error: error.message });
		}
	}

	/**
	 * Test endpoint for sending push notifications
	 * Creates example fax records and sends notifications
	 * @param {Request} request - The HTTP request
	 * @param {Object} caller_env - Environment variables
	 * @param {Object} sagContext - Serverless API Gateway context
	 * @returns {Promise<Object>} Response object
	 */
	async testNotification(request, caller_env = "{}", sagContext = "{}") {
		try {
			// Ensure caller_env is an object
			const callerEnvObj = typeof caller_env === 'string' ? JSON.parse(caller_env || '{}') : (caller_env || {});

			this.logger.log('INFO', 'Test notification endpoint called');

			// Parse request body or URL parameters
			const url = new URL(request.url);
			let userId = url.searchParams.get('user_id');
			let faxStatus = url.searchParams.get('fax_status') || 'delivered';

			// Try to get from request body if not in URL
			if (!userId) {
				try {
					const body = await request.json().catch(() => ({}));
					userId = body.user_id || userId;
					faxStatus = body.fax_status || faxStatus;
				} catch (e) {
					// Body parsing failed, use URL params only
				}
			}

			// Validate inputs
			if (!userId) {
				return {
					statusCode: 400,
					error: 'Missing parameter',
					message: "Missing 'user_id' parameter. Use /v1/fax/test-notification?user_id=<uuid>&fax_status=delivered|failed"
				};
			}

			// Validate fax_status
			const validStatuses = ['delivered', 'failed'];
			if (!validStatuses.includes(faxStatus)) {
				return {
					statusCode: 400,
					error: 'Invalid parameter',
					message: `Invalid 'fax_status'. Must be one of: ${validStatuses.join(', ')}`
				};
			}

			// Ensure notification service is initialized
			if (!this.notificationService) {
				this.notificationService = new NotificationService(this.logger);
			}

			// Create example fax records based on status
			const exampleFaxes = {
				delivered: [
					{
						id: `test-fax-${Date.now()}-1`,
						user_id: userId,
						status: 'delivered',
						recipients: ['+1-555-123-4567'],
						error_message: null
					},
					{
						id: `test-fax-${Date.now()}-2`,
						user_id: userId,
						status: 'delivered',
						recipients: ['+44-20-7946-0958'],
						error_message: null
					},
					{
						id: `test-fax-${Date.now()}-3`,
						user_id: userId,
						status: 'delivered',
						recipients: ['+1-330-341-7001'],
						error_message: null
					}
				],
				failed: [
					{
						id: `test-fax-${Date.now()}-1`,
						user_id: userId,
						status: 'failed',
						recipients: ['+1-555-123-4567'],
						error_message: 'No answer from recipient'
					},
					{
						id: `test-fax-${Date.now()}-2`,
						user_id: userId,
						status: 'failed',
						recipients: ['+44-20-7946-0958'],
						error_message: 'Busy signal detected'
					},
					{
						id: `test-fax-${Date.now()}-3`,
						user_id: userId,
						status: 'failed',
						recipients: ['+1-330-341-7001'],
						error_message: 'Connection timeout'
					}
				]
			};

			const faxesToSend = exampleFaxes[faxStatus];
			const results = [];

			// Send notifications for each example fax
			for (const fax of faxesToSend) {
				this.logger.log('INFO', 'Sending test notification', {
					faxId: fax.id,
					userId: fax.user_id,
					status: fax.status,
					recipient: fax.recipients[0]
				});

				const result = await this.notificationService.sendFaxStatusNotification(callerEnvObj, fax);
				
				results.push({
					faxId: fax.id,
					recipient: fax.recipients[0],
					status: fax.status,
					errorMessage: fax.error_message,
					notificationResult: result
				});

				// Add small delay between notifications to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			const successCount = results.filter(r => r.notificationResult.success).length;
			const failedCount = results.filter(r => !r.notificationResult.success && !r.notificationResult.skipped).length;
			const skippedCount = results.filter(r => r.notificationResult.skipped).length;

			this.logger.log('INFO', 'Test notifications completed', {
				userId,
				faxStatus,
				total: results.length,
				success: successCount,
				failed: failedCount,
				skipped: skippedCount
			});

			return {
				statusCode: 200,
				message: 'Test notifications sent',
				data: {
					userId,
					faxStatus,
					totalSent: results.length,
					summary: {
						success: successCount,
						failed: failedCount,
						skipped: skippedCount
					},
					results: results.map(r => ({
						faxId: r.faxId,
						recipient: r.recipient,
						status: r.status,
						errorMessage: r.errorMessage,
						notificationSuccess: r.notificationResult.success,
						notificationSkipped: r.notificationResult.skipped,
						notificationError: r.notificationResult.error,
						oneSignalId: r.notificationResult.id
					}))
				},
				timestamp: new Date().toISOString()
			};

		} catch (error) {
			this.logger.log('ERROR', 'Error in testNotification endpoint', {
				error: error.message,
				stack: error.stack
			});

			return {
				statusCode: 500,
				error: 'Test notification failed',
				message: error.message
			};
		}
	}

}
