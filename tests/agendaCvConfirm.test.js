const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeCvConfirmYes,
  looksLikeCvConfirmNo,
  isAwaitingCvConfirm
} = require('../agendaCvConfirm');

describe('agendaCvConfirm', () => {
  it('detecta confirmación positiva', () => {
    assert.equal(looksLikeCvConfirmYes('sí'), true);
    assert.equal(looksLikeCvConfirmYes('si, ese es mi cv'), true);
    assert.equal(looksLikeCvConfirmYes('correcto'), true);
  });

  it('detecta rechazo del CV', () => {
    assert.equal(looksLikeCvConfirmNo('no'), true);
    assert.equal(looksLikeCvConfirmNo('no es ese, te mando otro'), true);
    assert.equal(looksLikeCvConfirmNo('quiero enviar otro cv'), true);
  });

  it('no confunde sí y no', () => {
    assert.equal(looksLikeCvConfirmYes('no'), false);
    assert.equal(looksLikeCvConfirmNo('sí'), false);
  });

  it('identifica etapa confirm_cv', () => {
    assert.equal(isAwaitingCvConfirm('confirm_cv'), true);
    assert.equal(isAwaitingCvConfirm('need_upload'), false);
  });
});
