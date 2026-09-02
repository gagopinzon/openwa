const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractTextFromPDF, verifyPdfReadable } = require('../pdfProcessor');

/**
 * PDF mínimo con texto en un stream sin comprimir y xref clásico.
 * Devuelve un Buffer pooled (byteOffset !== 0) como multer/fs en archivos chicos.
 */
function buildSimplePdf(plainText) {
  const escaped = String(plainText)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const parts = [];
  const add = (s) => parts.push(Buffer.from(s, 'latin1'));
  add('%PDF-1.4\n');
  const offsets = [0];
  const addObj = (s) => {
    offsets.push(Buffer.concat(parts).length);
    add(s);
  };
  addObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  addObj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  addObj(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  );
  addObj(
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`
  );
  addObj('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  const body = Buffer.concat(parts);
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
  return Buffer.concat([body, Buffer.from(xref + trailer, 'latin1')]);
}

function corruptXrefOffsets(pdfBuffer) {
  const raw = pdfBuffer.toString('latin1');
  const corrupted = raw.replace(/00000 n /g, '99999 n ');
  assert.notEqual(corrupted, raw, 'el fixture debe alterar entradas xref');
  return Buffer.from(corrupted, 'latin1');
}

describe('pdfProcessor', () => {
  it('extrae texto de un PDF simple aunque el Buffer esté pooled (byteOffset !== 0)', async () => {
    const pdf = buildSimplePdf('Victor Hugo Castaneda Glez');
    assert.ok(pdf.byteOffset !== 0 || pdf.buffer.byteLength !== pdf.length);
    const text = await extractTextFromPDF(pdf);
    assert.match(text, /Victor Hugo Castaneda Glez/);
  });

  it('extrae texto aunque el buffer tenga basura antes de %PDF-', async () => {
    const pdf = buildSimplePdf('Santiago Alvarez');
    const padded = Buffer.concat([Buffer.from('HTTP-GARBAGE\r\n', 'utf8'), pdf]);
    const text = await extractTextFromPDF(padded);
    assert.match(text, /Santiago Alvarez/);
  });

  it('extrae texto de un PDF con tabla XRef inválida (bad XRef entry)', async () => {
    const pdf = corruptXrefOffsets(buildSimplePdf('Ulises Chacon Protalent'));
    const text = await extractTextFromPDF(pdf, { silent: true });
    assert.match(text, /Ulises Chacon Protalent/);
  });

  it('verifyPdfReadable acepta PDFs con XRef dañada si el contenido es recuperable', async () => {
    const pdf = corruptXrefOffsets(buildSimplePdf('Nombre Recuperable'));
    assert.equal(await verifyPdfReadable(pdf), true);
  });
});
