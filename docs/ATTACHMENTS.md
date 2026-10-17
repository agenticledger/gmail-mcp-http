# Gmail attachments — v2.1.0

`gmail_read_message(message_id)` and `gmail_read_thread(thread_id)` retain their existing fields and add `attachments` per message. Each entry contains `filename`, `mimeType`, `size` (bytes), nullable `attachmentId`, `partId`, and `inline` (Content-ID or inline disposition). Nested parts and inline images are included.

Call `gmail_get_attachment` with `messageId`, exactly one of `attachmentId` or `partId`, and optional `mode` (`text` by default, or `base64`). An empty partId is valid for a root MIME part. The attachment must belong to the requested message.

```json
{"messageId":"MESSAGE_ID","partId":"1","mode":"text"}
```

Text extraction: PDF, DOCX, XLSX, UTF-8 TXT/CSV; maximum 10 MiB input, 100,000 characters, 200 PDF pages, 15 seconds, four concurrent workers. Output begins with an untrusted-content warning; `truncated:true` indicates incomplete output. Formula results are read, not calculated. No OCR or password support.

Base64: allowed documents and PNG/JPEG/GIF/WebP, maximum 1 MiB decoded bytes (roughly 1.4 million base64 characters). Images require this explicit mode; default text mode returns `not_extractable`. No disk writes or external content fetching. ZIP packages are checked before parsing: 20 MiB expanded data, 2,000 entries, no macros or embedded binary objects. Worker heap is bounded; these checks do not replace antivirus scanning.

Active/executable types (HTML/SVG/JS/EXE/macro documents), unknown types and conflicting extensions/MIME types are refused in both modes. Metadata remains visible even when retrieval is refused. Structured statuses: `ok`, `too_large`, `refused`, `not_extractable`, `not_found`, `invalid_input`, `busy`. Provider/authentication failures remain tool errors.

Existing `google-gmail` broker identity and scopes stay unchanged. Gmail attachment API accepts `gmail.readonly`, `gmail.modify` or `https://mail.google.com/`; no new consent is needed for an existing read/modify grant. No outgoing attachment support in this release.

Finney catalog handoff: keep id `gmail`, endpoint, `brokerProvider: google-gmail`, and `brokerAuthMode: principal`; update toolCount from 11 to 12 and refresh discovery/tool descriptions to include `gmail_get_attachment`. No gateway-code change or MCP File Args configuration needed.

Build/test: `npm ci`, `npm test` (builds first), `node scripts/build-docs.mjs`. Node >=22.13 required by the PDF parser. The worker runs compiled `dist/attachment-worker.js`.

API reference: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get
