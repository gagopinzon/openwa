const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cvFileStore = require('../cvFileStore');
const { resolvePanelCvDelivery } = require('../panelCvDelivery');

describe('panelCvDelivery', () => {
  const prevEnv = {};
  let savedCvId = null;

  beforeEach(() => {
    for (const key of ['CV_PUBLIC_URL', 'WEBHOOK_PUBLIC_URL', 'AUTH_SESSION_SECRET', 'PANEL_CV_MAX_BASE64_CHARS']) {
      prevEnv[key] = process.env[key];
    }
    process.env.AUTH_SESSION_SECRET = 'panel-cv-delivery-test';
    delete process.env.CV_PUBLIC_URL;
    delete process.env.WEBHOOK_PUBLIC_URL;
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

  it('prefiere cvBase64 cuando el archivo está en disco', async () => {
    const delivery = await resolvePanelCvDelivery(savedCvId);
    assert.equal(delivery.delivery, 'base64');
    assert.ok(delivery.cvBase64);
    assert.match(delivery.cvFileName, /\.pdf$/i);
    assert.equal(delivery.cvUrl, undefined);
    assert.match(Buffer.from(delivery.cvBase64, 'base64').toString('ascii'), /^%PDF/);
  });

  it('si hay URL pública alcanzable, prefiere cvUrl aunque el PDF esté en disco', async () => {
    process.env.CV_PUBLIC_URL = 'https://msg.protalentconnections.com';
    const delivery = await resolvePanelCvDelivery(savedCvId, {
      probeCvUrl: async () => ({ ok: true, status: 200 })
    });
    assert.equal(delivery.delivery, 'url');
    assert.match(delivery.cvUrl, /^https:\/\/msg\.protalentconnections\.com\/api\/public\/cv\//);
    assert.equal(delivery.cvBase64, undefined);
  });

  it('si el PDF en base64 supera el límite y no hay URL, falla con 413', async () => {
    process.env.PANEL_CV_MAX_BASE64_CHARS = '10';
    await assert.rejects(
      () => resolvePanelCvDelivery(savedCvId, { skipOccFetch: true }),
      (err) => err.status === 413 && /demasiado grande/i.test(err.message)
    );
  });

  it('usa cvUrl solo si no se puede leer el archivo local', async () => {
    const originalRead = cvFileStore.readCvFileBuffer;
    cvFileStore.readCvFileBuffer = () => null;
    process.env.CV_PUBLIC_URL = 'https://msg.protalentconnections.com';

    try {
      const delivery = await resolvePanelCvDelivery(savedCvId, {
        probeCvUrl: async () => ({ ok: true, status: 200 })
      });

      assert.equal(delivery.delivery, 'url');
      assert.match(delivery.cvUrl, /^https:\/\/msg\.protalentconnections\.com\/api\/public\/cv\//);
      assert.equal(delivery.cvBase64, undefined);
    } finally {
      cvFileStore.readCvFileBuffer = originalRead;
    }
  });

  it('falla si no hay base64 y la URL pública no es alcanzable', async () => {
    const originalRead = cvFileStore.readCvFileBuffer;
    cvFileStore.readCvFileBuffer = () => null;
    process.env.WEBHOOK_PUBLIC_URL = 'http://172.17.0.1:3445';

    try {
      await assert.rejects(
        () => resolvePanelCvDelivery(savedCvId),
        (err) => err.status === 503 && /172\.17\.0\.1/.test(err.message)
      );
    } finally {
      cvFileStore.readCvFileBuffer = originalRead;
    }
  });
});
