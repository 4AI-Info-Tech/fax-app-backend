const PASS_THROUGH_EXTENSIONS = new Set(['pdf']);
const IOS_LOCAL_EXTENSIONS = new Set([
	'jpg', 'jpeg', 'png', 'tiff', 'tif', 'gif', 'bmp',
	'txt', 'rtf', 'html', 'htm'
]);
const BACKEND_CONVERT_EXTENSIONS = new Set([
	'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods'
]);

const MIME_EXTENSION_FALLBACK = {
	'application/pdf': 'pdf',
	'application/msword': 'doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.ms-excel': 'xls',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'application/vnd.ms-powerpoint': 'ppt',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
	'application/vnd.oasis.opendocument.text': 'odt',
	'application/vnd.oasis.opendocument.spreadsheet': 'ods',
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/tiff': 'tiff',
	'image/gif': 'gif',
	'image/bmp': 'bmp',
	'text/plain': 'txt',
	'application/rtf': 'rtf',
	'text/rtf': 'rtf',
	'text/html': 'html'
};

export function extractFileExtension(filename = '', mimeType = '') {
	if (typeof filename === 'string') {
		const parts = filename.split('.');
		if (parts.length > 1) {
			const ext = parts.pop().trim().toLowerCase();
			if (ext) return ext;
		}
	}

	if (typeof mimeType === 'string') {
		const normalizedMime = mimeType.trim().toLowerCase();
		if (normalizedMime && MIME_EXTENSION_FALLBACK[normalizedMime]) {
			return MIME_EXTENSION_FALLBACK[normalizedMime];
		}
	}

	return '';
}

export function classifyForTelnyx(filename = '', mimeType = '') {
	const ext = extractFileExtension(filename, mimeType);
	if (!ext) return 'reject';
	if (PASS_THROUGH_EXTENSIONS.has(ext)) return 'pass';
	if (IOS_LOCAL_EXTENSIONS.has(ext)) return 'ios_local';
	if (BACKEND_CONVERT_EXTENSIONS.has(ext)) return 'backend_convert';
	return 'reject';
}

export function getTelnyxFormatSupport() {
	return {
		passThrough: Array.from(PASS_THROUGH_EXTENSIONS),
		iosLocal: Array.from(IOS_LOCAL_EXTENSIONS),
		backendConvert: Array.from(BACKEND_CONVERT_EXTENSIONS)
	};
}
