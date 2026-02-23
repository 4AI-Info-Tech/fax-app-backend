import { describe, expect, it } from 'vitest';
import { classifyForTelnyx, extractFileExtension } from '../src/file-type-policy.js';

describe('file-type-policy', () => {
	it('classifies PDF as pass-through', () => {
		expect(classifyForTelnyx('sample.pdf', 'application/pdf')).toBe('pass');
	});

	it('classifies image and text formats as iOS-local conversion formats', () => {
		expect(classifyForTelnyx('photo.jpg', 'image/jpeg')).toBe('ios_local');
		expect(classifyForTelnyx('notes.txt', 'text/plain')).toBe('ios_local');
		expect(classifyForTelnyx('page.htm', 'text/html')).toBe('ios_local');
	});

	it('classifies office and open document formats as backend conversion formats', () => {
		expect(classifyForTelnyx('invoice.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('backend_convert');
		expect(classifyForTelnyx('report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('backend_convert');
		expect(classifyForTelnyx('slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('backend_convert');
		expect(classifyForTelnyx('document.ods', 'application/vnd.oasis.opendocument.spreadsheet')).toBe('backend_convert');
	});

	it('classifies Apple iWork formats as backend conversion formats', () => {
		expect(classifyForTelnyx('presentation.key', 'application/vnd.apple.keynote')).toBe('backend_convert');
		expect(classifyForTelnyx('document.pages', 'application/vnd.apple.pages')).toBe('backend_convert');
	});

	it('falls back to MIME type extension when filename has no extension', () => {
		expect(extractFileExtension('document', 'application/pdf')).toBe('pdf');
		expect(classifyForTelnyx('document', 'application/pdf')).toBe('pass');
	});

	it('normalizes MIME variants for ppt and odt backend conversion types', () => {
		expect(classifyForTelnyx('slides', 'application/x-mspowerpoint; charset=binary')).toBe('backend_convert');
		expect(classifyForTelnyx('letter', 'application/x-vnd.oasis.opendocument.text')).toBe('backend_convert');
	});

	it('extracts clean extensions from signed URLs and query parameters', () => {
		expect(extractFileExtension('slides.pptx?token=abc', 'application/octet-stream')).toBe('pptx');
		expect(extractFileExtension('notes.odt#preview', 'application/octet-stream')).toBe('odt');
	});

	it('rejects unsupported types', () => {
		expect(classifyForTelnyx('archive.zip', 'application/zip')).toBe('reject');
		expect(classifyForTelnyx('script.sh', 'text/x-shellscript')).toBe('reject');
	});
});
