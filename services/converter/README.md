# Converter Service

This service exposes an internal conversion endpoint used by the fax service to convert
Office/OpenDocument files to PDF for Telnyx delivery.

## Runtime

- Worker entrypoint: `src/index.js`
- Cloudflare Containers class: `ConvertXContainer`
- Converter image: `ghcr.io/c4illin/convertx:v0.16.0` (pinned)
- Invocation model: internal Worker service binding (`CONVERTER_SERVICE`) from `fax-service`
- Shared deployment model: one `converter-service` instance used by both staging and prod

## Request

```json
{
	"filename": "example.docx",
	"mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"fileData": "<base64>"
}
```

## Response

```json
{
	"statusCode": 200,
	"data": {
		"pdfData": "<base64>",
		"pageCount": 3,
		"outputFilename": "example.pdf"
	}
}
```

## Security

- No public route is configured (`workers_dev = false`).
- Conversion calls are expected via internal Cloudflare service binding only.
- ConvertX runs with unauthenticated mode enabled, but remains internal-only because the
  worker/container is not exposed to the public internet.

## Notes

- Primary adapter path is `POST /api/combined` with route fallback (`/api/convert`, `/combined`, `/convert`)
  for ConvertX compatibility across versions.
- The service normalizes output to a stable internal payload:
  - `data.pdfData` (base64 PDF)
  - `data.pageCount`
  - `data.outputFilename`
