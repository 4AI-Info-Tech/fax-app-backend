import { Container, getRandom } from '@cloudflare/containers';
import { env, WorkerEntrypoint } from 'cloudflare:workers';

const SUPPORTED_MIME_TYPES = new Set([
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.oasis.opendocument.text',
	'application/vnd.oasis.opendocument.spreadsheet',
	'application/vnd.apple.keynote',
	'application/vnd.apple.pages',
	'application/pdf'
]);

const MIME_NORMALIZATION_ALIASES = {
	'application/x-vnd.oasis.opendocument.text': 'application/vnd.oasis.opendocument.text',
	'application/x-vnd.oasis.opendocument.spreadsheet': 'application/vnd.oasis.opendocument.spreadsheet',
	'application/mspowerpoint': 'application/vnd.ms-powerpoint',
	'application/powerpoint': 'application/vnd.ms-powerpoint',
	'application/x-mspowerpoint': 'application/vnd.ms-powerpoint'
};

function toJsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			'Content-Type': 'application/json'
		}
	});
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(timeoutMs) {
	const error = new Error(`ConvertX conversion timed out after ${timeoutMs}ms`);
	error.code = 'timeout';
	return error;
}

function parseTimeout(value, fallback = 12000) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMaxInputBytes(value, fallback = 100 * 1024 * 1024) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRetryCount(value, fallback = 2) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 5) : fallback;
}

function normalizeMimeType(mimeType = '') {
	const baseMimeType = String(mimeType || '').split(';')[0].trim().toLowerCase();
	if (!baseMimeType) return '';
	return MIME_NORMALIZATION_ALIASES[baseMimeType] || baseMimeType;
}

function normalizeEnv(sourceEnv) {
	if (typeof sourceEnv === 'string') {
		try {
			return JSON.parse(sourceEnv);
		} catch {
			return {};
		}
	}
	return sourceEnv && typeof sourceEnv === 'object' ? sourceEnv : {};
}

function buildOutputFilename(filename = 'document') {
	if (filename.toLowerCase().endsWith('.pdf')) {
		return filename;
	}
	const lastDot = filename.lastIndexOf('.');
	const base = lastDot > 0 ? filename.slice(0, lastDot) : filename;
	return `${base}.pdf`;
}

function parseDataUrlBase64(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith('data:')) {
		const splitIndex = trimmed.indexOf('base64,');
		if (splitIndex === -1) return null;
		return trimmed.slice(splitIndex + 7);
	}
	return trimmed;
}

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

function base64ToUint8Array(base64String) {
	if (typeof atob !== 'function') {
		return new Uint8Array(Buffer.from(base64String, 'base64'));
	}
	const binary = atob(base64String);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function uint8ToBase64(bytes) {
	if (typeof btoa !== 'function') {
		return Buffer.from(bytes).toString('base64');
	}
	let binary = '';
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.slice(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function base64ByteLength(base64String) {
	try {
		return atob(base64String).length;
	} catch {
		return 0;
	}
}

function getCandidatePdfData(payload) {
	if (!payload || typeof payload !== 'object') return null;
	return (
		payload?.data?.pdfData ||
		payload?.pdfData ||
		payload?.data?.base64 ||
		payload?.base64 ||
		payload?.data?.fileData ||
		payload?.fileData ||
		null
	);
}

function getCandidateOutputFilename(payload, fallbackFilename) {
	return (
		payload?.data?.outputFilename ||
		payload?.outputFilename ||
		payload?.data?.filename ||
		payload?.filename ||
		buildOutputFilename(fallbackFilename)
	);
}

function getCandidatePageCount(payload) {
	const parsed = Number(payload?.data?.pageCount ?? payload?.pageCount ?? 1);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildConvertXPathCandidates(rawPrefix = '/api') {
	const normalized = String(rawPrefix || '/api').trim();
	const prefix = normalized ? `/${normalized.replace(/^\/+|\/+$/g, '')}` : '';
	const prefixes = Array.from(new Set([prefix, '/api', '']));
	const suffixes = ['/combined', '/convert'];
	const paths = [];

	for (const routePrefix of prefixes) {
		for (const suffix of suffixes) {
			paths.push(`${routePrefix}${suffix}`.replace(/\/{2,}/g, '/'));
		}
	}

	return Array.from(new Set(paths));
}

async function fetchWithRetry(container, requestFactory, retries, timeoutMs) {
	let lastError = null;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await Promise.race([
				container.fetch(requestFactory()),
				new Promise((_, reject) => setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs))
			]);

			if (response.status >= 500 && attempt < retries) {
				await delay(250 * (attempt + 1));
				continue;
			}
			return response;
		} catch (error) {
			lastError = error;
			if (attempt < retries) {
				await delay(250 * (attempt + 1));
				continue;
			}
		}
	}

	throw lastError || new Error('ConvertX request failed');
}

function createConvertXRequest(path, { fileData, filename, mimeType, targetFormat }) {
	const decoded = parseDataUrlBase64(fileData);
	const binary = Uint8Array.from(atob(decoded), (ch) => ch.charCodeAt(0));
	const blob = new Blob([binary], { type: mimeType || 'application/octet-stream' });
	const form = new FormData();

	// ConvertX naming can differ by version; include a compatible set of fields.
	form.append('file', blob, filename);
	form.append('input', blob, filename);
	form.append('targetFormat', targetFormat);
	form.append('convert_to', targetFormat);
	form.append('output', targetFormat);
	form.append('to', targetFormat);

	return new Request(`http://convertx.internal${path}`, {
		method: 'POST',
		body: form
	});
}

async function parseConvertXResponse(response, fallbackFilename) {
	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	const disposition = response.headers.get('content-disposition') || '';
	const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
	const dispositionFilename = filenameMatch ? decodeURIComponent(filenameMatch[1] || filenameMatch[2] || '') : null;

	if (!response.ok) {
		let message = `ConvertX failed with status ${response.status}`;
		let code = response.status === 504 ? 'timeout' : 'conversion_failed';

		if (contentType.includes('application/json')) {
			const payload = await response.json().catch(() => null);
			message = payload?.error?.message || payload?.message || message;
			code = payload?.error?.code || payload?.code || code;
		} else {
			const text = await response.text().catch(() => null);
			if (text) message = text;
		}

		return { ok: false, error: { code, message } };
	}

	if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!hasPdfSignature(bytes)) {
			return {
				ok: false,
				error: {
					code: 'invalid_pdf_content',
					message: 'Converter response bytes are not a valid PDF'
				}
			};
		}
		const base64 = uint8ToBase64(bytes);
		return {
			ok: true,
			data: {
				pdfData: base64,
				pageCount: 1,
				outputFilename: dispositionFilename || buildOutputFilename(fallbackFilename)
			}
		};
	}

	const payload = await response.json().catch(() => null);
	const candidatePdf = parseDataUrlBase64(getCandidatePdfData(payload));
	if (candidatePdf) {
		let candidateBytes;
		try {
			candidateBytes = base64ToUint8Array(candidatePdf);
		} catch {
			return {
				ok: false,
				error: {
					code: 'invalid_base64',
					message: 'Converter returned invalid base64 for PDF payload'
				}
			};
		}
		if (!hasPdfSignature(candidateBytes)) {
			return {
				ok: false,
				error: {
					code: 'invalid_pdf_content',
					message: 'Converter payload is not a valid PDF'
				}
			};
		}
		return {
			ok: true,
			data: {
				pdfData: candidatePdf,
				pageCount: getCandidatePageCount(payload),
				outputFilename: getCandidateOutputFilename(payload, fallbackFilename)
			}
		};
	}

	const message = payload?.error?.message || payload?.message || 'ConvertX response missing PDF payload';
	return {
		ok: false,
		error: {
			code: 'conversion_failed',
			message
		}
	};
}

export class ConvertXContainer extends Container {
	defaultPort = 3000;
	sleepAfter = '5m';
	envVars = {
		ALLOW_UNAUTHENTICATED: 'true',
		ACCOUNT_REGISTRATION: 'false',
		HTTP_ALLOWED: 'true',
		API_ROUTE_PREFIX: '/api',
		AUTO_DELETE_EVERY_N_HOURS: '6'
	};
}

export default class extends WorkerEntrypoint {
	async getContainer() {
		return await getRandom(this.env.CONVERTX_CONTAINER);
	}

	async fetch(request, runtimeEnv = env) {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/health') {
			return toJsonResponse({
				status: 'ok',
				service: 'converter',
				mode: 'convertx-container',
				timestamp: new Date().toISOString()
			});
		}

		if (request.method === 'POST' && url.pathname === '/convert') {
			const result = await this.convert(request, runtimeEnv, '{}');
			const statusCode = result?.statusCode || 200;
			const responseBody = { ...result };
			delete responseBody.statusCode;
			return toJsonResponse(responseBody, statusCode);
		}

		return toJsonResponse({
			error: 'Not found'
		}, 404);
	}

	async health(request, caller_env = '{}', sagContext = '{}') {
		return {
			statusCode: 200,
			message: 'Converter service healthy',
			data: {
				service: 'converter',
				mode: 'convertx-container',
				timestamp: new Date().toISOString()
			}
		};
	}

	async convert(request, caller_env = '{}', sagContext = '{}') {
		const envObj = {
			...(this.env || {}),
			...normalizeEnv(caller_env)
		};
		const timeoutMs = parseTimeout(envObj.CONVERTER_TIMEOUT_MS, 12000);
		const retries = parseRetryCount(envObj.CONVERTX_RETRIES, 2);
		const targetFormat = (envObj.CONVERTX_TARGET_FORMAT || 'pdf').trim().toLowerCase();
		const routePrefix = envObj.CONVERTX_API_ROUTE_PREFIX || '/api';

		const rawBody = await request.clone().text();

		let payload;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			return {
				statusCode: 400,
				error: 'Invalid request',
				message: 'Request body must be valid JSON'
			};
		}

		const filename = payload?.filename || 'document';
		const mimeType = normalizeMimeType(payload?.mimeType || '');
		const fileData = payload?.fileData;
		if (!fileData || typeof fileData !== 'string') {
			return {
				statusCode: 400,
				error: 'Invalid request',
				message: 'fileData is required'
			};
		}

		if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
			return {
				statusCode: 422,
				error: {
					code: 'unsupported_type',
					message: `Unsupported mimeType: ${mimeType}`
				}
			};
		}

		let binaryLength = 0;
		try {
			const decoded = parseDataUrlBase64(fileData);
			binaryLength = base64ByteLength(decoded);
			if (!binaryLength) throw new Error('invalid');
		} catch {
			return {
				statusCode: 400,
				error: {
					code: 'invalid_base64',
					message: 'fileData must be valid base64'
				}
			};
		}

		const maxInputBytes = parseMaxInputBytes(envObj.CONVERTER_MAX_INPUT_BYTES);
		if (binaryLength > maxInputBytes) {
			return {
				statusCode: 413,
				error: {
					code: 'payload_too_large',
					message: `Input file exceeds ${maxInputBytes} bytes`
				}
			};
		}

		// PDF pass-through keeps behavior deterministic in mixed pipelines.
		if (mimeType === 'application/pdf') {
			const rawPdfData = parseDataUrlBase64(fileData);
			const pdfBytes = base64ToUint8Array(rawPdfData);
			if (!hasPdfSignature(pdfBytes)) {
				return {
					statusCode: 422,
					error: {
						code: 'invalid_pdf_content',
						message: 'Input declared as PDF but bytes are not a valid PDF'
					}
				};
			}
			return {
				statusCode: 200,
				data: {
					pdfData: rawPdfData,
					pageCount: 1,
					outputFilename: buildOutputFilename(filename)
				}
			};
		}

		try {
			const container = await this.getContainer();
			const candidatePaths = buildConvertXPathCandidates(routePrefix);
			let lastError = null;

			for (const path of candidatePaths) {
				const response = await fetchWithRetry(
					container,
					() => createConvertXRequest(path, { fileData, filename, mimeType, targetFormat }),
					retries,
					timeoutMs
				);

				if (response.status === 404 || response.status === 405) {
					lastError = { code: 'conversion_failed', message: `ConvertX route not found: ${path}` };
					continue;
				}

				const parsed = await parseConvertXResponse(response, filename);
				if (parsed.ok) {
					return {
						statusCode: 200,
						data: parsed.data
					};
				}

				lastError = parsed.error;
				if (parsed.error?.code === 'timeout') break;
			}

			const statusCode = lastError?.code === 'timeout' ? 504 : 500;
			return {
				statusCode,
				error: lastError || {
					code: 'conversion_failed',
					message: 'ConvertX conversion failed'
				}
			};
		} catch (error) {
			const isTimeout = error?.code === 'timeout' || error?.name === 'AbortError';
			return {
				statusCode: isTimeout ? 504 : 500,
				error: {
					code: isTimeout ? 'timeout' : 'conversion_failed',
					message: error?.message || 'ConvertX conversion failed'
				}
			};
		}
	}
}
