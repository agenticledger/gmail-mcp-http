import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { tools } from '../dist/tools.js';
import {
  getAttachment,
  parseAttachment,
  attachmentKind,
  MAX_ATTACHMENT_BYTES,
  MAX_BASE64_BYTES,
  UNTRUSTED_NOTE,
} from '../dist/attachments.js';
import { GmailClient } from '../dist/api-client.js';
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const attachment = (data: string, overrides: any = {}) => ({
  partId: '1',
  filename: 'invoice.txt',
  mimeType: 'text/plain',
  body: { size: Buffer.from(data, 'base64url').length, data },
  ...overrides,
});
const fake = (part: any) =>
  ({
    getMessage: async () => ({
      id: 'm1',
      payload: { mimeType: 'multipart/mixed', parts: [part] },
    }),
  }) as any;
const invoke = async (name: string, client: any, args: any) => {
  const t = tools.find((t) => t.name === name)!;
  return t.handler(client, t.inputSchema.parse(args));
};
test('read message and thread expose nested attachment metadata and preserve body fields', async () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: b64('hello') } },
      {
        mimeType: 'multipart/related',
        parts: [
          attachment('', {
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            body: { size: 123, attachmentId: 'aid' },
          }),
          attachment(b64('image'), {
            partId: '2',
            filename: '',
            mimeType: 'image/png',
            headers: [{ name: 'CONTENT-ID', value: '<logo>' }],
          }),
        ],
      },
    ],
  };
  const msg = { id: 'm1', payload };
  const client = {
    getMessage: async () => msg,
    getThread: async () => ({ messages: [msg, msg] }),
  };
  const read = await invoke('gmail_read_message', client, { message_id: 'm1' });
  assert.equal(read.body, 'hello');
  assert.equal(read.attachments.length, 2);
  assert.deepEqual(read.attachments[0], {
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: 123,
    attachmentId: 'aid',
    partId: '1',
    inline: false,
  });
  assert.equal(read.attachments[1].inline, true);
  assert.equal(read.attachments[1].attachmentId, null);
  assert.equal(
    (await invoke('gmail_read_thread', client, { thread_id: 't1' })).messages[1]
      .attachments.length,
    2,
  );
});
test('default text mode handles embedded bytes and prefixes untrusted content', async () => {
  const r = await invoke(
    'gmail_get_attachment',
    fake(attachment(b64('invoice total 42'))),
    { messageId: 'm1', partId: '1' },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.text, UNTRUSTED_NOTE + '\ninvoice total 42');
  assert.equal(r.untrusted, true);
});
test('attachmentId fetch is bound to a MIME part in the requested message', async () => {
  let fetched = 0;
  const client = fake(
    attachment('', { body: { size: 8, attachmentId: 'a1' } }),
  );
  client.getAttachment = async (m: string, a: string) => {
    assert.equal(m, 'm1');
    assert.equal(a, 'a1');
    fetched++;
    return { data: b64('external'), size: 8 };
  };
  assert.equal(
    (await getAttachment(client, { messageId: 'm1', attachmentId: 'unknown' }))
      .status,
    'not_found',
  );
  assert.equal(fetched, 0);
  assert.equal(
    (await getAttachment(client, { messageId: 'm1', attachmentId: 'a1' }))
      .status,
    'ok',
  );
  assert.equal(fetched, 1);
});
test('selector and mode validation; root partId may be empty', async () => {
  const t = tools.find((t) => t.name === 'gmail_get_attachment')!;
  for (const args of [
    { messageId: 'm' },
    { messageId: 'm', partId: '1', attachmentId: 'a' },
    { messageId: 'm', partId: '1', mode: 'bad' },
  ])
    assert.equal(t.inputSchema.safeParse(args).success, false);
  assert.equal(
    t.inputSchema.safeParse({ messageId: 'm', partId: '' }).success,
    true,
  );
});
test('base64 roundtrip and image text returns explicit no-OCR answer', async () => {
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const client = fake(
    attachment(b64(image), { filename: 'logo.png', mimeType: 'image/png' }),
  );
  const raw = await getAttachment(client, {
    messageId: 'm',
    partId: '1',
    mode: 'base64',
  });
  assert.equal(raw.status, 'ok');
  assert.deepEqual(Buffer.from(raw.base64!, 'base64'), image);
  assert.equal(
    (await getAttachment(client, { messageId: 'm', partId: '1' })).status,
    'not_extractable',
  );
});
test('active/executable/macro and MIME mismatches rejected even in base64 mode', async () => {
  for (const [name, mime] of [
    ['x.html', 'text/html'],
    ['x.svg', 'image/svg+xml'],
    ['x.js', 'text/plain'],
    ['x.exe', 'application/octet-stream'],
    ['x.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
    ['x.docm', 'application/octet-stream'],
    ['x.pdf', 'text/html'],
  ]) {
    assert.equal(attachmentKind(name, mime), null);
    assert.equal(
      (
        await getAttachment(
          fake(attachment(b64('bad'), { filename: name, mimeType: mime })),
          { messageId: 'm', partId: '1', mode: 'base64' },
        )
      ).status,
      'refused',
    );
  }
  assert.equal(
    (
      await getAttachment(fake(attachment(b64('<html>active</html>'))), {
        messageId: 'm',
        partId: '1',
        mode: 'base64',
      })
    ).status,
    'refused',
  );
});
test('size caps checked before download and after decoding; malformed data refused', async () => {
  let calls = 0;
  const client = fake(
    attachment('', {
      body: { size: MAX_ATTACHMENT_BYTES + 1, attachmentId: 'a' },
    }),
  );
  client.getAttachment = async () => {
    calls++;
    throw Error('should not download');
  };
  assert.equal(
    (await getAttachment(client, { messageId: 'm', attachmentId: 'a' })).status,
    'too_large',
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await getAttachment(
        fake(
          attachment(b64('x'.repeat(MAX_BASE64_BYTES + 1)), {
            body: { size: 0, data: b64('x'.repeat(MAX_BASE64_BYTES + 1)) },
          }),
        ),
        { messageId: 'm', partId: '1', mode: 'base64' },
      )
    ).status,
    'too_large',
  );
  assert.equal(
    (
      await getAttachment(fake(attachment('%%%')), {
        messageId: 'm',
        partId: '1',
      })
    ).status,
    'not_extractable',
  );
});
test('text truncation is explicit and bounded', async () => {
  const r = await getAttachment(fake(attachment(b64('x'.repeat(100_001)))), {
    messageId: 'm',
    partId: '1',
  });
  assert.equal(r.truncated, true);
  assert.equal(r.text!.length, 100_000 + UNTRUSTED_NOTE.length + 1);
});
async function docx(extra?: string) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Contract total 125</w:t></w:r></w:p></w:body></w:document>',
  );
  if (extra) zip.file(extra, 'malicious');
  return zip.generateAsync({ type: 'nodebuffer' });
}
test('DOCX extracts text and refuses disguised macro ZIP contents in both modes', async () => {
  const r = await parseAttachment(await docx(), 'docx', 'text');
  assert.equal(r.status, 'ok');
  assert.match(r.text, /Contract total 125/);
  for (const mode of ['text', 'base64'])
    assert.equal(
      (await parseAttachment(await docx('word/vbaProject.bin'), 'docx', mode))
        .status,
      'refused',
    );
});
test('XLSX extracts sheet/cell text without evaluating formulas', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Invoices');
  sheet.addRow(['Vendor', 'Total']);
  sheet.addRow(['Acme', 125]);
  sheet.getCell('C2').value = { formula: '1+1', result: 2 };
  const r = await parseAttachment(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    'xlsx',
    'text',
  );
  assert.equal(r.status, 'ok');
  assert.match(r.text, /Invoices/);
  assert.match(r.text, /Acme\t125\t2/);
});
function pdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (Invoice total 42) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
test('PDF extracts real text; malformed PDF gets explicit failure', async () => {
  const r = await parseAttachment(pdf(), 'pdf', 'text');
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.match(r.text, /Invoice total 42/);
  assert.equal(
    (await parseAttachment(Buffer.from('%PDF-broken'), 'pdf', 'text')).status,
    'not_extractable',
  );
});
test('ZIP expansion limit applies before parser', async () => {
  const zip = new JSZip();
  zip.file('word/document.xml', 'x'.repeat(21 * 1024 * 1024));
  const result = await parseAttachment(
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    'docx',
    'text',
  );
  assert.equal(result.status, 'too_large');
});
test('attachment endpoint escapes IDs and uses per-client OAuth token', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /messages\/m%2F1\/attachments\/a%3F2$/);
      assert.equal((init!.headers as any).Authorization, 'Bearer offline');
      return Response.json({ data: b64('text'), size: 4 });
    };
    await new GmailClient({
      type: 'access_token',
      value: 'offline',
    }).getAttachment('m/1', 'a?2');
  } finally {
    globalThis.fetch = previous;
  }
});
test('unnamed binary parts and disposition-inline attachments are discoverable', async () => {
  const client = fake(
    attachment('', {
      filename: '',
      mimeType: 'application/pdf',
      headers: [{ name: 'Content-Disposition', value: 'inline' }],
      body: { size: 123, attachmentId: 'pdf-id' },
    }),
  );
  const result = await invoke('gmail_read_message', client, {
    message_id: 'm',
  });
  assert.equal(result.attachments[0].attachmentId, 'pdf-id');
  assert.equal(result.attachments[0].inline, true);
});
test('CSV is extracted as untrusted UTF-8 text', async () => {
  const r = await getAttachment(
    fake(
      attachment(b64('vendor,total\nAcme,42'), {
        filename: 'invoice.csv',
        mimeType: 'text/csv',
      }),
    ),
    { messageId: 'm', partId: '1' },
  );
  assert.equal(r.status, 'ok');
  assert.match(r.text!, /Acme,42/);
});
test('streaming API response budget cancels oversized bodies', async () => {
  const previous = globalThis.fetch;
  let cancelled = false;
  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    await assert.rejects(
      () =>
        new GmailClient({
          type: 'access_token',
          value: 'offline',
        }).getAttachment('m', 'a'),
      /too large/,
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = previous;
  }
});
