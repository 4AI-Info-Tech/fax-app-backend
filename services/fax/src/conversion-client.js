export class ConversionClientError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'ConversionClientError';
		this.code = code;
		this.details = details;
	}
}

function arrayBufferToBase64(arrayBuffer) {
	const bytes = new Uint8Array(arrayBuffer);
	if (typeof btoa !== 'function') {
		return Buffer.from(bytes).toString('base64');
	}
	let binary = '';
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.slice(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk);
	}
	return btoa(binary);
}

function base64ToUint8Array(base64) {
	if (typeof atob !== 'function') {
		return new Uint8Array(Buffer.from(base64, 'base64'));
	}
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
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

function parseDuration(value, fallbackMs) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export class ConversionClient {
	constructor(env = {}, logger = console) {
		this.env = env || {};
		this.logger = logger;
		this.defaultTimeoutMs = parseDuration(this.env.CONVERTER_TIMEOUT_MS, 12000);
	}

	getConverterBinding() {
		const converterService = this.env.CONVERTER_SERVICE;
		if (!converterService || typeof converterService.convert !== 'function') {
			throw new ConversionClientError(
				'conversion_config_missing',
				'CONVERTER_SERVICE binding is not configured'
			);
		}
		return converterService;
	}

	async convertToPdf({ bytes, filename, mimeType, timeoutMs }) {
		if (!bytes) {
			throw new ConversionClientError('conversion_failed', 'File bytes are required for conversion');
		}

		const converterService = this.getConverterBinding();
		const effectiveTimeoutMs = parseDuration(timeoutMs, this.defaultTimeoutMs);

		const arrayBuffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer?.slice(bytes.byteOffset || 0, (bytes.byteOffset || 0) + bytes.byteLength);
		if (!arrayBuffer) {
			throw new ConversionClientError('conversion_failed', 'Invalid file buffer');
		}

		const requestBody = JSON.stringify({
			filename,
			mimeType,
			fileData: arrayBufferToBase64(arrayBuffer)
		});

		const startedAt = Date.now();

		try {
			const request = new Request('https://converter.internal/convert', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: requestBody
			});
			const callerEnv = JSON.stringify({ CONVERTER_TIMEOUT_MS: String(effectiveTimeoutMs) });
			const result = await converterService.convert(request, callerEnv, '{}');
			const elapsedMs = Date.now() - startedAt;

			const statusCode = Number(result?.statusCode || 200);
			if (statusCode >= 400) {
				const reason = result?.error?.code || result?.error || 'conversion_failed';
				const message = result?.error?.message || result?.message || `Converter request failed with status ${statusCode}`;
				throw new ConversionClientError(reason, message, {
					statusCode,
					elapsedMs
				});
			}

			const payload = result?.data || result;
			const pdfData = payload?.data?.pdfData || payload?.pdfData;
			if (!pdfData) {
				throw new ConversionClientError('conversion_failed', 'Converter response missing pdfData', { elapsedMs });
			}

			const pageCount = Number(payload?.data?.pageCount ?? payload?.pageCount ?? 1);
			const outputFilename = payload?.data?.outputFilename || payload?.outputFilename || `${filename || 'document'}.pdf`;
			const pdfBytes = base64ToUint8Array(pdfData);
			if (!hasPdfSignature(pdfBytes)) {
				throw new ConversionClientError(
					'invalid_pdf_content',
					'Converter returned non-PDF bytes while claiming PDF output',
					{ elapsedMs }
				);
			}

			return {
				pdfBytes,
				pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1,
				outputFilename,
				elapsedMs
			};
		} catch (error) {
			if (error instanceof ConversionClientError) {
				throw error;
			}

			this.logger.log?.('ERROR', 'Unexpected converter client error', {
				error: error?.message || String(error)
			});
			throw new ConversionClientError(
				'conversion_failed',
				error?.message || 'Unexpected conversion error'
			);
		}
	}
}
