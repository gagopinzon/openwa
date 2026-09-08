const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractPhoneFromOpenWaContact,
  normalizeOpenWaContact,
  parseOpenWaResolvedPhone
} = require('../openwaClient');

describe('extractPhoneFromOpenWaContact', () => {
  it('lee number / phoneNumber en la raíz', () => {
    assert.equal(extractPhoneFromOpenWaContact({ number: '5215512345678' }), '5215512345678');
    assert.equal(
      extractPhoneFromOpenWaContact({ phoneNumber: '+52 55 1234 5678' }),
      '525512345678'
    );
  });

  it('lee id serializado @c.us y no trata @lid como teléfono', () => {
    assert.equal(
      extractPhoneFromOpenWaContact({ id: '5215512345678@c.us' }),
      '5215512345678'
    );
    assert.equal(
      extractPhoneFromOpenWaContact({ id: { _serialized: '5219988776655@c.us' } }),
      '5219988776655'
    );
    assert.equal(
      extractPhoneFromOpenWaContact({ id: '44508779647131@lid' }),
      ''
    );
  });

  it('excava dentro de raw / contact anidados', () => {
    assert.equal(
      extractPhoneFromOpenWaContact({
        id: '44508779647131@lid',
        name: 'Ana',
        raw: { number: '5512345678', id: '44508779647131@lid' }
      }),
      '5512345678'
    );
    assert.equal(
      extractPhoneFromOpenWaContact({
        contact: { phoneNumber: '5213311122233' }
      }),
      '5213311122233'
    );
  });

  it('prefiere id @c.us cuando number trae dígitos del LID', () => {
    // Respuesta real OpenWA: getContact(…@lid) a veces deja number=LID e id=@c.us
    assert.equal(
      extractPhoneFromOpenWaContact({
        id: '5214424077709@c.us',
        pushName: 'Abogada',
        number: '88854568689898',
        isMyContact: false,
        isBlocked: false
      }),
      '5214424077709'
    );
  });

  it('normalizeOpenWaContact expone number en el objeto plano', () => {
    const normalized = normalizeOpenWaContact(
      { name: 'Luis', isBlocked: false, number: '5215511122233' },
      '44508779647131@lid'
    );
    assert.equal(normalized.number, '5215511122233');
    assert.equal(normalized.phoneNumber, '5215511122233');
    assert.equal(normalized.name, 'Luis');
    assert.equal(normalized.id, '44508779647131@lid');
    assert.ok(normalized.raw);
  });
});

describe('parseOpenWaResolvedPhone', () => {
  it('lee phone string del endpoint /contacts/.../phone', () => {
    assert.equal(
      parseOpenWaResolvedPhone({ contactId: '88854568689898@lid', phone: '5214424077709' }),
      '5214424077709'
    );
  });

  it('devuelve vacío si phone es null', () => {
    assert.equal(
      parseOpenWaResolvedPhone({ contactId: '88854568689898@lid', phone: null }),
      ''
    );
  });

  it('ignora phone igual a dígitos del @lid', () => {
    assert.equal(
      parseOpenWaResolvedPhone({
        contactId: '88854568689898@lid',
        phone: '88854568689898'
      }),
      ''
    );
  });
});
