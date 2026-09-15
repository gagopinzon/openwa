const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const panelMsgClient = require('../panelMsgClient');

describe('panelMsgClient', () => {
  const prevEnv = {};
  let originalPost;
  let originalGet;
  let originalPatch;

  beforeEach(() => {
    for (const key of [
      'MSG_INTEGRATION_API_KEY',
      'MSG_GERENTE_EMAIL',
      'PANEL_BASE_URL',
      'PANEL_DISPONIBILIDAD_CACHE_MS'
    ]) {
      prevEnv[key] = process.env[key];
    }
    process.env.MSG_INTEGRATION_API_KEY = 'test-key';
    process.env.MSG_GERENTE_EMAIL = 'gerente@test.com';
    process.env.PANEL_BASE_URL = 'https://panel.test';
    originalPost = axios.post;
    originalGet = axios.get;
    originalPatch = axios.patch;
    if (typeof panelMsgClient.clearDisponibilidadCache === 'function') {
      panelMsgClient.clearDisponibilidadCache();
    }
  });

  afterEach(() => {
    axios.post = originalPost;
    axios.get = originalGet;
    axios.patch = originalPatch;
    for (const key of Object.keys(prevEnv)) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
    if (typeof panelMsgClient.clearDisponibilidadCache === 'function') {
      panelMsgClient.clearDisponibilidadCache();
    }
  });

  it('POST reuniones con cvFile usa multipart sin Content-Type json', async () => {
    let captured = null;
    axios.post = async (url, data, config) => {
      captured = { url, data, config };
      return { status: 201, data: { reunion: { id: 'r1' } } };
    };

    await panelMsgClient.crearReunion({
      vendedorId: 'v1',
      fecha: '2026-09-14',
      horaInicio: '10:00',
      horaFin: '10:30',
      cvFile: Buffer.from('%PDF-1.4'),
      cvFileName: 'gago.pdf',
      cvMime: 'application/pdf',
      analisisCV: { contacto: { email: 'a@b.com' } },
      cvAnalizadoEnMsg: true,
      leadCorreo: 'a@b.com',
      origen: 'msg_auto_agenda'
    });

    assert.match(captured.url, /\/api\/external\/msg\/reuniones$/);
    assert.ok(captured.data instanceof FormData);
    assert.notEqual(captured.config.headers['Content-Type'], 'application/json');
    assert.equal(captured.config.headers['X-API-Key'], 'test-key');
    assert.equal(captured.data.get('vendedorId'), 'v1');
    assert.equal(captured.data.get('fecha'), '2026-09-14');
    assert.equal(captured.data.get('cvAnalizadoEnMsg'), 'true');
    assert.equal(captured.data.get('leadCorreo'), 'a@b.com');
    assert.match(String(captured.data.get('analisisCV')), /a@b.com/);
    assert.ok(captured.data.get('cvFile'));
    assert.equal(captured.data.get('cvUrl'), null);
    assert.ok(captured.config.maxBodyLength >= 10 * 1024 * 1024);
  });

  it('POST reuniones con cvUrl usa JSON y no manda cvBase64', async () => {
    let captured = null;
    axios.post = async (url, data, config) => {
      captured = { url, data, config };
      return { status: 201, data: { reunion: { id: 'r1' } } };
    };

    await panelMsgClient.crearReunion({
      vendedorId: 'v1',
      fecha: '2026-09-14',
      horaInicio: '10:00',
      horaFin: '10:30',
      cvUrl: 'https://msg.example/cv/1'
    });

    assert.equal(captured.config.headers['Content-Type'], 'application/json');
    assert.equal(captured.data.cvUrl, 'https://msg.example/cv/1');
    assert.equal(captured.data.cvBase64, undefined);
    assert.equal(captured.data.cvFile, undefined);
  });

  it('POST sin cvFile ni cvUrl falla 400 aunque venga cvBase64', async () => {
    await assert.rejects(
      () =>
        panelMsgClient.crearReunion({
          vendedorId: 'v1',
          fecha: '2026-09-14',
          horaInicio: '10:00',
          horaFin: '10:30',
          cvBase64: 'AAAA'
        }),
      (err) => err.status === 400 && /cvFile|cvUrl/i.test(err.message)
    );
  });

  it('PATCH omite vendedorId si no viene', async () => {
    let captured = null;
    axios.patch = async (url, data) => {
      captured = { url, data };
      return { status: 200, data: { message: 'ok' } };
    };

    await panelMsgClient.actualizarReunion({
      reunionId: 'abc123',
      fecha: '2026-09-15',
      horaInicio: '11:00',
      horaFin: '11:30'
    });

    assert.match(captured.url, /\/reuniones\/abc123$/);
    assert.equal(captured.data.fecha, '2026-09-15');
    assert.equal(captured.data.horaInicio, '11:00');
    assert.equal(captured.data.horaFin, '11:30');
    assert.equal(captured.data.vendedorId, undefined);
  });

  it('GET disponibilidad cachea 90s y skipCache no lee ni escribe', async () => {
    let gets = 0;
    axios.get = async () => {
      gets += 1;
      return { status: 200, data: { vendedores: [{ id: String(gets) }] } };
    };

    const first = await panelMsgClient.getDisponibilidad({
      fechaInicio: '2026-09-14',
      fechaFin: '2026-09-20'
    });
    const second = await panelMsgClient.getDisponibilidad({
      fechaInicio: '2026-09-14',
      fechaFin: '2026-09-20'
    });
    assert.equal(gets, 1);
    assert.equal(first.vendedores[0].id, '1');
    assert.equal(second.vendedores[0].id, '1');

    const skipped = await panelMsgClient.getDisponibilidad({
      fechaInicio: '2026-09-14',
      fechaFin: '2026-09-20',
      skipCache: true
    });
    assert.equal(gets, 2);
    assert.equal(skipped.vendedores[0].id, '2');

    const afterSkip = await panelMsgClient.getDisponibilidad({
      fechaInicio: '2026-09-14',
      fechaFin: '2026-09-20'
    });
    assert.equal(gets, 2);
    assert.equal(afterSkip.vendedores[0].id, '1');
  });
});
