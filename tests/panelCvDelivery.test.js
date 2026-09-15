const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cvFileStore = require('../cvFileStore');
const {
  resolvePanelCvDelivery,
  cvFieldsFromDelivery
} = require('../panelCvDelivery');

describe('panelCvDelivery', () => {
  const prevEnv = {};
  let savedCvId = null;

  beforeEach(() => {
    for (const key of [
      'CV_PUBLIC_URL',
      'WEBHOOK_PUBLIC_URL',
      'AUTH_SESSION_SECRET',
      'PANEL_CV_MAX_FILE_BYTES',
      'PANEL_CV_MAX_BASE64_CHARS'
    ]) {
      prevEnv[key] = process.env[key];
    }
    process.env.AUTH_SESSION_SECRET = 'panel-cv-delivery-test';
    delete process.env.CV_PUBLIC_URL;
    delete process.env.WEBHOOK_PUBLIC_URL;
    delete process.env.PANEL_CV_MAX_FILE_BYTES;
    delete process.env.PANEL_CV_MAX_BASE64_CHARS;

    const saved = cvFileStore.saveCvFile(Buffer.from('%PDF-1.4 test'), 'gago-cv.pdf');
    savedCvId = saved.cvId;
  });

  afterEach(() => {
    if (savedCvId) {
      try {
        cvFileStore.deleteCvFile(savedCvId);
      } catch {
        /* ignore */
      }
      savedCvId = null;
    }
    for (const key of Object.keys(prevEnv)) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  it('usa cvFile cuando el PDF local cabe en 10 MB, aunque haya CV_PUBLIC_URL', async () => {
    process.env.CV_PUBLIC_URL = 'https://msg.protalentconnections.com';
    const delivery = await resolvePanelCvDelivery(savedCvId, {
      skipOccFetch: true,
      probeCvUrl: async () => ({ ok: true, status: 200 })
    });
    assert.equal(delivery.delivery, 'file');
    assert.ok(Buffer.isBuffer(delivery.buffer));
    assert.match(delivery.buffer.toString('ascii'), /^%PDF/);
    assert.match(delivery.cvFileName, /\.pdf$/i);
    assert.equal(delivery.mime, 'application/pdf');
    assert.equal(delivery.cvBase64, undefined);
    assert.equal(delivery.cvUrl, undefined);
  });

  it('si el PDF supera el tope y hay URL pública, usa cvUrl', async () => {
    process.env.PANEL_CV_MAX_FILE_BYTES = '10';
    process.env.CV_PUBLIC_URL = 'https://msg.protalentconnections.com';
    const delivery = await resolvePanelCvDelivery(savedCvId, {
      skipOccFetch: true,
      probeCvUrl: async () => ({ ok: true, status: 200 })
    });
    assert.equal(delivery.delivery, 'url');
    assert.match(delivery.cvUrl, /^https:\/\/msg\.protalentconnections\.com\/api\/public\/cv\//);
    assert.equal(delivery.buffer, undefined);
    assert.equal(delivery.cvBase64, undefined);
  });

  it('si el PDF supera el tope y no hay URL pública, falla con 413', async () => {
    process.env.PANEL_CV_MAX_FILE_BYTES = '10';
    await assert.rejects(
      () => resolvePanelCvDelivery(savedCvId, { skipOccFetch: true }),
      (err) => err.status === 413 && /10 MB|demasiado grande|cvFile/i.test(err.message)
    );
  });

  it('si no hay archivo, falla con 404 y no inventa cvUrl', async () => {
    process.env.CV_PUBLIC_URL = 'https://msg.protalentconnections.com';
    await assert.rejects(
      () => resolvePanelCvDelivery('missing-cv-id', { skipOccFetch: true }),
      (err) => err.status === 404 && /no está disponible/i.test(err.message)
    );
  });

  it('si el buffer no se puede leer, 404 aunque exista URL pública', async () => {
    const originalRead = cvFileStore.readCvFileBuffer;
    cvFileStore.readCvFileBuffer = () => null;
    process.env.CV_PUBLIC_URL = 'https://msg.protalentconnections.com';
    try {
      await assert.rejects(
        () => resolvePanelCvDelivery(savedCvId, { skipOccFetch: true }),
        (err) => err.status === 404
      );
    } finally {
      cvFileStore.readCvFileBuffer = originalRead;
    }
  });

  it('cvFieldsFromDelivery arma cvFile o cvUrl según delivery', () => {
    const fileFields = cvFieldsFromDelivery({
      delivery: 'file',
      buffer: Buffer.from('pdf'),
      cvFileName: 'a.pdf',
      mime: 'application/pdf'
    });
    assert.equal(fileFields.cvFileName, 'a.pdf');
    assert.equal(fileFields.cvMime, 'application/pdf');
    assert.ok(Buffer.isBuffer(fileFields.cvFile));
    assert.equal(fileFields.cvUrl, undefined);

    const urlFields = cvFieldsFromDelivery({
      delivery: 'url',
      cvUrl: 'https://msg.example/cv/1'
    });
    assert.equal(urlFields.cvUrl, 'https://msg.example/cv/1');
    assert.equal(urlFields.cvFile, undefined);
  });
});
