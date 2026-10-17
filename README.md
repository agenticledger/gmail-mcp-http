# Gmail MCP HTTP

StreamableHTTP endpoint: https://gmailmcp.agenticledger.ai/mcp

Version 2.1.0 exposes 12 tools. Gmail reading now includes attachment metadata and `gmail_get_attachment` extracts document text or returns capped base64 bytes. Existing broker provider `google-gmail`, principal identity transport, Bearer passthrough, and sending tools remain unchanged.

- [Attachment contract, limits and catalog handoff](docs/ATTACHMENTS.md)
- [Tool reference](https://financemcps.agenticledger.ai/gmail/)
- [Machine-readable schemas](docs/tools.json)
- [Broker authentication](AUTH.md)

Node >=22.13.0. Install with `npm ci`, run `npm test` (includes compilation), regenerate docs with `node scripts/build-docs.mjs`, start with `npm start`. Tests use synthetic documents and mocked Gmail API responses; they do not read a real mailbox or send email.

Parser dependency audit: compatible dependency updates removed the high/critical findings present in the original lockfile. At release preparation, npm still reports moderate advisories via `qs`, Mammoth's CLI `argparse`/`sprintf-js`, and ExcelJS's `uuid`, plus a low dev-only `esbuild` advisory. Extraction does not use Mammoth's CLI or uuid v3/v5/v6 buffer APIs; parser deadlines, worker heap limits and ZIP limits apply. This is not an assertion of zero vulnerabilities.
