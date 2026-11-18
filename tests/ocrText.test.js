const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessTextQuality, collapseLetterSpacing } = require('../pdfProcessor');
const { fixOcrEmails, pickHeaderOnlyLines } = require('../ocrService');

describe('assessTextQuality', () => {
  it('acepta texto normal de CV', () => {
    const q = assessTextQuality('Juan Pérez\nGerente de Ventas en ACME\nMonterrey, Nuevo León');
    assert.equal(q.ok, true);
  });
  it('rechaza streams binarios del PDF', () => {
    const garbage = 'TÐ\u000fH-JN-( Ê\u0004\n\u0018Yë\u001bX*\u0018\u0000¡±¡¹©!« ïk¨à\u000fÔ\u001c\b\u0000T½\u0010\nendstream\nendobj\n1 0 obj\n<< /Type /Page /Parent 2 0 R /Resources 4 0 R /Contents 3 0 R /MediaBox';
    assert.equal(assessTextQuality(garbage).ok, false);
  });
  it('rechaza escapes octales de strings PDF', () => {
    const raw = 'https\\072\\057\\057readymag\\056website\\057u2990843653\\0575511971\\057 https\\072\\057\\057x';
    assert.equal(assessTextQuality(raw).ok, false);
  });
});

describe('collapseLetterSpacing', () => {
  it('une letras separadas', () => {
    assert.equal(collapseLetterSpacing('E X P E R I E N C I A L A B O R A L 1 / 2'), 'EXPERIENCIALABORAL 1 / 2');
  });
  it('no toca texto normal', () => {
    assert.equal(collapseLetterSpacing('Y a la vez O no'), 'Y a la vez O no');
  });
});

describe('fixOcrEmails', () => {
  it('corrige "(O" leído en lugar de @', () => {
    assert.equal(fixOcrEmails('cgalvez_m(Ohotmail.com'), 'cgalvez_m@hotmail.com');
  });
  it('corrige @ sustituida por "e"', () => {
    assert.equal(fixOcrEmails('mariana.gonza.gomegmail.com'), 'mariana.gonza.gom@gmail.com');
  });
  it('deja intactos correos correctos', () => {
    assert.equal(fixOcrEmails('Correo: ana@gmail.com'), 'Correo: ana@gmail.com');
  });
});

describe('pickHeaderOnlyLines', () => {
  it('conserva el nombre gigante que el paso principal no vio y descarta ruido', () => {
    const header = '| CARLOS GALVEZ\n| PERFIL PROFESIONAL\nmedios, relaciones públicas y desrrolo comercial en México Latinoamérica';
    const main = 'DIRECTOR DE ESTRATEGIA\nPERFIL PROFESIONAL\nmedios, relaciones públicas y desarrollo comercial en México, Latinoamérica';
    assert.equal(pickHeaderOnlyLines(header, main), 'CARLOS GALVEZ');
  });
});

describe('cleanOcrText', () => {
  const { cleanOcrText } = require('../ocrService');
  it('quita íconos de contacto leídos como basura y respeta paréntesis reales', () => {
    const out = cleanOcrText('[m=) cgalvez_m(Ohotmail.com\n[in) linkedin.com/in/x\n(Y Celular: 5516608509\n(Febrero 2017 - Marzo 2020)');
    assert.equal(out, 'cgalvez_m@hotmail.com\nlinkedin.com/in/x\nCelular: 5516608509\n(Febrero 2017 - Marzo 2020)');
  });
});

describe('buildPanelAnalisisCv puesto', () => {
  const { buildPanelAnalisisCv } = require('../cvAnalysisService');
  it('siempre manda 4 puestos al panel', () => {
    const a = buildPanelAnalisisCv({ panelAnalisis: { puesto: ['Gerente de Ventas'] } });
    assert.deepEqual(a.puesto, ['Gerente de Ventas', 'Profesional', 'Especialista', 'Consultor']);
  });
});
