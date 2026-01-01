# Fax API Documentation

## Overview

This API provides comprehensive fax functionality with support for multiple providers:
- **Notifyre** - Secure, HIPAA-compliant fax service (default)
- **Telnyx** - Programmable Fax API with R2 storage integration

The API supports sending faxes, checking status, retrieving sent and received faxes, downloading fax documents, managing fax numbers, and handling webhooks.

## Quick Endpoint Reference

| Endpoint | Method | Auth Required | Description |
|----------|--------|---------------|-------------|
| `/v1/fax/send` | POST | Yes | Send a fax |
| `/v1/fax/status` | GET | Yes | Get fax status |
| `/v1/fax/sent` | GET | Yes | List sent faxes |
| `/v1/fax/received` | GET | Yes | List received faxes |
| `/v1/fax/sent/download` | GET | Yes | Download sent fax |
| `/v1/fax/received/download` | GET | Yes | Download received fax |
| `/v1/fax/numbers` | GET | Yes | List fax numbers |
| `/v1/fax/coverpages` | GET | Yes | List cover pages |
| `/v1/fax/webhook/notifyre` | POST | No | Notifyre webhook handler |
| `/v1/fax/health` | GET | No | Health check |
| `/v1/fax/health/protected` | GET | Yes | Protected health check |
| `/v1/fax/webhook/user-created` | POST | No | User creation webhook |

## Base URL
- **Staging**: `https://api-staging.sendfax.pro`
- **Production**: `https://api.sendfax.pro`

## Authentication

All authenticated endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

## Environment Variables Required

### Core Configuration
- `FAX_PROVIDER`: Provider selection (`notifyre` or `telnyx`, defaults to `notifyre`)
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `SUPABASE_JWT_SECRET`: JWT secret for token verification

### Notifyre Provider (default)
- `NOTIFYRE_API_KEY`: Your Notifyre API key
- `NOTIFYRE_WEBHOOK_SECRET`: (Optional) Secret for webhook signature verification

### Telnyx Provider (optional)
- `TELNYX_API_KEY`: Your Telnyx API key
- `TELNYX_CONNECTION_ID`: Telnyx Programmable Fax Application ID
- `R2_PUBLIC_DOMAIN`: Public domain for R2 file access (e.g., `https://files.yourdomain.com`)
- `FAX_FILES_BUCKET`: R2 bucket binding (configured in wrangler.toml)

## API Endpoints

### 1. Send Fax

**Endpoint**: `POST /v1/fax/send`  
**Authentication**: Required  
**Description**: Send a fax using Notifyre API

#### Request Body (JSON)
```json
{
  "recipient": "1234567890",
  "recipients": ["1234567890", "0987654321"],
  "message": "Optional cover page message",
  "coverPage": "template_id",
  "senderId": "your_sender_id",
  "files": [
    {
      "data": "base64_encoded_file_data",
      "filename": "document.pdf",
      "mimeType": "application/pdf"
    }
  ]
}
```

#### Request Body (Form Data)
```
recipients[]: 1234567890
recipients[]: 0987654321
message: Optional cover page message
coverPage: template_id
senderId: your_sender_id
files[]: <file_upload>
```

#### Response
```json
{
  "statusCode": 200,
  "message": "Fax submitted successfully",
  "data": {
    "id": "fax_123456",
    "status": "preparing",
    "originalStatus": "Preparing",
    "message": "Fax has been queued for sending",
    "timestamp": "2024-01-01T00:00:00Z",
    "recipient": "1234567890",
    "pages": 1,
    "cost": 0.03,
    "notifyreResponse": { /* Original Notifyre response */ }
  }
}
```

#### Supported File Types
- **PDF**: .pdf
- **Word**: .doc, .docx
- **Excel**: .xls, .xlsx
- **Text**: .txt, .rtf
- **PowerPoint**: .ppt, .pptx
- **Images**: .jpg, .jpeg, .png, .gif, .bmp, .tiff
- **Other**: .html, .ps

**Maximum file size**: 100MB  
**Recommended**: A4 standard sizing for best results

---

### 2. Get Fax Status

**Endpoint**: `GET /v1/fax/status?id={fax_id}`  
**Authentication**: Required  
**Description**: Get the current status of a sent fax

#### Query Parameters
- `id` (required): The fax ID to check

#### Response
```json
{
  "statusCode": 200,
  "message": "Status retrieved successfully",
  "data": {
    "id": "fax_123456",
    "status": "sent",
    "originalStatus": "Successful",
    "message": "Fax status retrieved",
    "timestamp": "2024-01-01T00:00:00Z",
    "recipient": "1234567890",
    "pages": 1,
    "cost": 0.03,
    "sentAt": "2024-01-01T00:05:00Z",
    "completedAt": "2024-01-01T00:05:30Z",
    "errorMessage": null,
    "notifyreResponse": { /* Original Notifyre response */ }
  }
}
```

#### Status Values
- `preparing`: Fax is being prepared for sending
- `in_progress`: Fax transmission in progress
- `sent`: Fax has been sent successfully
- `failed`: Fax has failed to send
- `failed_busy`: Failed - recipient was busy
- `failed_no_answer`: Failed - no answer
- `failed_invalid_number`: Failed - invalid number format
- `failed_not_fax_machine`: Failed - not a fax machine
- `cancelled`: Fax was cancelled

---

### 3. List Sent Faxes

**Endpoint**: `GET /v1/fax/sent`  
**Authentication**: Required  
**Description**: Retrieve a list of sent faxes

#### Query Parameters
- `limit` (optional): Number of results to return (default: 50)
- `offset` (optional): Number of results to skip (default: 0)
- `fromDate` (optional): Start date filter (ISO 8601 format)
- `toDate` (optional): End date filter (ISO 8601 format)

#### Response
```json
{
  "statusCode": 200,
  "message": "Sent faxes retrieved successfully",
  "data": {
    "faxes": [
      {
        "id": "fax_123456",
        "status": "sent",
        "originalStatus": "Successful",
        "recipient": "1234567890",
        "pages": 1,
        "cost": 0.03,
        "sentAt": "2024-01-01T00:05:00Z",
        "completedAt": "2024-01-01T00:05:30Z",
        "errorMessage": null
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0
  }
}
```

---

### 4. List Received Faxes

**Endpoint**: `GET /v1/fax/received`  
**Authentication**: Required  
**Description**: Retrieve a list of received faxes

#### Query Parameters
- `limit` (optional): Number of results to return (default: 50)
- `offset` (optional): Number of results to skip (default: 0)
- `fromDate` (optional): Start date filter (ISO 8601 format)
- `toDate` (optional): End date filter (ISO 8601 format)

#### Response
```json
{
  "statusCode": 200,
  "message": "Received faxes retrieved successfully",
  "data": {
    "faxes": [
      {
        "id": "received_fax_123456",
        "sender": "0987654321",
        "pages": 2,
        "receivedAt": "2024-01-01T00:10:00Z",
        "faxNumber": "1234567890",
        "fileUrl": "https://api.notifyre.com/download/..."
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0
  }
}
```

---

### 5. Download Sent Fax

**Endpoint**: `GET /v1/fax/sent/download?id={fax_id}`  
**Authentication**: Required  
**Description**: Download a sent fax document

#### Query Parameters
- `id` (required): The fax ID to download

#### Response
```json
{
  "statusCode": 200,
  "message": "Fax downloaded successfully",
  "data": {
    "id": "fax_123456",
    "fileData": "base64_encoded_pdf_data",
    "filename": "fax_123456.pdf",
    "mimeType": "application/pdf"
  }
}
```

---

### 6. Download Received Fax

**Endpoint**: `GET /v1/fax/received/download?id={fax_id}`  
**Authentication**: Required  
**Description**: Download a received fax document

#### Query Parameters
- `id` (required): The received fax ID to download

#### Response
```json
{
  "statusCode": 200,
  "message": "Received fax downloaded successfully",
  "data": {
    "id": "received_fax_123456",
    "fileData": "base64_encoded_pdf_data",
    "filename": "received_fax_123456.pdf",
    "mimeType": "application/pdf"
  }
}
```

---

### 7. List Fax Numbers

**Endpoint**: `GET /v1/fax/numbers`  
**Authentication**: Required  
**Description**: Get a list of your fax numbers

#### Response
```json
{
  "statusCode": 200,
  "message": "Fax numbers retrieved successfully",
  "data": {
    "faxNumbers": [
      {
        "id": "number_123",
        "number": "1234567890",
        "country": "US",
        "areaCode": "123",
        "isActive": true,
        "createdAt": "2024-01-01T00:00:00Z"
      }
    ]
  }
}
```

---

### 8. List Cover Pages

**Endpoint**: `GET /v1/fax/coverpages`  
**Authentication**: Required  
**Description**: Get a list of available cover page templates

#### Response
```json
{
  "statusCode": 200,
  "message": "Cover pages retrieved successfully",
  "data": {
    "coverPages": [
      {
        "id": "template_123",
        "name": "Business Template",
        "description": "Professional business cover page",
        "isDefault": true,
        "createdAt": "2024-01-01T00:00:00Z"
      }
    ]
  }
}
```

---

### 9. Notifyre Webhook Handler

**Endpoint**: `POST /v1/fax/webhook/notifyre`  
**Authentication**: None (webhook secret verification)  
**Description**: Handle incoming webhooks from Notifyre for fax status updates

#### Webhook Events
- `fax.sent`: Fax was successfully sent
- `fax.delivered`: Fax was delivered (alias for fax.sent)
- `fax.failed`: Fax sending failed
- `fax.received`: New fax was received

#### Request Body (from Notifyre)
```json
{
  "event": "fax.sent",
  "data": {
    "id": "fax_123456",
    "status": "Successful",
    "recipients": ["1234567890"],
    "pages": 1,
    "cost": 0.03,
    "completedAt": "2024-01-01T00:05:30Z"
  }
}
```

#### Response
```json
{
  "statusCode": 200,
  "message": "Webhook processed successfully",
  "data": {
    "id": "webhook_1704067200000",
    "status": "processed",
    "message": "Notifyre webhook processed successfully",
    "timestamp": "2024-01-01T00:00:00Z",
    "event": "fax.sent",
    "data": { /* Processed data */ }
  }
}
```

---

### 10. Health Check

**Endpoint**: `GET /v1/fax/health`  
**Authentication**: None  
**Description**: Check service health status

#### Response
```json
{
  "statusCode": 200,
  "message": "Notifyre Fax service healthy",
  "data": {
    "service": "notifyre-fax",
    "timestamp": "2024-01-01T00:00:00Z",
    "version": "2.0.0",
    "features": [
      "send-fax",
      "get-status",
      "list-sent-faxes",
      "list-received-faxes",
      "download-faxes",
      "fax-numbers",
      "cover-pages",
      "webhooks"
    ]
  }
}
```

---

### 11. Protected Health Check

**Endpoint**: `GET /v1/fax/health/protected`  
**Authentication**: Required  
**Description**: Check service health status with authentication

#### Response
```json
{
  "statusCode": 200,
  "message": "Notifyre Fax service healthy (authenticated)",
  "data": {
    "service": "notifyre-fax",
    "user": {
      "sub": "user_id",
      "email": "user@example.com"
    },
    "timestamp": "2024-01-01T00:00:00Z",
    "version": "2.0.0",
    "authenticated": true,
    "features": [
      "send-fax",
      "get-status",
      "list-sent-faxes",
      "list-received-faxes",
      "download-faxes",
      "fax-numbers",
      "cover-pages",
      "webhooks"
    ]
  }
}
```

---

### 12. User Creation Webhook (Supabase)

**Endpoint**: `POST /v1/fax/webhook/user-created`  
**Authentication**: None (webhook secret verification)  
**Description**: Handle user creation events from Supabase

---

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "statusCode": 400|401|403|404|500,
  "error": "Error type",
  "message": "Human readable error message",
  "details": "Additional error details (in development)"
}
```

### Common Error Codes
- `400`: Bad Request - Invalid request parameters
- `401`: Unauthorized - Missing or invalid authentication
- `403`: Forbidden - Insufficient permissions
- `404`: Not Found - Resource not found
- `500`: Internal Server Error - Server-side error

---

## Rate Limiting

The API respects Notifyre's rate limiting policies. If rate limits are exceeded, you'll receive a `429 Too Many Requests` response.

---

## Webhook Security

### Notifyre Webhooks
Notifyre webhooks can be verified using HMAC-SHA256 signatures. Set the `NOTIFYRE_WEBHOOK_SECRET` environment variable to enable verification.

### Supabase Webhooks
Supabase webhooks are verified using the `X-Supabase-Event-Secret` header and the `SUPABASE_WEBHOOK_SECRET` environment variable.

---

## Integration Examples

### JavaScript/Node.js
```javascript
// Send a fax
const response = await fetch('/v1/fax/send', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    recipient: '1234567890',
    message: 'Please find attached document',
    files: [{
      data: base64FileData,
      filename: 'document.pdf',
      mimeType: 'application/pdf'
    }]
  })
});

const result = await response.json();
console.log('Fax ID:', result.data.id);

// Check fax status
const statusResponse = await fetch(`/v1/fax/status?id=${result.data.id}`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const status = await statusResponse.json();
console.log('Fax Status:', status.data.status);
```

### cURL
```bash
# Send a fax
curl -X POST "https://api.sendfax.pro/v1/fax/send" \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "1234567890",
    "message": "Please find attached document",
    "files": [{
      "data": "base64_encoded_pdf_data",
      "filename": "document.pdf",
      "mimeType": "application/pdf"
    }]
  }'

# Get fax status
curl -X GET "https://api.sendfax.pro/v1/fax/status?id=fax_123456" \
  -H "Authorization: Bearer your-jwt-token"

# List sent faxes
curl -X GET "https://api.sendfax.pro/v1/fax/sent?limit=10" \
  -H "Authorization: Bearer your-jwt-token"

# List received faxes
curl -X GET "https://api.sendfax.pro/v1/fax/received?limit=10" \
  -H "Authorization: Bearer your-jwt-token"

# Download sent fax
curl -X GET "https://api.sendfax.pro/v1/fax/sent/download?id=fax_123456" \
  -H "Authorization: Bearer your-jwt-token" \
  -o downloaded_fax.pdf

# Download received fax
curl -X GET "https://api.sendfax.pro/v1/fax/received/download?id=received_fax_123456" \
  -H "Authorization: Bearer your-jwt-token" \
  -o downloaded_received_fax.pdf

# List fax numbers
curl -X GET "https://api.sendfax.pro/v1/fax/numbers" \
  -H "Authorization: Bearer your-jwt-token"

# List cover pages
curl -X GET "https://api.sendfax.pro/v1/fax/coverpages" \
  -H "Authorization: Bearer your-jwt-token"

# Health check (no auth)
curl -X GET "https://api.sendfax.pro/v1/fax/health"

# Protected health check
curl -X GET "https://api.sendfax.pro/v1/fax/health/protected" \
  -H "Authorization: Bearer your-jwt-token"
```

---

## Mobile App Integration Guide

This section provides tips and best practices for integrating the Fax API into mobile applications (iOS, Android, etc.).

### Authentication Handling
- **JWT Tokens**: Store JWT tokens securely using platform-specific secure storage (e.g., Keychain on iOS, KeyStore on Android).
- **Token Refresh**: Implement automatic token refresh logic if your backend supports refresh tokens. Handle 401 errors by prompting re-authentication.
- **Header Inclusion**: Always include the `Authorization: Bearer <token>` header in authenticated requests.

### Request Examples for Mobile Apps

#### Swift (iOS)
```swift
import Foundation

func sendFax(token: String, recipient: String, fileData: Data) async throws -> Data {
    let url = URL(string: "https://api.sendfax.pro/v1/fax/send")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    
    let body: [String: Any] = [
        "recipient": recipient,
        "files": [
            [
                "data": fileData.base64EncodedString(),
                "filename": "document.pdf",
                "mimeType": "application/pdf"
            ]
        ]
    ]
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
        throw URLError(.badServerResponse)
    }
    return data
}
```

#### Kotlin (Android)
```kotlin
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

fun sendFax(token: String, recipient: String, fileData: ByteArray, callback: Callback) {
    val client = OkHttpClient()
    val mediaType = "application/json; charset=utf-8".toMediaType()
    
    val json = """
    {
        "recipient": "$recipient",
        "files": [
            {
                "data": "${fileData.toBase64()}",
                "filename": "document.pdf",
                "mimeType": "application/pdf"
            }
        ]
    }
    """.trimIndent()
    
    val body = json.toRequestBody(mediaType)
    val request = Request.Builder()
        .url("https://api.sendfax.pro/v1/fax/send")
        .post(body)
        .addHeader("Authorization", "Bearer $token")
        .build()
    
    client.newCall(request).enqueue(callback)
}

// Extension for Base64 encoding
fun ByteArray.toBase64(): String = android.util.Base64.encodeToString(this, android.util.Base64.NO_WRAP)
```

### Error Handling
- **Network Errors**: Implement retry logic with exponential backoff for transient failures.
- **API Errors**: Parse error responses (status codes 400-500) and display user-friendly messages.
- **Rate Limiting**: Handle 429 responses by implementing rate limiting on the client side or showing a "try again later" message.
- **File Upload Limits**: Check file sizes before upload (max 100MB) and provide feedback for oversized files.

### Best Practices
- **Background Uploads**: Use background sessions for large file uploads to prevent app suspension.
- **Progress Indicators**: Show upload/download progress for better user experience.
- **Offline Handling**: Queue requests when offline and retry when connectivity is restored.
- **Security**: Never log or store sensitive data like tokens in plain text.
- **Testing**: Use staging environment for development and testing.

### Common Integration Patterns
- **Polling for Status**: After sending a fax, poll the status endpoint every 10-30 seconds until completion.
- **Webhook Alternatives**: For real-time updates, consider using push notifications or WebSockets if webhooks are not feasible.
- **Caching**: Cache fax lists locally to reduce API calls and improve performance.

---

## Development Setup

1. Set environment variables:
```bash
export NOTIFYRE_API_KEY="your_notifyre_api_key"
export NOTIFYRE_WEBHOOK_SECRET="your_webhook_secret"
export SUPABASE_URL="your_supabase_url"
export SUPABASE_SERVICE_ROLE_KEY="your_SUPABASE_SERVICE_ROLE_KEY"
export SUPABASE_JWT_SECRET="your_jwt_secret"
```

2. Deploy the service using Cloudflare Workers
3. Configure webhooks in your Notifyre dashboard to point to `/v1/fax/webhook/notifyre`

---

## Notes

- All timestamps are in ISO 8601 format (UTC)
- File uploads support both base64 encoding (JSON) and multipart form data
- The service automatically maps Notifyre's status codes to simplified versions
- Webhook events are stored in Supabase if database credentials are provided
- All endpoints support CORS for web applications
- The service is HIPAA compliant when used with Notifyre's secure infrastructure

---

## Support

For API support, please contact the development team or refer to the Notifyre documentation at [https://docs.notifyre.com](https://docs.notifyre.com).

Last Updated: July 6, 2025 
