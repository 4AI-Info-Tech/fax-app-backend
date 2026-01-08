/**
 * Notifyre Fax Provider
 * Implementation of BaseFaxProvider for Notifyre API
 */

// Removed BaseFaxProvider dependency – standalone implementation
import { FileUtils } from '../utils.js';

export class NotifyreProvider {
	constructor(apiKey, logger) {
		this.apiKey = apiKey;
		this.logger = logger;
		this.baseUrl = 'https://api.notifyre.com';
	}

	getProviderName() {
		return 'notifyre';
	}

	async prepareFaxRequest(requestBody) {
		this.logger.log('DEBUG', 'Starting fax request preparation for Notifyre');
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
			if (senderId) faxRequest.senderId = senderId;

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
					const blob = new Blob([buffer], { type: file.mimeType || 'application/pdf' });
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
	 * Build Notifyre-specific payload from standardized fax request
	 * @param {object} faxRequest - Standardized fax request
	 * @returns {object} Notifyre API payload
	 */
	async buildPayload(faxRequest) {
		this.logger.log('DEBUG', 'Building Notifyre API payload structure');

		const notifyrePayload = {
			Faxes: {
				Recipients: [],
				SendFrom: faxRequest.senderId || "",
				ClientReference: faxRequest.clientReference || "SendFaxPro",
				Subject: faxRequest.subject || faxRequest.message || "Fax Document",
				IsHighQuality: faxRequest.isHighQuality || false,
				CoverPage: false,
				Documents: []
			}
		};

		this.logger.log('DEBUG', 'Base payload structure created', {
			sendFrom: notifyrePayload.Faxes.SendFrom,
			clientReference: notifyrePayload.Faxes.ClientReference,
			subject: notifyrePayload.Faxes.Subject,
			isHighQuality: notifyrePayload.Faxes.IsHighQuality,
			coverPage: notifyrePayload.Faxes.CoverPage
		});

		// Always add TestCoverPage template to every fax request
		notifyrePayload.TemplateName = "TestCoverPage";
		this.logger.log('DEBUG', 'Added default cover page template to payload', { templateName: "TestCoverPage" });

		// Override with custom template if cover page is specified
		if (faxRequest.coverPage) {
			notifyrePayload.TemplateName = faxRequest.coverPage;
			this.logger.log('DEBUG', 'Overrode with custom cover page template', { templateName: faxRequest.coverPage });
		}

		// Convert recipients to Notifyre format
		if (faxRequest.recipients && Array.isArray(faxRequest.recipients)) {
			faxRequest.recipients.forEach((recipient, index) => {
				notifyrePayload.Faxes.Recipients.push({
					Type: "fax_number",
					Value: recipient
				});
				this.logger.log('DEBUG', `Added recipient ${index}`, {
					type: "fax_number",
					value: recipient.replace(/\d/g, '*')
				});
			});
		}

		// Convert files to Notifyre format
		if (faxRequest.files && Array.isArray(faxRequest.files)) {
			this.logger.log('DEBUG', 'Processing files for conversion', { fileCount: faxRequest.files.length });

			for (let i = 0; i < faxRequest.files.length; i++) {
				const file = faxRequest.files[i];
				let filename = `document_${i + 1}.pdf`;

				try {
					if (file instanceof Blob || file instanceof File) {
						// Check file size limit (100MB)
						if (file.size > 100 * 1024 * 1024) {
							this.logger.log('WARN', 'File size exceeds limit', { size: file.size, filename: file.name });
							continue;
						}

						// Convert file to base64 safely
						const arrayBuffer = await file.arrayBuffer();
						const uint8Array = new Uint8Array(arrayBuffer);
						const fileData = FileUtils.arrayBufferToBase64(uint8Array);
						filename = file.name || filename;

						notifyrePayload.Faxes.Documents.push({
							Filename: filename,
							Data: fileData
						});

						this.logger.log('DEBUG', 'Added document to payload', { filename });
					} else if (file.data) {
						// Already base64 data
						notifyrePayload.Faxes.Documents.push({
							Filename: file.filename || file.name || filename,
							Data: file.data
						});

						this.logger.log('DEBUG', 'Added base64 document to payload', { filename });
					}
				} catch (fileError) {
					this.logger.log('ERROR', 'Error processing file', {
						fileIndex: i,
						filename: filename,
						error: fileError.message
					});
				}
			}
		}

		this.logger.log('DEBUG', 'Prepared Notifyre payload structure', {
			recipientCount: notifyrePayload.Faxes.Recipients.length,
			documentCount: notifyrePayload.Faxes.Documents.length,
			subject: notifyrePayload.Faxes.Subject,
			hasTemplate: !!notifyrePayload.TemplateName,
			clientReference: notifyrePayload.Faxes.ClientReference,
			coverPage: notifyrePayload.Faxes.CoverPage
		});

		return notifyrePayload;
	}

	/**
	 * Send fax via Notifyre API
	 * @param {object} payload - Notifyre API payload
	 * @returns {object} Standardized response
	 */
	async sendFax(payload) {
		this.logger.log('INFO', 'Sending request to Notifyre API', {
			endpoint: '/fax/send',
			method: 'POST',
			hasPayload: !!payload,
			recipientCount: payload.Faxes.Recipients.length,
			documentCount: payload.Faxes.Documents.length,
			hasTemplate: !!payload.TemplateName
		});

		const response = await this.makeRequest('/fax/send', 'POST', payload);

		// Extract fax ID from the actual API response structure
		const faxId = response?.payload?.faxID || response?.id;
		const friendlyId = response?.payload?.friendlyID;

		// Log the API response
		this.logger.log('INFO', 'Received response from Notifyre API', {
			faxId: faxId,
			friendlyId: friendlyId,
			success: response?.success,
			statusCode: response?.statusCode,
			message: response?.message,
			hasErrors: response?.errors?.length > 0,
			responseKeys: Object.keys(response || {}),
			fullResponse: response
		});

		// Validate fax result has required ID
		if (!faxId) {
			this.logger.log('ERROR', 'Notifyre API response missing fax ID', {
				response: response,
				hasId: !!faxId,
				hasPayload: !!response?.payload,
				payloadKeys: response?.payload ? Object.keys(response.payload) : [],
				responseKeys: Object.keys(response || {})
			});
			throw new Error('Notifyre API did not return a valid fax ID');
		}

		// Return standardized response
		return {
			id: faxId,
			friendlyId: friendlyId,
			status: 'queued',
			originalStatus: 'Submitted',
			message: "Fax submitted successfully",
			timestamp: new Date().toISOString(),
			providerResponse: response
		};
	}

	/**
	 * Get Notifyre API headers
	 * @returns {object} Headers for API requests
	 */
	getHeaders() {
		return {
			'x-api-token': this.apiKey,
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'User-Agent': 'Notifyre-Fax-Service/2.0.0'
		};
	}

	/**
	 * Make API request to Notifyre
	 * @param {string} endpoint - API endpoint
	 * @param {string} method - HTTP method
	 * @param {object} data - Request data
	 * @returns {object} API response
	 */
	async makeRequest(endpoint, method = 'GET', data = null) {
		const url = `${this.baseUrl}${endpoint}`;
		const options = {
			method,
			headers: this.getHeaders()
		};

		if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
			if (data instanceof FormData) {
				// Remove Content-Type header for FormData to let browser set it with boundary
				delete options.headers['Content-Type'];
				options.body = data;
			} else {
				// Ensure Content-Type is application/json for JSON payloads
				options.headers['Content-Type'] = 'application/json';
				try {
					options.body = JSON.stringify(data);
				} catch (stringifyError) {
					this.logger.log('ERROR', 'Failed to stringify request data', { error: stringifyError.message });
					throw new Error('Request data serialization failed');
				}
			}
		}

		// Log request details with full body (sanitized for sensitive data)
		let requestBodyLog = null;
		if (options.body) {
			if (data instanceof FormData) {
				requestBodyLog = 'FormData object (not logged due to binary content)';
			} else if (typeof data === 'object' && data !== null) {
				// Create a deep copy and sanitize sensitive data
				const sanitizedData = JSON.parse(JSON.stringify(data));
				if (sanitizedData.Faxes?.Documents) {
					sanitizedData.Faxes.Documents = sanitizedData.Faxes.Documents.map((doc, index) => ({
						Filename: doc.Filename,
						Data: doc.Data ? `[BASE64_DATA_${doc.Data.length}_CHARS]` : null
					}));
				}
				requestBodyLog = sanitizedData;
			} else {
				requestBodyLog = options.body;
			}
		}

		this.logger.log('DEBUG', 'Making Notifyre API request', { 
			url, 
			method, 
			hasData: !!data,
			hasApiKey: !!this.apiKey,
			apiKeyPrefix: this.apiKey && typeof this.apiKey === 'string' ? this.apiKey.substring(0, 8) + '...' : 'none',
			headers: {
				'x-api-token': this.apiKey && typeof this.apiKey === 'string' ? this.apiKey.substring(0, 8) + '...' : 'none',
				'Content-Type': options.headers['Content-Type'],
				'User-Agent': options.headers['User-Agent']
			},
			requestBody: requestBodyLog
		});

		try {
			const response = await fetch(url, options);
			const responseData = await response.json();

			// Log full response body
			this.logger.log('DEBUG', 'Notifyre API response received', {
				url,
				status: response.status,
				statusText: response.statusText,
				ok: response.ok,
				headers: {
					'content-type': response.headers?.get ? response.headers.get('content-type') : 'unknown',
					'content-length': response.headers?.get ? response.headers.get('content-length') : 'unknown'
				},
				responseBody: responseData
			});

			if (!response.ok) {
				this.logger.log('ERROR', 'Notifyre API error', {
					url,
					status: response.status,
					statusText: response.statusText,
					response: responseData
				});
				throw new Error(`Notifyre API error: ${response.status} ${response.statusText} - URL: ${url}`);
			}

			return responseData;
		} catch (error) {
			this.logger.log('ERROR', 'Notifyre API request failed', { url, error: error.message });
			throw error;
		}
	}
} 
