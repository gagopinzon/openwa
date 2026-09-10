const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CENTRO_TZ,
  detectTimezoneMention,
  localHhmmToCentro,
  resolveLeadTimeRequest,
  formatDualTimePhrase
} = require('../agendaTimezone');
const {
  agendaPreferredHhmm,
  formatConfirmReply,
  resolvePreferredTimeOffer
} = require('../agendaPreferredTime');
const { matchSlotFromMessage } = require('../agendaIntent');

function slot(fecha, horaInicio) {
  const [h, m] = horaInicio.split(':').map(Number);
  const tot = h * 60 + m + 15;
  const horaFin = `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
  return { fecha, horaInicio, horaFin };
}

describe('agendaTimezone', () => {
  it('detecta Hermosillo / Sonora como America/Hermosillo', () => {
    const a = detectTimezoneMention('quiero una cita a las 12 de hermosillo');
    assert.equal(a.timeZone, 'America/Hermosillo');
    assert.match(a.label, /hermosillo/i);

    const b = detectTimezoneMention('a las 12 hora de Sonora');
    assert.equal(b.timeZone, 'America/Hermosillo');
  });

  it('detecta Cancún / Quintana Roo', () => {
    const a = detectTimezoneMention('agéndame a las 12 de cancun');
    assert.equal(a.timeZone, 'America/Cancun');
    const b = detectTimezoneMention('12 horas de Quintana Roo');
    assert.equal(b.timeZone, 'America/Cancun');
  });

  it('Monterrey / Guadalajara / CDMX son hora centro', () => {
    assert.equal(detectTimezoneMention('a las 12 de monterrey').timeZone, CENTRO_TZ);
    assert.equal(detectTimezoneMention('12 horas de guadalajara').timeZone, CENTRO_TZ);
    assert.equal(detectTimezoneMention('hora cdmx').timeZone, CENTRO_TZ);
  });

  it('no confunde "de la tarde" con ciudad', () => {
    assert.equal(detectTimezoneMention('a las 5 de la tarde'), null);
  });

  it('convierte 12:00 Hermosillo → 13:00 centro', () => {
    const r = localHhmmToCentro('12:00', 'America/Hermosillo', '2026-09-10');
    assert.equal(r.centroHhmm, '13:00');
    assert.equal(r.localHhmm, '12:00');
    assert.equal(r.differs, true);
  });

  it('convierte 12:00 Cancún → 11:00 centro', () => {
    const r = localHhmmToCentro('12:00', 'America/Cancun', '2026-09-10');
    assert.equal(r.centroHhmm, '11:00');
    assert.equal(r.differs, true);
  });

  it('Monterrey 12:00 queda 12:00 centro', () => {
    const r = localHhmmToCentro('12:00', CENTRO_TZ, '2026-09-10');
    assert.equal(r.centroHhmm, '12:00');
    assert.equal(r.differs, false);
  });

  it('resolveLeadTimeRequest arma pedido local + hora centro', () => {
    const r = resolveLeadTimeRequest('quiero una cita a las 12 de hermosillo', {
      ymd: '2026-09-10'
    });
    assert.equal(r.localHhmm, '12:00');
    assert.equal(r.centroHhmm, '13:00');
    assert.equal(r.timeZone, 'America/Hermosillo');
    assert.equal(r.differs, true);
  });

  it('sin ciudad asume centro', () => {
    const r = resolveLeadTimeRequest('quiero a las 12', { ymd: '2026-09-10' });
    assert.equal(r.localHhmm, '12:00');
    assert.equal(r.centroHhmm, '12:00');
    assert.equal(r.timeZone, CENTRO_TZ);
    assert.equal(r.differs, false);
    assert.equal(r.assumedCentro, true);
  });

  it('formatDualTimePhrase con desfase menciona ambas', () => {
    const phrase = formatDualTimePhrase({
      localHhmm: '12:00',
      centroHhmm: '13:00',
      label: 'Hermosillo',
      differs: true
    });
    assert.match(phrase, /12:00/);
    assert.match(phrase, /13:00/);
    assert.match(phrase, /hermosillo/i);
    assert.match(phrase, /centro/i);
  });

  it('formatDualTimePhrase sin desfase solo dice hora del centro', () => {
    const phrase = formatDualTimePhrase({
      localHhmm: '12:00',
      centroHhmm: '12:00',
      differs: false,
      assumedCentro: true
    });
    assert.match(phrase, /12:00/);
    assert.match(phrase, /centro/i);
    assert.doesNotMatch(phrase, /tuyas|tus /i);
  });
});

describe('agendaPreferredTime + timezone', () => {
  const today = '2026-09-10';
  const tomorrow = '2026-09-11';

  it('agendaPreferredHhmm convierte Hermosillo 12 → 13 centro', () => {
    assert.equal(
      agendaPreferredHhmm('quiero una cita a las 12 de hermosillo', { ymd: today }),
      '13:00'
    );
  });

  it('confirma slot en hora centro cuando el lead habla en Hermosillo', () => {
    const slots = [slot(today, '13:00'), slot(today, '14:00')];
    const decision = resolvePreferredTimeOffer(
      'quiero una cita a las 12 de hermosillo',
      slots,
      { today, tomorrow }
    );
    assert.equal(decision.action, 'confirm');
    assert.equal(decision.slot.horaInicio, '13:00');
    assert.equal(decision.preferredTime, '13:00');
    assert.equal(decision.timezone.differs, true);
    assert.equal(decision.timezone.localHhmm, '12:00');
  });

  it('formatConfirmReply dual cuando hay desfase', () => {
    const text = formatConfirmReply(slot(today, '13:00'), today, {
      localHhmm: '12:00',
      centroHhmm: '13:00',
      label: 'Hermosillo',
      differs: true
    });
    assert.match(text, /12:00/);
    assert.match(text, /13:00/);
    assert.match(text, /hermosillo/i);
    assert.match(text, /centro/i);
  });

  it('formatConfirmReply sin desfase especifica hora del centro', () => {
    const text = formatConfirmReply(slot(today, '12:00'), today);
    assert.match(text, /12:00/);
    assert.match(text, /hora del centro/i);
  });

  it('matchSlotFromMessage convierte ciudad del lead a hora centro', () => {
    const slots = [slot(today, '13:00'), slot(today, '12:00')];
    const hit = matchSlotFromMessage('a las 12 de hermosillo', slots, {
      now: new Date('2026-09-10T18:00:00Z')
    });
    assert.ok(hit);
    assert.equal(hit.horaInicio, '13:00');
  });
});
