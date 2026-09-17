const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sampleDelaySeconds,
  buildStartupDelayMsList
} = require('../openwaWhatsAppService');

describe('sampleDelaySeconds', () => {
  it('queda dentro del rango inclusive', () => {
    const range = { minSeconds: 60, maxSeconds: 300 };
    for (let i = 0; i < 40; i++) {
      const sec = sampleDelaySeconds(range, 3, () => i / 40);
      assert.ok(sec >= 60);
      assert.ok(sec <= 300);
    }
  });

  it('usa el mínimo cuando rng es 0', () => {
    assert.equal(sampleDelaySeconds({ minSeconds: 90, maxSeconds: 180 }, 3, () => 0), 90);
  });
});

describe('buildStartupDelayMsList', () => {
  it('la primera línea arranca en 0 y las siguientes acumulan el intervalo', () => {
    const delays = buildStartupDelayMsList(
      3,
      { minSeconds: 60, maxSeconds: 60 },
      () => 0
    );
    assert.deepEqual(delays, [0, 60000, 120000]);
  });

  it('una sola línea no espera', () => {
    assert.deepEqual(
      buildStartupDelayMsList(1, { minSeconds: 120, maxSeconds: 120 }, () => 0),
      [0]
    );
  });

  it('no desfasa líneas vacías ni retrasa a las que sí envían', () => {
    const delays = buildStartupDelayMsList(
      4,
      { minSeconds: 60, maxSeconds: 60 },
      () => 0,
      [true, false, true, true]
    );
    assert.deepEqual(delays, [0, 0, 60000, 120000]);
  });

  it('lista vacía', () => {
    assert.deepEqual(buildStartupDelayMsList(0, { minSeconds: 60, maxSeconds: 120 }), []);
  });
});
