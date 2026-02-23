/**
 * Telnyx Fax Provider
 * Implementation of BaseFaxProvider for Telnyx API
 * Special workflow: Save to Supabase → Upload to R2 → Send to Telnyx using R2 public URL
 */

import { DatabaseUtils } from '../database.js';
import { extractFileExtension } from '../file-type-policy.js';

const EXTENSION_MIME_MAP = {
	pdf: 'application/pdf',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	ods: 'application/vnd.oasis.opendocument.spreadsheet',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	bmp: 'image/bmp',
	txt: 'text/plain',
	rtf: 'application/rtf',
	htm: 'text/html',
	html: 'text/html'
};

function hasPdfSignature(bytes) {
	if (!bytes || bytes.length < 5) return false;
	return (
		bytes[0] === 0x25 && // %
		bytes[1] === 0x50 && // P
		bytes[2] === 0x44 && // D
		bytes[3] === 0x46 && // F
		bytes[4] === 0x2d // -
	);
}

function sanitizeExtension(ext) {
	if (!ext) return '';
	return String(ext).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class TelnyxProvider {
	constructor(apiKey, logger, options = {}) {
		this.apiKey = apiKey;
		this.logger = logger;
		this.baseUrl = 'https://api.telnyx.com';
		this.connectionId = options.connectionId;
		this.senderId = options.senderId;
		this.r2Utils = options.r2Utils;
		this.env = options.env;
	}

	getProviderName() {
		return 'telnyx';
	}

	async prepareFaxRequest(requestBody) {
		this.logger.log('DEBUG', 'Starting fax request preparation for Telnyx');
		let faxRequest = {};

		if (requestBody instanceof FormData) {
			for (const [key, value] of requestBody.entries()) {
				if (key === 'recipients[]') {
					if (!faxRequest.recipients) faxRequest.recipients = [];
					faxRequest.recipients.push(value);
				} else if (key === 'files[]') {
					if (!faxRequest.files) faxRequest.files = [];
					faxRequest.files.push(value);
				} else {
					faxRequest[key] = value;
				}
			}
		} else if (typeof requestBody === 'object' && requestBody !== null) {
			const {
				recipient,
				recipients,
				message,
				coverPage,
				files,
				senderId,
				...otherFields
			} = requestBody;

			if (recipients && Array.isArray(recipients)) {
				faxRequest.recipients = recipients;
			} else if (recipient) {
				faxRequest.recipients = [recipient];
			}

			if (message) faxRequest.message = message;
			if (coverPage) faxRequest.coverPage = coverPage;
			// Use provider's senderId if not specified in request
			if (senderId) {
				faxRequest.senderId = senderId;
			} else if (this.senderId) {
				faxRequest.senderId = this.senderId;
			}

			if (Object.keys(otherFields).length > 0) {
				Object.assign(faxRequest, otherFields);
			}

			if (files && Array.isArray(files)) {
				faxRequest.files = await this.processJsonFiles(files);
			}
		}

		return faxRequest;
	}

	async processJsonFiles(files) {
		const processedFiles = [];
		let totalPages = 0;

		for (let i = 0; i < files.length; i++) {
			const file = files[i];

			if (file.data) {
				try {
					const buffer = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
					const filename = file.filename || file.name || `document_${i + 1}`;
					const extension = extractFileExtension(filename, file.mimeType || file.type || '');
					const mimeType = (file.mimeType || file.type || EXTENSION_MIME_MAP[extension] || 'application/octet-stream').toLowerCase();
					const blob = new Blob([buffer], { type: mimeType });
					blob.filename = filename;
					blob.name = filename;
					blob.mimeType = mimeType;
					processedFiles.push(blob);
					
					// Extract page count from file if provided (handle both camelCase and snake_case)
					const pageCount = file.pageCount || file.page_count;
					if (pageCount && typeof pageCount === 'number') {
						totalPages += pageCount;
					} else {
						totalPages += 1; // Default to 1 page if not specified
					}
				} catch (base64Error) {
					this.logger.log('ERROR', `Failed to decode base64 for file ${i}`, {
						error: base64Error.message
					});
					throw new Error(`Invalid base64 data for file ${i}`);
				}
			} else {
				processedFiles.push(file);
				totalPages += 1; // Default to 1 page for non-base64 files
			}
		}

		// Store total pages and document count in the processed files array metadata
		processedFiles._totalPages = totalPages;
		processedFiles._documentCount = files.length;

		return processedFiles;
	}

	/**
	 * Build Telnyx-specific payload from standardized fax request
	 * @param {object} faxRequest - Standardized fax request
	 * @returns {object} Telnyx API payload
	 */
	async buildPayload(faxRequest) {
		this.logger.log('DEBUG', 'Building Telnyx API payload structure');

		if (!this.connectionId) {
			throw new Error('Telnyx connection_id is required');
		}

		// For Telnyx, we need a single recipient (not an array)
		if (!faxRequest.recipients || faxRequest.recipients.length === 0) {
			throw new Error('At least one recipient is required for Telnyx');
		}

		const recipient = faxRequest.recipients[0]; // Telnyx sends to one recipient per request
		this.logger.log('DEBUG', 'Using first recipient for Telnyx', {
			recipient: '+***'
		});

		// The actual media_url will be set after file upload to R2
		const telnyxPayload = {
			connection_id: this.connectionId,
			to: recipient,
			from: faxRequest.senderId || "",
			// media_url will be set after R2 upload
		};

		this.logger.log('DEBUG', 'Base Telnyx payload created', {
			connection_id: telnyxPayload.connection_id,
			to: telnyxPayload.to.replace(/\d/g, '*'),
			from: telnyxPayload.from.replace(/\d/g, '*')
		});

		return telnyxPayload;
	}

	/**
	 * Custom workflow for Telnyx: Save to Supabase → Upload to R2 → Send fax
	 * @param {object} faxRequest - Standardized fax request
	 * @param {string|null} userId - User ID from auth context
	 * @returns {object} Standardized response
	 */
	async sendFaxWithCustomWorkflow(faxRequest, userId, creditsRequired = 0, billingContext = null) {
		try {
			this.logger.log('INFO', 'Starting Telnyx custom workflow: Save to Supabase → Upload to R2 → Send fax');

			// Step 1: Create initial fax record in Supabase
			const faxRecord = await this.createInitialFaxRecord(faxRequest, userId, creditsRequired, billingContext);
			this.logger.log('INFO', 'Step 1 complete: Fax record saved to Supabase', { faxId: faxRecord.id });

			// Step 2: Upload files to R2 and get public URLs
			const mediaUrls = await this.uploadFilesToR2(faxRequest.files, faxRecord.id);
			this.logger.log('INFO', 'Step 2 complete: Files uploaded to R2', { urlCount: mediaUrls.length });

			// Step 3: Update fax record with R2 URLs
			await this.updateFaxRecordWithR2Urls(faxRecord.id, mediaUrls);
			this.logger.log('INFO', 'Step 3 complete: Fax record updated with R2 URLs');

			// Step 4: Send fax via Telnyx API using all R2 URLs as array
			const telnyxResponse = await this.sendToTelnyx(faxRequest, mediaUrls);
			this.logger.log('INFO', 'Step 4 complete: Fax sent to Telnyx', { telnyxFaxId: telnyxResponse.id, documentCount: mediaUrls.length });

			// Step 5: Update fax record with Telnyx response
			await this.updateFaxRecordWithTelnyxResponse(faxRecord.id, telnyxResponse);
			this.logger.log('INFO', 'Step 5 complete: Fax record updated with Telnyx response');

			return this.mapTelnyxResponse(telnyxResponse);

		} catch (error) {
			this.logger.log('ERROR', 'Telnyx custom workflow failed', {
				error: error.message,
				stack: error.stack
			});
			throw error;
		}
	}

	/**
	 * Create initial fax record in Supabase
	 * @param {object} faxRequest - Standardized fax request
	 * @param {string|null} userId - User ID
	 * @param {number} creditsRequired - Credit cost for this fax
	 * @returns {object} Created fax record
	 */
	async createInitialFaxRecord(faxRequest, userId, creditsRequired = 0, billingContext = null) {
		// Calculate document count and total pages from files
		const documentCount = faxRequest.files?._documentCount || (faxRequest.files?.length || 0) || 1;
		const totalPages = faxRequest.files?._totalPages || 1;
		const billingMetadata = billingContext && typeof billingContext === 'object'
			? {
				revenuecat_customer_id: billingContext.revenueCatCustomerId || null,
				currency_code: billingContext.activeCurrencyCode || null,
				is_subscriber: billingContext.isSubscriber === true,
				credits_required: Math.ceil(creditsRequired) || 0
			}
			: null;
		const conversionSummary = faxRequest.conversionSummary && typeof faxRequest.conversionSummary === 'object'
			? faxRequest.conversionSummary
			: null;
		const metadata = {};
		if (billingMetadata) {
			metadata.billing = billingMetadata;
		}
		if (conversionSummary) {
			metadata.file_conversion = conversionSummary;
		}
		
		const faxData = {
			user_id: userId,
			recipients: faxRequest.recipients || [],
			sender_id: faxRequest.senderId,
			subject: faxRequest.subject || faxRequest.message || 'Fax Document',
			// Use DB enum-compatible status while retaining provider-specific state in originalStatus
			status: 'queued',
			original_status: 'preparing',
			pages: totalPages,
			document_count: documentCount,
			cost: Math.ceil(creditsRequired) || 0,
			created_at: new Date().toISOString(),
			metadata
		};

		return await DatabaseUtils.saveFaxRecord(faxData, userId, this.env, this.logger);
	}

	/**
	 * Upload files to R2 and return public URLs
	 * @param {array} files - Files to upload
	 * @param {string} faxId - Fax ID for naming
	 * @returns {array} Array of R2 public URLs
	 */
	async uploadFilesToR2(files, faxId) {
		if (!this.r2Utils) {
			throw new Error('R2 utilities not configured');
		}

		if (!files || files.length === 0) {
			throw new Error('No files to upload');
		}

		const mediaUrls = [];

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			this.logger.log('DEBUG', `Uploading file ${i + 1} to R2`, { 
				fileIndex: i, 
				hasFile: !!file 
			});

			try {
				// Convert file to buffer if needed
				let fileBuffer;
				if (file instanceof Blob || (typeof File !== 'undefined' && file instanceof File) || (file && typeof file.arrayBuffer === 'function')) {
					fileBuffer = new Uint8Array(await file.arrayBuffer());
				} else if (file.data) {
					// Base64 encoded data
					fileBuffer = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
				} else if (file instanceof Uint8Array) {
					fileBuffer = file;
				} else if (file instanceof ArrayBuffer) {
					fileBuffer = new Uint8Array(file);
				} else {
					throw new Error(`Unsupported file format for file ${i + 1}`);
				}

				const sourceFilename = file?.filename || file?.name || `document_${i + 1}`;
				const claimedMimeType = String(file?.type || file?.mimeType || '').toLowerCase();
				let extension = sanitizeExtension(extractFileExtension(sourceFilename, claimedMimeType));
				let contentType = claimedMimeType || EXTENSION_MIME_MAP[extension] || 'application/octet-stream';

				const claimsPdf = contentType === 'application/pdf' || extension === 'pdf';
				if (claimsPdf && !hasPdfSignature(fileBuffer)) {
					throw new Error(`Invalid PDF content for file ${i + 1}: bytes do not match PDF signature`);
				}
				if (claimsPdf) {
					extension = 'pdf';
					contentType = 'application/pdf';
				}

				// Generate unique filename with extension that matches actual payload type.
				const timestamp = Date.now();
				const suffix = extension ? `.${extension}` : '';
				const filename = `fax/${faxId}/document_${i + 1}_${timestamp}${suffix}`;

				// Upload to R2
				const publicUrl = await this.r2Utils.uploadFile(filename, fileBuffer, contentType);
				mediaUrls.push(publicUrl);

				this.logger.log('DEBUG', `File ${i + 1} uploaded successfully`, {
					filename,
					contentType,
					url: publicUrl
				});

			} catch (error) {
				this.logger.log('ERROR', `Failed to upload file ${i + 1} to R2`, {
					error: error.message,
					fileIndex: i
				});
				throw error;
			}
		}

		return mediaUrls;
	}

	/**
	 * Update fax record with R2 URLs
	 * @param {string} faxId - Fax ID
	 * @param {array} mediaUrls - R2 URLs
	 */
	async updateFaxRecordWithR2Urls(faxId, mediaUrls) {
		const updateData = {
			r2_urls: mediaUrls,
			// Map to a valid DB status
			status: 'processing'
		};

		await DatabaseUtils.updateFaxRecord(faxId, updateData, this.env, this.logger, 'id');
	}

	/**
	 * Send fax to Telnyx API
	 * @param {object} faxRequest - Original fax request
	 * @param {string|array} mediaUrls - R2 public URL(s) - can be single URL or array of URLs
	 * @returns {object} Telnyx API response
	 */
	async sendToTelnyx(faxRequest, mediaUrls) {
		const payload = await this.buildPayload(faxRequest);
		// Support both single URL and array of URLs
		if (Array.isArray(mediaUrls)) {
			payload.media_url = mediaUrls; // Send as array for multiple documents
		} else {
			payload.media_url = mediaUrls; // Single URL (backward compatibility)
		}

		this.logger.log('DEBUG', 'Sending fax to Telnyx', {
			endpoint: `${this.baseUrl}/v2/faxes`,
			to: payload.to.replace(/\d/g, '*'),
			from: payload.from.replace(/\d/g, '*'),
			hasMediaUrl: !!payload.media_url,
			mediaUrlCount: Array.isArray(payload.media_url) ? payload.media_url.length : (payload.media_url ? 1 : 0)
		});

		const response = await fetch(`${this.baseUrl}/v2/faxes`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});

		if (!response.ok) {
			const errorText = await response.text();
			this.logger.log('ERROR', 'Telnyx API request failed', {
				status: response.status,
				statusText: response.statusText,
				error: errorText
			});
			throw new Error(`Telnyx API error: ${response.status} ${response.statusText} - ${errorText}`);
		}

		const responseData = await response.json();
		this.logger.log('DEBUG', 'Telnyx API response received', {
			faxId: responseData.data?.id,
			status: responseData.data?.status
		});

		return responseData.data;
	}

	/**
	 * Update fax record with Telnyx response
	 * @param {string} faxId - Internal fax ID
	 * @param {object} telnyxResponse - Telnyx API response
	 */
	async updateFaxRecordWithTelnyxResponse(faxId, telnyxResponse) {
		let existingMetadata = {};
		if (typeof DatabaseUtils.getFaxRecord === 'function') {
			const existingFax = await DatabaseUtils.getFaxRecord(faxId, this.env, this.logger, 'id');
			existingMetadata = existingFax?.metadata && typeof existingFax.metadata === 'object' && !Array.isArray(existingFax.metadata)
				? existingFax.metadata
				: {};
		}
		const hasExistingMetadata = Object.keys(existingMetadata).length > 0;
		const updateData = {
			provider_fax_id: telnyxResponse.id,
			metadata: hasExistingMetadata
				? {
					...existingMetadata,
					telnyx_response: telnyxResponse
				}
				: telnyxResponse,
			status: this.mapStatus(telnyxResponse.status),
			sent_at: new Date().toISOString(),
			updated_at: new Date().toISOString()
		};

		await DatabaseUtils.updateFaxRecord(faxId, updateData, this.env, this.logger, 'id');
	}

	/**
	 * Send fax via Telnyx API (standard interface method)
	 * @param {object} payload - Telnyx-specific payload
	 * @returns {object} Standardized response
	 */
	async sendFax(payload) {
		// This method is kept for interface compliance but shouldn't be used directly
		// Use sendFaxWithCustomWorkflow instead
		throw new Error('Use sendFaxWithCustomWorkflow method for Telnyx provider');
	}

	/**
	 * Map Telnyx-specific status to standardized status
	 * @param {string} telnyxStatus - Status from Telnyx
	 * @returns {string} Standardized status
	 */
	mapStatus(telnyxStatus) {
		// Map Telnyx-specific statuses to DB enum fax_status values
		const statusMap = {
			// Standard flow statuses
			'queued': 'sending',
			'sending': 'sending',
			'media.processed': 'sending',
			'delivered': 'delivered',
			'failed': 'failed',
			'canceled': 'failed',

			// Error / edge-case statuses reported by Telnyx
			'receiver_no_answer': 'no-answer',
			'receiver_no_response': 'no-answer',
			'user_busy': 'busy',

			// Any other status values below (mostly error conditions) will be considered failed
			'account_disabled': 'failed',
			'connection_channel_limit_exceeded': 'failed',
			'destination_invalid': 'failed',
			'destination_not_in_countries_whitelist': 'failed',
			'destination_not_in_service_plan': 'failed',
			'destination_unreachable': 'failed',
			'fax_initial_communication_timeout': 'failed',
			'fax_signaling_error': 'failed',
			'invalid_ecm_response_from_receiver': 'failed',
			'no_outbound_profile': 'failed',
			'outbound_profile_channel_limit_exceeded': 'failed',
			'outbound_profile_daily_spend_limit_exceeded': 'failed',
			'receiver_call_dropped': 'failed',
			'receiver_communication_error': 'failed',
			'receiver_decline': 'failed',
			'receiver_incompatible_destination': 'failed',
			'receiver_invalid_number_format': 'failed',
			'receiver_recovery_on_timer_expire': 'failed',
			'receiver_unallocated_number': 'failed',
			'service_unavailable': 'failed',
			'user_channel_limit_exceeded': 'failed'
		};

		return statusMap[telnyxStatus] || 'failed';
	}

	/**
	 * Map Telnyx response to standardized format
	 * @param {object} telnyxResponse - Telnyx API response
	 * @returns {object} Standardized response
	 */
	mapTelnyxResponse(telnyxResponse) {
		return {
			id: telnyxResponse.id,
			status: this.mapStatus(telnyxResponse.status),
			originalStatus: telnyxResponse.status,
			message: 'Fax submitted to Telnyx successfully',
			timestamp: new Date().toISOString(),
			friendlyId: telnyxResponse.id,
			providerResponse: telnyxResponse
		};
	}

	/**
	 * Generate unique fax ID
	 * @returns {string} Unique fax ID
	 */
	generateFaxId() {
		return `telnyx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	}

	/**
	 * Validate Telnyx provider configuration
	 * @returns {boolean} True if configuration is valid
	 */
	validateConfig() {
		const hasApiKey = !!this.apiKey;
		const hasConnectionId = !!this.connectionId;
		const hasR2Utils = !!this.r2Utils;

		if (!hasApiKey) {
			this.logger.log('ERROR', 'Telnyx API key is missing');
		}
		if (!hasConnectionId) {
			this.logger.log('ERROR', 'Telnyx connection_id is missing');
		}
		if (!hasR2Utils) {
			this.logger.log('ERROR', 'R2 utilities are missing');
		}

		// Check R2Utils validation if available
		const r2UtilsValid = hasR2Utils && this.r2Utils.validateConfiguration ? this.r2Utils.validateConfiguration() : hasR2Utils;

		return hasApiKey && hasConnectionId && r2UtilsValid;
	}
}
