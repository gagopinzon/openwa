const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Aislado: sin Mongo real (dotenv no sobrescribe variables ya definidas) ni HTTP a OpenWA.
process.env.MONGODB_URI = '';
// OpenWA falso: este test no debe hacer HTTP real.
const realClient = require('../openwaClient');
require.cache[require.resolve('../openwaClient')].exports = {
  ...realClient,
  getSessionStatus: async () => ({ connected: true, status: 'CONNECTED' }),
  sendTextMessage: async () => ({ messageId: 'fake' })
};
const { sendRoundRobinBulk } = require('../openwaWhatsAppService');

function fakeService(sessionId, log) {
  return {
    openwaSessionId: `owa_${sessionId}`,
    isReady: () => true,
    sendContactWithGreeting: async (contact) => {
      log.push({ sessionId, telefono: contact.telefono, at: Date.now() });
      return true;
    }
  };
}

const contact = (n) => ({ nombre: `C${n}`, telefono: `5281555500${String(n).padStart(2, '0')}`, mensajeIA: `Hola ${n}`, saludo: 'Hola' });

describe('envío en streaming (lote que crece mientras se envía)', () => {
  it('manda lo que llega después, respeta el intervalo por línea y cierra al terminar', async () => {
    const log = [];
    const services = new Map([
      ['s1', fakeService('s1', log)],
      ['s2', fakeService('s2', log)]
    ]);
    let open = true;
    let enqueue = null;
    const results = [];

    const done = sendRoundRobinBulk(
      services,
      ['s1', 's2'],
      [],
      null,
      null,
      (row) => results.push(row),
      null,
      null,
      { minSeconds: 1, maxSeconds: 1 },
      { isOpen: () => open, register: (fn) => (enqueue = fn) }
    );

    assert.equal(typeof enqueue, 'function', 'el lote debe exponer cómo agregar contactos');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(enqueue(contact(1), 's1').ok, true);
    assert.equal(enqueue(contact(2), 's2').ok, true);
    await new Promise((r) => setTimeout(r, 300));
    // Llega a s1 justo después de su envío anterior: debe esperar el intervalo de la línea.
    assert.equal(enqueue(contact(3), 's1').ok, true);
    await new Promise((r) => setTimeout(r, 2600));
    open = false;

    const t0 = Date.now();
    await done;
    assert.ok(Date.now() - t0 < 4000, 'al cerrar el lote, las líneas terminan sin quedarse colgadas');

    const phones = log.map((l) => l.telefono).sort();
    assert.deepEqual(phones, [contact(1), contact(2), contact(3)].map((c) => c.telefono).sort());
    assert.equal(results.filter((r) => r.success).length, 3);

    const s1 = log.filter((l) => l.sessionId === 's1');
    assert.equal(s1.length, 2);
    assert.ok(s1[1].at - s1[0].at >= 950, `intervalo en s1 = ${s1[1].at - s1[0].at} ms (debe respetar ≥1 s)`);
    assert.equal(log.filter((l) => l.sessionId === 's2').length, 1);
  });

  it('sin streaming se comporta como antes (lista fija)', async () => {
    const log = [];
    const services = new Map([['s1', fakeService('s1', log)]]);
    const results = [];
    await sendRoundRobinBulk(services, ['s1'], [contact(1), contact(2)], null, null, (r) => results.push(r), null, null, { minSeconds: 1, maxSeconds: 1 });
    assert.equal(log.length, 2);
    assert.equal(results.length, 2);
  });

  it('con 2 líneas, el lote cierra cuando ambas se quedan sin contactos (antes se esperaban para siempre)', async () => {
    const log = [];
    const services = new Map([
      ['s1', fakeService('s1', log)],
      ['s2', fakeService('s2', log)]
    ]);
    const counts = { s1: 2, s2: 0 }; // s2 sin contactos: queda ociosa desde el inicio
    const finished = sendRoundRobinBulk(services, ['s1', 's2'], [contact(1), contact(2)], null, null, null, null, counts, { minSeconds: 1, maxSeconds: 1 });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('el lote no cerró (bloqueo entre líneas)')), 8000));
    await Promise.race([finished, timeout]);
    assert.equal(log.length, 2);
  });
});
