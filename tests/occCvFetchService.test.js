const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractOccCvUrl,
  enrichBufferFromOccIfNeeded,
  ensureOccCvFetched
} = require('../occCvFetchService');
const cvFileStore = require('../cvFileStore');

const SAMPLE_URL =
  'https://www.occ.com.mx/empresas/candidatos/cv/22098464?o=4&utm_source=pd';

test('extractOccCvUrl encuentra liga con query', () => {
  const text =
    'Experiencia profesional\nFoo\n\nLiga de currículo\n' + SAMPLE_URL + '\n';
  assert.equal(extractOccCvUrl(text), SAMPLE_URL);
});

test('extractOccCvUrl sin www', () => {
  const text = 'https://occ.com.mx/empresas/candidatos/cv/99';
  assert.equal(extractOccCvUrl(text), text);
});

test('extractOccCvUrl recorta puntuación final', () => {
  const text = SAMPLE_URL + '.';
  assert.equal(extractOccCvUrl(text), SAMPLE_URL);
});

test('extractOccCvUrl retorna null sin liga', () => {
  assert.equal(extractOccCvUrl('CV sin liga OCC'), null);
  assert.equal(extractOccCvUrl(''), null);
  assert.equal(extractOccCvUrl(null), null);
});

test('enrichBufferFromOccIfNeeded skip sin URL', async () => {
  const original = Buffer.from('%PDF-1.4 stub');
  const result = await enrichBufferFromOccIfNeeded(original, 'sin liga', {
    credentialsOk: true,
    downloadFn: async () => {
      throw new Error('no debe llamarse');
    }
  });
  assert.equal(result.skipped, true);
  assert.equal(result.occFetched, false);
  assert.equal(result.buffer, original);
});

test('enrichBufferFromOccIfNeeded sin credenciales marca fallo', async () => {
  const original = Buffer.from('%PDF-1.4 stub');
  const result = await enrichBufferFromOccIfNeeded(
    original,
    `Liga\n${SAMPLE_URL}`,
    { credentialsOk: false }
  );
  assert.equal(result.occUrl, SAMPLE_URL);
  assert.equal(result.occFetched, false);
  assert.equal(result.occFetchFailed, true);
  assert.equal(result.occFetchError, 'occ_no_credentials');
  assert.equal(result.buffer, original);
});

test('enrichBufferFromOccIfNeeded reemplaza con PDF descargado', async () => {
  const original = Buffer.from('%PDF-1.4 original');
  const downloaded = Buffer.from('%PDF-1.4 from-occ-xxxxxxxx');
  const result = await enrichBufferFromOccIfNeeded(
    original,
    `Liga de currículo\n${SAMPLE_URL}`,
    {
      credentialsOk: true,
      downloadFn: async (url) => {
        assert.equal(url, SAMPLE_URL);
        return downloaded;
      }
    }
  );
  assert.equal(result.occFetched, true);
  assert.equal(result.occUrl, SAMPLE_URL);
  assert.equal(result.buffer, downloaded);
  assert.equal(result.occFetchFailed, undefined);
});

test('enrichBufferFromOccIfNeeded fallback si download falla', async () => {
  const original = Buffer.from('%PDF-1.4 original');
  const result = await enrichBufferFromOccIfNeeded(original, SAMPLE_URL, {
    credentialsOk: true,
    downloadFn: async () => {
      const err = new Error('timeout');
      err.code = 'occ_timeout';
      throw err;
    }
  });
  assert.equal(result.occFetched, false);
  assert.equal(result.occFetchFailed, true);
  assert.match(result.occFetchError, /occ_timeout/);
  assert.equal(result.buffer, original);
});

test('ensureOccCvFetched reemplaza PDF en disco al agendar', async () => {
  const original = Buffer.from('%PDF-1.4 stub-original');
  const downloaded = Buffer.from('%PDF-1.4 from-occ-full-cv');
  const saved = cvFileStore.saveCvFile(original, 'occ-stub.pdf');
  const list = cvFileStore.loadCvsManifest() || [];
  cvFileStore.saveCvsManifest([
    ...list.filter((c) => c.cvId !== saved.cvId),
    {
      nombre: 'Test',
      telefono: '5512345678',
      archivoOriginal: 'occ-stub.pdf',
      cvId: saved.cvId,
      cvFileName: saved.cvFileName,
      procesado: true,
      inWorkspace: true,
      savedAt: new Date().toISOString()
    }
  ]);

  try {
    const result = await ensureOccCvFetched(saved.cvId, {
      credentialsOk: true,
      extractTextFn: async () => `Liga\n${SAMPLE_URL}`,
      downloadFn: async () => downloaded
    });
    assert.equal(result.occFetched, true);
    assert.equal(result.replaced, true);
    const onDisk = cvFileStore.readCvFileBuffer(saved.cvId);
    assert.ok(onDisk.equals(downloaded));
    const entry = (cvFileStore.loadCvsManifest() || []).find(
      (c) => c.cvId === saved.cvId
    );
    assert.equal(entry.occFetched, true);
    assert.equal(entry.occUrl, SAMPLE_URL);

    const again = await ensureOccCvFetched(saved.cvId, {
      credentialsOk: true,
      extractTextFn: async () => {
        throw new Error('no debe re-leer');
      },
      downloadFn: async () => {
        throw new Error('no debe re-descargar');
      }
    });
    assert.equal(again.skipped, true);
    assert.equal(again.reason, 'already_fetched');
  } finally {
    cvFileStore.deleteCvFile(saved.cvId);
    const remaining = (cvFileStore.loadCvsManifest() || []).filter(
      (c) => c.cvId !== saved.cvId
    );
    cvFileStore.saveCvsManifest(remaining);
  }
});
