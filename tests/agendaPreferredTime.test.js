const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  agendaPreferredHhmm,
  pickExactSlotTodayOrTomorrow,
  selectNearestInWindow,
  formatConfirmReply,
  formatNearestReply,
  ASK_PREFERRED_CONTEXT,
  resolvePreferredTimeOffer
} = require('../agendaPreferredTime');

function slot(fecha, horaInicio, horaFin) {
  return {
    fecha,
    horaInicio,
    horaFin: horaFin || add15(horaInicio)
  };
}

function add15(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const tot = h * 60 + m + 15;
  return `${String(Math.floor(tot / 60)).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
}

describe('agendaPreferredTime', () => {
  const today = '2026-09-02';
  const tomorrow = '2026-09-03';
  const dayOpts = { today, tomorrow };

  it('interpreta "a las 5" como 17:00 en contexto de cita', () => {
    assert.equal(agendaPreferredHhmm('me gustaría que fuera a las 5'), '17:00');
    assert.equal(agendaPreferredHhmm('a las 5'), '17:00');
    assert.equal(agendaPreferredHhmm('el jueves a las 5 de la tarde'), '17:00');
    assert.equal(agendaPreferredHhmm('a las 10'), '10:00');
    assert.equal(agendaPreferredHhmm('quiero agendar'), null);
  });

  it('elige el hueco exacto de hoy y si no el de mañana', () => {
    const slots = [
      slot(today, '16:00'),
      slot(today, '17:00'),
      slot(tomorrow, '17:00')
    ];
    const todayHit = pickExactSlotTodayOrTomorrow(slots, '17:00', dayOpts);
    assert.equal(todayHit.fecha, today);
    assert.equal(todayHit.horaInicio, '17:00');

    const onlyTomorrow = pickExactSlotTodayOrTomorrow(
      [slot(today, '16:00'), slot(tomorrow, '17:00')],
      '17:00',
      dayOpts
    );
    assert.equal(onlyTomorrow.fecha, tomorrow);
  });

  it('si no hay hueco exacto, toma hasta 6 en ventana ±2h repartidas hoy/mañana', () => {
    const slots = [
      slot(today, '14:00'),
      slot(today, '15:00'),
      slot(today, '16:00'),
      slot(today, '16:30'),
      slot(today, '18:00'),
      slot(today, '19:00'),
      slot(today, '20:00'),
      slot(tomorrow, '15:00'),
      slot(tomorrow, '16:00'),
      slot(tomorrow, '17:00'),
      slot(tomorrow, '18:00')
    ];
    const nearby = selectNearestInWindow(slots, '17:00', dayOpts);
    assert.ok(nearby.length <= 6);
    assert.ok(nearby.length >= 4);
    assert.ok(nearby.every((s) => s.fecha === today || s.fecha === tomorrow));
    assert.ok(nearby.every((s) => {
      const [h, m] = s.horaInicio.split(':').map(Number);
      const mins = h * 60 + m;
      return Math.abs(mins - 17 * 60) <= 120;
    }));
    assert.ok(nearby.some((s) => s.fecha === today));
    assert.ok(nearby.some((s) => s.fecha === tomorrow));
    assert.ok(!nearby.some((s) => s.horaInicio === '14:00'));
    assert.ok(!nearby.some((s) => s.horaInicio === '20:00'));
  });

  it('si la ventana está vacía, usa las más cercanas aunque salgan de ±2h', () => {
    const slots = [
      slot(today, '09:00'),
      slot(today, '10:00'),
      slot(tomorrow, '11:00')
    ];
    const nearby = selectNearestInWindow(slots, '17:00', dayOpts);
    assert.ok(nearby.length > 0);
    assert.ok(nearby.length <= 6);
  });

  it('sin hora → preguntar; con hueco → confirmar; sin hueco → cercanas', () => {
    const slots = [
      slot(today, '16:00'),
      slot(tomorrow, '16:00'),
      slot(tomorrow, '17:00')
    ];
    assert.equal(resolvePreferredTimeOffer('me interesa', slots, dayOpts).action, 'ask');

    const confirm = resolvePreferredTimeOffer('a las 5', slots, dayOpts);
    assert.equal(confirm.action, 'confirm');
    assert.equal(confirm.slot.fecha, tomorrow);
    assert.equal(confirm.slot.horaInicio, '17:00');

    const nearest = resolvePreferredTimeOffer('a las 5', [slot(today, '16:00')], dayOpts);
    assert.equal(nearest.action, 'nearest');
    assert.equal(nearest.preferredTime, '17:00');
    assert.ok(nearest.nearby.length >= 1);
  });

  it('el mensaje de confirmación pide el sí y no lista el calendario', () => {
    const text = formatConfirmReply(slot(today, '17:00'), today);
    assert.match(text, /perfecto/i);
    assert.match(text, /te agendo a las 17:00/i);
    assert.match(text, /hoy/i);
    assert.match(text, /te queda/i);
    assert.doesNotMatch(text, /libres /i);

    const manana = formatConfirmReply(slot(tomorrow, '17:00'), today);
    assert.match(manana, /mañana/i);
  });

  it('el mensaje de cercanas lista hoy/mañana y no inventa la hora pedida', () => {
    const text = formatNearestReply(
      [slot(today, '16:00'), slot(tomorrow, '16:30')],
      '17:00',
      today
    );
    assert.match(text, /17:00/);
    assert.match(text, /16:00/);
    assert.match(text, /16:30/);
    assert.match(text, /hoy/i);
    assert.match(text, /mañana/i);
  });

  it('ASK_PREFERRED_CONTEXT prohíbe listar horarios', () => {
    assert.match(ASK_PREFERRED_CONTEXT, /PREGUNTA_HORA/);
    assert.match(ASK_PREFERRED_CONTEXT, /NO listes/i);
  });
});
