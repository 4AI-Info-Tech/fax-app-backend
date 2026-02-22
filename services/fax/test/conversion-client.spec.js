import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConversionClient } from '../src/conversion-client.js';

describe('ConversionClient', () => {
	const logger = { log: vi.fn() };
	let mockConverterService;

	beforeEach(() => {
		mockConverterService = {
			convert: vi.fn()
		};
		vi.clearAllMocks();
	});

	it('throws configuration error when converter service binding is missing', async () => {
		const client = new ConversionClient({}, logger);
		await expect(client.convertToPdf({
			bytes: new Uint8Array([1, 2, 3]),
			filename: 'test.docx',
			mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		})).rejects.toMatchObject({
			code: 'conversion_config_missing'
		});
	});

	it('converts file bytes to PDF bytes on success', async () => {
		const pdfBase64 = typeof btoa === 'function'
			? btoa('%PDF-1.7\n')
			: Buffer.from('%PDF-1.7\n').toString('base64');
		mockConverterService.convert.mockResolvedValue({
			statusCode: 200,
			data: {
				pdfData: pdfBase64,
				pageCount: 3,
				outputFilename: 'test.pdf'
			}
		});

		const client = new ConversionClient({
			CONVERTER_SERVICE: mockConverterService,
			CONVERTER_TIMEOUT_MS: '12000'
		}, logger);

		const result = await client.convertToPdf({
			bytes: new Uint8Array([1, 2, 3]),
			filename: 'test.docx',
			mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		});

		expect(result.pageCount).toBe(3);
		expect(result.outputFilename).toBe('test.pdf');
		expect(result.pdfBytes).toBeInstanceOf(Uint8Array);
		expect(mockConverterService.convert).toHaveBeenCalledTimes(1);
		expect(mockConverterService.convert.mock.calls[0][0]).toBeInstanceOf(Request);
		expect(mockConverterService.convert.mock.calls[0][1]).toContain('CONVERTER_TIMEOUT_MS');
	});

	it('rejects converter output that is not valid PDF content', async () => {
		const notPdfBase64 = typeof btoa === 'function'
			? btoa('not-a-real-pdf')
			: Buffer.from('not-a-real-pdf').toString('base64');
		mockConverterService.convert.mockResolvedValue({
			statusCode: 200,
			data: {
				pdfData: notPdfBase64,
				pageCount: 1,
				outputFilename: 'fake.pdf'
			}
		});

		const client = new ConversionClient({
			CONVERTER_SERVICE: mockConverterService
		}, logger);

		await expect(client.convertToPdf({
			bytes: new Uint8Array([1, 2, 3]),
			filename: 'test.docx',
			mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		})).rejects.toMatchObject({
			code: 'invalid_pdf_content'
		});
	});

	it('maps converter failures to typed errors', async () => {
		mockConverterService.convert.mockResolvedValue({
			statusCode: 422,
			error: {
				code: 'unsupported_type',
				message: 'Unsupported'
			}
		});

		const client = new ConversionClient({
			CONVERTER_SERVICE: mockConverterService
		}, logger);

		await expect(client.convertToPdf({
			bytes: new Uint8Array([1, 2, 3]),
			filename: 'test.bin',
			mimeType: 'application/octet-stream'
		})).rejects.toMatchObject({
			code: 'unsupported_type'
		});
	});

	it('maps timeout responses to timeout error code', async () => {
		mockConverterService.convert.mockResolvedValue({
			statusCode: 504,
			error: {
				code: 'timeout',
				message: 'Conversion timed out'
			}
		});
		const client = new ConversionClient({
			CONVERTER_SERVICE: mockConverterService
		}, logger);

		await expect(client.convertToPdf({
			bytes: new Uint8Array([1, 2, 3]),
			filename: 'test.docx',
			mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			timeoutMs: 1
		})).rejects.toMatchObject({
			code: 'timeout'
		});
	});

	it('maps unexpected converter exceptions to conversion_failed', async () => {
		mockConverterService.convert.mockRejectedValue(new Error('RPC down'));
		const client = new ConversionClient({
			CONVERTER_SERVICE: mockConverterService
		}, logger);

		await expect(client.convertToPdf({
			bytes: new Uint8Array([1, 2, 3]),
			filename: 'test.docx',
			mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		})).rejects.toMatchObject({
			code: 'conversion_failed'
		});
	});
});
