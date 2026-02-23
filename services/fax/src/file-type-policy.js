const PASS_THROUGH_EXTENSIONS = new Set(['pdf']);
const IOS_LOCAL_EXTENSIONS = new Set([
	'jpg', 'jpeg', 'png', 'tiff', 'tif', 'gif', 'bmp',
	'txt', 'rtf', 'html', 'htm'
]);
const BACKEND_CONVERT_EXTENSIONS = new Set([
	'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
	'key', 'pages'
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
	'application/vnd.apple.keynote': 'key',
	'application/vnd.apple.pages': 'pages',
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

const MIME_NORMALIZATION_ALIASES = {
	'application/x-vnd.oasis.opendocument.text': 'application/vnd.oasis.opendocument.text',
	'application/x-vnd.oasis.opendocument.spreadsheet': 'application/vnd.oasis.opendocument.spreadsheet',
	'application/mspowerpoint': 'application/vnd.ms-powerpoint',
	'application/powerpoint': 'application/vnd.ms-powerpoint',
	'application/x-mspowerpoint': 'application/vnd.ms-powerpoint'
};

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
	key: 'application/vnd.apple.keynote',
	pages: 'application/vnd.apple.pages',
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

function sanitizeExtension(extension = '') {
	return String(extension).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeMimeType(mimeType = '') {
	if (typeof mimeType !== 'string') return '';
	const baseMimeType = mimeType.split(';')[0].trim().toLowerCase();
	if (!baseMimeType) return '';
	return MIME_NORMALIZATION_ALIASES[baseMimeType] || baseMimeType;
}

export function getMimeTypeForExtension(extension = '') {
	const normalizedExtension = sanitizeExtension(extension);
	return normalizedExtension ? (EXTENSION_MIME_MAP[normalizedExtension] || '') : '';
}

export function extractFileExtension(filename = '', mimeType = '') {
	if (typeof filename === 'string') {
		const cleanFilename = filename.split(/[?#]/)[0];
		const parts = cleanFilename.split('.');
		if (parts.length > 1) {
			const ext = sanitizeExtension(parts.pop());
			if (ext) return ext;
		}
	}

	const normalizedMime = normalizeMimeType(mimeType);
	if (normalizedMime && MIME_EXTENSION_FALLBACK[normalizedMime]) {
		return MIME_EXTENSION_FALLBACK[normalizedMime];
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
