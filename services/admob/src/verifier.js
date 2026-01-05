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
 * Verify AdMob SSV callback signature
 */
export async function verifyAdMobCallback(url, logger) {
	try {
		logger?.log('DEBUG', 'Starting AdMob verification', { fullUrl: url });
		
		const parsedUrl = new URL(url, 'https://example.com');
		const queryString = parsedUrl.search.substring(1); // Remove leading '?'
		
		logger?.log('DEBUG', 'Parsed URL', { 
			queryString,
			searchLength: parsedUrl.search.length
		});
		
		// Find signature and key_id positions
		const signatureIndex = queryString.indexOf('signature=');
		const keyIdIndex = queryString.indexOf('key_id=');
		
		logger?.log('DEBUG', 'Parameter positions', { signatureIndex, keyIdIndex });
		
		if (signatureIndex === -1 || keyIdIndex === -1) {
			throw new Error('Missing signature or key_id parameter');
		}
		
		// Extract content to verify (everything before signature parameter)
		const contentToVerify = queryString.substring(0, signatureIndex - 1); // -1 for the & before signature
		
		// Extract signature and key_id
		const sigAndKeyId = queryString.substring(signatureIndex);
		const signatureMatch = sigAndKeyId.match(/signature=([^&]+)/);
		const keyIdMatch = sigAndKeyId.match(/key_id=(\d+)/);
		
		if (!signatureMatch || !keyIdMatch) {
			throw new Error('Could not parse signature or key_id');
		}
		
		const signatureRaw = signatureMatch[1];
		const signature = decodeURIComponent(signatureRaw);
		const keyId = parseInt(keyIdMatch[1], 10);
		
		logger?.log('DEBUG', 'Verifying AdMob callback', { 
			keyId, 
			contentToVerify,
			signatureRaw,
			signatureDecoded: signature,
			signatureLength: signature.length
		});
		
		// Fetch public keys
		const keys = await AdMobKeyManager.fetchPublicKeys(logger);
		
		logger?.log('DEBUG', 'Available key IDs', { 
			availableKeys: Object.keys(keys),
			requestedKeyId: keyId,
			keyFound: !!keys[keyId]
		});
		
		if (!keys[keyId]) {
			throw new Error(`Unknown key_id: ${keyId}`);
		}
		
		logger?.log('DEBUG', 'Using public key', { 
			keyId,
			base64KeyLength: keys[keyId].base64.length,
			base64KeyPreview: keys[keyId].base64.substring(0, 50) + '...'
		});
		
		// Import the public key (standard base64)
		const publicKey = await importPublicKey(keys[keyId].base64);
		logger?.log('DEBUG', 'Public key imported successfully');
		
		// Decode signature (URL-safe base64 from AdMob)
		const signatureBytes = base64UrlDecode(signature);
		logger?.log('DEBUG', 'Signature decoded', { 
			signatureBytesLength: signatureBytes.length,
			signatureHex: Array.from(signatureBytes.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join('')
		});
		
		// Encode content to verify as UTF-8 bytes
		const encoder = new TextEncoder();
		const contentBytes = encoder.encode(contentToVerify);
		logger?.log('DEBUG', 'Content encoded', { contentBytesLength: contentBytes.length });
		
		// Verify signature using ECDSA with SHA-256
		// AdMob uses DER-encoded signatures
		const isValid = await crypto.subtle.verify(
			{
				name: 'ECDSA',
				hash: { name: 'SHA-256' }
			},
			publicKey,
			signatureBytes,
			contentBytes
		);
		
		logger?.log('DEBUG', 'Verification result', { isValid });
		
		if (!isValid) {
			throw new Error('Invalid signature');
		}
		
		logger?.log('INFO', 'AdMob callback signature verified successfully');
		return true;
		
	} catch (error) {
		logger?.log('ERROR', 'AdMob signature verification failed', { error: error.message });
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
