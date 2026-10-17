import { parentPort, workerData } from 'node:worker_threads';
import yauzl from 'yauzl';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
const { kind, mode, maxChars } = workerData;
const bytes = Buffer.from(workerData.bytes);
// Read every ZIP member with byte accounting before handing Office documents to a parser.
async function checkOffice(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(error);
        let total = 0,
          count = 0;
        const names = new Set<string>();
        const fail = (e: unknown) => {
          zip.close();
          reject(e);
        };
        zip.on('error', fail);
        zip.on('entry', (entry) => {
          const name = entry.fileName.toLowerCase();
          if (
            ++count > 2000 ||
            names.has(name) ||
            /vbaproject|macrosheet|embeddings\/|\.bin$|\.exe$|\.js$|\.svg$|\.html?$/.test(
              name,
            ) ||
            entry.generalPurposeBitFlag & 1
          )
            return fail(new Error('refused'));
          names.add(name);
          if (total + entry.uncompressedSize > 20 * 1024 * 1024)
            return fail(new Error('too_large'));
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) return fail(err);
            const chunks: Buffer[] = [];
            stream.on('data', (chunk) => {
              total += chunk.length;
              if (total > 20 * 1024 * 1024) {
                stream.destroy();
                return fail(new Error('too_large'));
              }
              if (name === '[content_types].xml') chunks.push(chunk);
            });
            stream.on('error', fail);
            stream.on('end', () => {
              if (
                /macroenabled|vbaproject|macrosheet/i.test(
                  Buffer.concat(chunks).toString(),
                )
              )
                return fail(new Error('refused'));
              zip.readEntry();
            });
          });
        });
        zip.on('end', () => {
          if (
            !names.has('[content_types].xml') ||
            !names.has(
              kind === 'docx' ? 'word/document.xml' : 'xl/workbook.xml',
            )
          )
            reject(new Error('invalid'));
          else resolve();
        });
        zip.readEntry();
      },
    );
  });
}
async function main() {
  let text = '';
  let truncated = false;
  const add = (s: string) => {
    const left = maxChars - text.length;
    if (s.length > left) truncated = true;
    text += s.slice(0, left);
  };
  if (kind === 'docx' || kind === 'xlsx') await checkOffice();
  else if (kind === 'pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new Error('refused');
  } else if (['txt', 'csv'].includes(kind)) {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/\x00|<\s*(?:!doctype\s+html|html|script|svg)\b/i.test(decoded))
      throw new Error('refused');
    add(decoded);
  } else {
    const valid =
      kind === 'png'
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : ['jpg', 'jpeg'].includes(kind)
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : kind === 'gif'
            ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
            : kind === 'webp' &&
              bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) throw new Error('refused');
    if (mode === 'text')
      return {
        status: 'not_extractable',
        message:
          'Image OCR is not supported. Request base64 for an image within the 1 MiB limit.',
      };
  }
  if (mode === 'base64') return { status: 'ok' };
  if (kind === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
    });
    const document = await task.promise;
    try {
      for (let n = 1; n <= Math.min(document.numPages, 200); n++) {
        const content = await (await document.getPage(n)).getTextContent();
        for (const item of content.items)
          if ('str' in item) add(item.str + (item.hasEOL ? '\n' : ' '));
        add('\n');
        if (text.length >= maxChars) {
          truncated = true;
          break;
        }
      }
      if (document.numPages > 200) truncated = true;
    } finally {
      await task.destroy();
    }
  } else if (kind === 'docx')
    add((await mammoth.extractRawText({ buffer: bytes })).value);
  else if (kind === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as any);
    for (const sheet of workbook.worksheets) {
      add(`Sheet: ${sheet.name}\n`);
      sheet.eachRow((row) => {
        if (text.length >= maxChars) {
          truncated = true;
          return;
        }
        const values: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          values.push(cell.text);
        });
        add(values.join('\t') + '\n');
      });
    }
  }
  return text.trim()
    ? { status: 'ok', text, truncated }
    : {
        status: 'not_extractable',
        message:
          'No extractable text. Scanned PDFs require OCR; encrypted documents are not supported.',
      };
}
main()
  .then((result) => parentPort!.postMessage(result))
  .catch((error) =>
    parentPort!.postMessage({
      status: ['refused', 'too_large'].includes(error?.message)
        ? error.message
        : 'not_extractable',
      message:
        'Unsupported, unsafe, malformed, encrypted or oversized document; no content was returned.',
    }),
  );
