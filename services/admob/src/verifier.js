/**
 * AdMob SSV Signature Verifier
 * Verifies server-side verification callbacks from AdMob
 */

import { AdMobKeyManager } from './utils.js';

/**
 * Standard Base64 decode
 */
function base64Decode(str) {
	return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

/**
 * Base64 URL decode (handles URL-safe base64 from signature)
 */
function base64UrlDecode(str) {
	// Replace URL-safe characters
	let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
	// Add padding if needed
	while (base64.length % 4) {
		base64 += '=';
	}
	return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

/**
 * Import ECDSA public key from base64 (standard base64, not URL-safe)
 */
async function importPublicKey(base64Key) {
	const keyData = base64Decode(base64Key);
	return await crypto.subtle.importKey(
		'spki',
		keyData,
		{
			name: 'ECDSA',
			namedCurve: 'P-256'
		},
		false,
		['verify']
	);
}

/**
 * Convert DER-encoded ECDSA signature to P1363 format (raw r||s)
 * AdMob returns DER-encoded signatures, but Web Crypto API expects P1363 format
 * 
 * DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
 * P1363 format: [r padded to 32 bytes][s padded to 32 bytes]
 */
function derToP1363(derSignature, logger) {
	try {
		let offset = 0;

		// Check SEQUENCE tag (0x30)
		if (derSignature[offset] !== 0x30) {
			logger?.log('ERROR', 'DER signature does not start with SEQUENCE tag', {
				firstByte: derSignature[0].toString(16)
			});
			throw new Error('Invalid DER signature: missing SEQUENCE tag');
		}
		offset++;

		// Skip total length (may be 1 or 2 bytes)
		let totalLength = derSignature[offset];
		offset++;
		if (totalLength & 0x80) {
			// Long form length
			const numLengthBytes = totalLength & 0x7f;
			offset += numLengthBytes;
		}

		// Parse R integer
		if (derSignature[offset] !== 0x02) {
			throw new Error('Invalid DER signature: missing INTEGER tag for R');
		}
		offset++;

		let rLength = derSignature[offset];
		offset++;

		// Handle R value (may have leading zero for positive sign)
		let rStart = offset;
		if (derSignature[rStart] === 0x00 && rLength > 32) {
			rStart++;
			rLength--;
		}
		const r = derSignature.slice(rStart, offset + (derSignature[offset - 1] === 0x00 && rLength > 1 ? rLength : rLength));
		offset = rStart + (rLength > 32 ? 32 : rLength);

		// Actually, let's be more careful with parsing
		offset = 0;

		// SEQUENCE tag
		if (derSignature[offset++] !== 0x30) {
			throw new Error('Invalid DER: no SEQUENCE');
		}

		// SEQUENCE length
		let seqLength = derSignature[offset++];
		if (seqLength & 0x80) {
			const numBytes = seqLength & 0x7f;
			seqLength = 0;
			for (let i = 0; i < numBytes; i++) {
				seqLength = (seqLength << 8) | derSignature[offset++];
			}
		}

		// R INTEGER
		if (derSignature[offset++] !== 0x02) {
			throw new Error('Invalid DER: no INTEGER for R');
		}

		let rLen = derSignature[offset++];
		let rBytes = derSignature.slice(offset, offset + rLen);
		offset += rLen;

		// S INTEGER
		if (derSignature[offset++] !== 0x02) {
			throw new Error('Invalid DER: no INTEGER for S');
		}

		let sLen = derSignature[offset++];
		let sBytes = derSignature.slice(offset, offset + sLen);

		logger?.log('DEBUG', 'DER parsing results', {
			rLen,
			sLen,
			rBytesLength: rBytes.length,
			sBytesLength: sBytes.length,
			rFirstByte: rBytes[0]?.toString(16),
			sFirstByte: sBytes[0]?.toString(16)
		});

		// Remove leading zeros (used for positive sign in DER)
		while (rBytes.length > 32 && rBytes[0] === 0x00) {
			rBytes = rBytes.slice(1);
		}
		while (sBytes.length > 32 && sBytes[0] === 0x00) {
			sBytes = sBytes.slice(1);
		}

		// Pad to 32 bytes if needed (for P-256)
		const rPadded = new Uint8Array(32);
		const sPadded = new Uint8Array(32);

		rPadded.set(rBytes, 32 - rBytes.length);
		sPadded.set(sBytes, 32 - sBytes.length);

		// Concatenate r || s
		const p1363 = new Uint8Array(64);
		p1363.set(rPadded, 0);
		p1363.set(sPadded, 32);

		logger?.log('DEBUG', 'Converted DER to P1363', {
			derLength: derSignature.length,
			p1363Length: p1363.length,
			rFinalLength: rBytes.length,
			sFinalLength: sBytes.length
		});

		return p1363;
	} catch (error) {
		logger?.log('ERROR', 'Failed to convert DER to P1363', {
			error: error.message,
			derLength: derSignature.length,
			derHex: Array.from(derSignature.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join('')
		});
		throw error;
	}
}

/**
 * Verify AdMob SSV callback signature
 */
export async function verifyAdMobCallback(url, logger) {
	try {
		logger?.log('INFO', '=== Starting AdMob SSV Verification ===');
		logger?.log('DEBUG', 'Full URL received', { fullUrl: url });

		const parsedUrl = new URL(url, 'https://example.com');
		const queryString = parsedUrl.search.substring(1); // Remove leading '?'

		logger?.log('DEBUG', 'Raw query string', {
			queryString,
			queryStringLength: queryString.length
		});

		// Find signature and key_id positions
		const signatureIndex = queryString.indexOf('signature=');
		const keyIdIndex = queryString.indexOf('key_id=');

		logger?.log('DEBUG', 'Parameter positions in query string', {
			signatureIndex,
			keyIdIndex,
			signatureComesFirst: signatureIndex < keyIdIndex
		});

		if (signatureIndex === -1 || keyIdIndex === -1) {
			logger?.log('ERROR', 'Missing required parameters', {
				hasSignature: signatureIndex !== -1,
				hasKeyId: keyIdIndex !== -1
			});
			throw new Error('Missing signature or key_id parameter');
		}

		// Extract content to verify (everything before signature parameter)
		// The content to sign is the query string up to (but not including) &signature=
		const contentToVerify = queryString.substring(0, signatureIndex - 1); // -1 for the & before signature

		logger?.log('DEBUG', 'Content to verify (what AdMob signed)', {
			contentToVerify,
			contentLength: contentToVerify.length,
			startsWithAmpersand: contentToVerify.startsWith('&'),
			endsWithAmpersand: contentToVerify.endsWith('&')
		});

		// Extract signature and key_id
		const sigAndKeyId = queryString.substring(signatureIndex);
		logger?.log('DEBUG', 'Signature and key_id portion', { sigAndKeyId });

		const signatureMatch = sigAndKeyId.match(/signature=([^&]+)/);
		const keyIdMatch = sigAndKeyId.match(/key_id=(\d+)/);

		if (!signatureMatch || !keyIdMatch) {
			logger?.log('ERROR', 'Failed to parse signature or key_id', {
				signatureMatch: !!signatureMatch,
				keyIdMatch: !!keyIdMatch,
				sigAndKeyId
			});
			throw new Error('Could not parse signature or key_id');
		}

		const signatureRaw = signatureMatch[1];
		const signature = decodeURIComponent(signatureRaw);
		const keyId = parseInt(keyIdMatch[1], 10);

		logger?.log('DEBUG', 'Extracted signature details', {
			keyId,
			signatureRaw,
			signatureRawLength: signatureRaw.length,
			signatureDecoded: signature,
			signatureDecodedLength: signature.length,
			signatureWasUrlEncoded: signatureRaw !== signature
		});

		// Fetch public keys from Google
		logger?.log('DEBUG', 'Fetching public keys from Google...');
		const keys = await AdMobKeyManager.fetchPublicKeys(logger);

		const availableKeyIds = Object.keys(keys).map(k => parseInt(k, 10));
		logger?.log('DEBUG', 'Available public keys from Google', {
			availableKeyIds,
			requestedKeyId: keyId,
			keyFound: !!keys[keyId],
			keyIdType: typeof keyId
		});

		if (!keys[keyId]) {
			logger?.log('ERROR', 'Key ID not found in Google\'s public keys', {
				requestedKeyId: keyId,
				availableKeyIds
			});
			throw new Error(`Unknown key_id: ${keyId}`);
		}

		const keyData = keys[keyId];
		logger?.log('DEBUG', 'Using public key', {
			keyId,
			hasBase64: !!keyData.base64,
			hasPem: !!keyData.pem,
			base64Length: keyData.base64?.length,
			base64Preview: keyData.base64?.substring(0, 50) + '...'
		});

		// Import the public key (standard base64)
		logger?.log('DEBUG', 'Importing public key...');
		let publicKey;
		try {
			publicKey = await importPublicKey(keyData.base64);
			logger?.log('DEBUG', 'Public key imported successfully', {
				keyType: publicKey.type,
				keyAlgorithm: publicKey.algorithm?.name
			});
		} catch (importError) {
			logger?.log('ERROR', 'Failed to import public key', {
				error: importError.message,
				base64Key: keyData.base64
			});
			throw importError;
		}

		// Decode signature (URL-safe base64 from AdMob)
		logger?.log('DEBUG', 'Decoding signature from base64url...');
		let signatureBytes;
		try {
			signatureBytes = base64UrlDecode(signature);
			logger?.log('DEBUG', 'Signature decoded successfully', {
				signatureBytesLength: signatureBytes.length,
				signatureHexPrefix: Array.from(signatureBytes.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(''),
				signatureHexSuffix: Array.from(signatureBytes.slice(-10)).map(b => b.toString(16).padStart(2, '0')).join(''),
				// DER-encoded ECDSA signatures typically start with 0x30 (SEQUENCE)
				looksLikeDER: signatureBytes[0] === 0x30
			});
		} catch (decodeError) {
			logger?.log('ERROR', 'Failed to decode signature', {
				error: decodeError.message,
				signature
			});
			throw decodeError;
		}

		// Encode content to verify as UTF-8 bytes
		const encoder = new TextEncoder();
		const contentBytes = encoder.encode(contentToVerify);
		logger?.log('DEBUG', 'Content encoded to bytes', {
			contentBytesLength: contentBytes.length,
			contentPreview: contentToVerify.substring(0, 100) + (contentToVerify.length > 100 ? '...' : '')
		});

		// Convert DER signature to P1363 format (Web Crypto API requirement)
		// AdMob uses DER-encoded signatures, but Web Crypto expects P1363 (r||s)
		let signatureBytesToVerify = signatureBytes;
		const isDER = signatureBytes[0] === 0x30;

		if (isDER) {
			logger?.log('DEBUG', 'Detected DER-encoded signature, converting to P1363...');
			try {
				signatureBytesToVerify = derToP1363(signatureBytes, logger);
				logger?.log('DEBUG', 'Successfully converted signature to P1363 format', {
					originalLength: signatureBytes.length,
					p1363Length: signatureBytesToVerify.length
				});
			} catch (conversionError) {
				logger?.log('ERROR', 'Failed to convert DER to P1363, trying raw signature', {
					error: conversionError.message
				});
				// Fall back to raw signature in case it's already P1363
				signatureBytesToVerify = signatureBytes;
			}
		} else {
			logger?.log('DEBUG', 'Signature does not appear to be DER-encoded, using as-is', {
				firstByte: signatureBytes[0].toString(16),
				signatureLength: signatureBytes.length
			});
		}

		// Verify signature using ECDSA with SHA-256
		logger?.log('DEBUG', 'Performing ECDSA verification...', {
			algorithm: 'ECDSA',
			hash: 'SHA-256',
			signatureBytesLength: signatureBytesToVerify.length,
			contentBytesLength: contentBytes.length,
			signatureFormat: isDER ? 'P1363 (converted from DER)' : 'raw'
		});

		const isValid = await crypto.subtle.verify(
			{
				name: 'ECDSA',
				hash: { name: 'SHA-256' }
			},
			publicKey,
			signatureBytesToVerify,
			contentBytes
		);

		logger?.log('DEBUG', 'Verification completed', { isValid });

		if (!isValid) {
			logger?.log('ERROR', 'Signature verification FAILED', {
				contentToVerify,
				signatureLength: signatureBytes.length,
				contentLength: contentBytes.length
			});
			throw new Error('Invalid signature');
		}

		logger?.log('INFO', '=== AdMob SSV Verification SUCCESSFUL ===');
		return true;

	} catch (error) {
		logger?.log('ERROR', 'AdMob signature verification failed', {
			error: error.message,
			stack: error.stack
		});
		throw error;
	}
}

/**
 * Parse AdMob SSV callback parameters
 */
export function parseAdMobCallback(url) {
	const parsedUrl = new URL(url, 'https://example.com');
	const params = parsedUrl.searchParams;

	return {
		adNetwork: params.get('ad_network'),
		adUnit: params.get('ad_unit'),
		customData: params.get('custom_data'),
		keyId: params.get('key_id'),
		rewardAmount: parseInt(params.get('reward_amount') || '0', 10),
		rewardItem: params.get('reward_item'),
		signature: params.get('signature'),
		timestamp: params.get('timestamp'),
		transactionId: params.get('transaction_id'),
		userId: params.get('user_id')
	};
}
