const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveContactIdentity } = require('../autoReplyService');

describe('resolveContactIdentity LID→phone', () => {
  it('usa senderPhone del payload sin llamar OpenWA', async () => {
    let called = false;
    const identity = await resolveContactIdentity(
      'sess',
      '88854568689898@lid',
      { from: '88854568689898@lid', senderPhone: '5214424077709' },
      {
        getContact: async () => {
          called = true;
          return {};
        },
        getContactPhone: async () => {
          called = true;
          return '';
        }
      }
    );
    assert.equal(identity.normalizedPhone, '5214424077709');
    assert.equal(identity.resolvedFrom, 'payload');
    assert.equal(identity.whatsappLid, '88854568689898');
    assert.equal(called, false);
  });

  it('cae a GET /phone cuando getContact no trae teléfono usable', async () => {
    const identity = await resolveContactIdentity(
      'sess-oxxo04',
      '88854568689898@lid',
      { from: '88854568689898@lid' },
      {
        getContact: async () => ({
          id: '88854568689898@lid',
          number: null,
          phoneNumber: null,
          phone: null,
          name: 'Abogada',
          raw: { id: '88854568689898@lid', number: '88854568689898' }
        }),
        getContactPhone: async (_sid, chatId) => {
          assert.equal(chatId, '88854568689898@lid');
          return '5214424077709';
        }
      }
    );
    assert.equal(identity.normalizedPhone, '5214424077709');
    assert.equal(identity.resolvedFrom, 'openwa_lid_phone');
    assert.equal(identity.whatsappLid, '88854568689898');
    assert.equal(identity.name, 'Abogada');
  });

  it('usa openwa_contact si getContact ya trae id @c.us (number engañoso)', async () => {
    let phoneCalled = false;
    const identity = await resolveContactIdentity(
      'sess',
      '88854568689898@lid',
      { from: '88854568689898@lid' },
      {
        getContact: async () => ({
          id: '5214424077709@c.us',
          number: '5214424077709',
          phoneNumber: '5214424077709',
          phone: '5214424077709',
          name: 'Abogada',
          raw: {
            id: '5214424077709@c.us',
            number: '88854568689898',
            pushName: 'Abogada'
          }
        }),
        getContactPhone: async () => {
          phoneCalled = true;
          return '';
        }
      }
    );
    assert.equal(identity.normalizedPhone, '5214424077709');
    assert.equal(identity.resolvedFrom, 'openwa_contact');
    assert.equal(phoneCalled, false);
  });

  it('cae a lid_key si /phone tampoco resuelve', async () => {
    const identity = await resolveContactIdentity(
      'sess',
      '88854568689898@lid',
      { from: '88854568689898@lid' },
      {
        getContact: async () => ({
          id: '88854568689898@lid',
          number: null,
          phoneNumber: null,
          phone: null,
          raw: { id: '88854568689898@lid', number: '88854568689898' }
        }),
        getContactPhone: async () => ''
      }
    );
    assert.equal(identity.normalizedPhone, 'lid_88854568689898');
    assert.equal(identity.resolvedFrom, 'lid_key');
  });
});
