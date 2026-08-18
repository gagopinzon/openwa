const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'users.json');
const store = require('../usersStore');

describe('transferLines', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, users: [] }, null, 2));
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(STORE_FILE, backup);
    else if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  });

  function seedTwoUsers(fromPerms, toPerms) {
    const from = store.createUser({
      username: 'ana_handover',
      password: 'secret12',
      permissions: fromPerms
    });
    const to = store.createUser({
      username: 'luis_handover',
      password: 'secret12',
      permissions: toPerms
    });
    return { from, to };
  }

  it('mueve todas las líneas; origen vacío; destino control', () => {
    const { from, to } = seedTwoUsers(
      { session1: 'control', session2: 'view' },
      {}
    );

    const result = store.transferLines(from.id, to.id);

    assert.equal(result.movedCount, 2);
    assert.deepEqual(result.sessionIds.sort(), ['session1', 'session2']);
    assert.deepEqual(result.from.permissions, {});
    assert.equal(result.to.permissions.session1, 'control');
    assert.equal(result.to.permissions.session2, 'control');

    assert.deepEqual(store.findUserById(from.id).permissions, {});
    assert.equal(store.findUserById(to.id).permissions.session1, 'control');
  });

  it('destino que ya tenía view sube a control', () => {
    const { from, to } = seedTwoUsers(
      { session1: 'view' },
      { session1: 'view', session9: 'control' }
    );

    const result = store.transferLines(from.id, to.id);

    assert.equal(result.to.permissions.session1, 'control');
    assert.equal(result.to.permissions.session9, 'control');
    assert.deepEqual(result.from.permissions, {});
  });

  it('tercer usuario no se modifica', () => {
    const { from, to } = seedTwoUsers({ session1: 'control' }, {});
    const other = store.createUser({
      username: 'pepe_handover',
      password: 'secret12',
      permissions: { session1: 'view', session3: 'control' }
    });

    store.transferLines(from.id, to.id);

    const still = store.findUserById(other.id);
    assert.equal(still.permissions.session1, 'view');
    assert.equal(still.permissions.session3, 'control');
  });

  it('mismo usuario lanza error', () => {
    const { from } = seedTwoUsers({ session1: 'control' }, {});
    assert.throws(
      () => store.transferLines(from.id, from.id),
      /El destino debe ser otro usuario/
    );
  });

  it('origen inexistente lanza error', () => {
    const { to } = seedTwoUsers({ session1: 'control' }, {});
    assert.throws(
      () => store.transferLines('missing-from', to.id),
      /Usuario origen no encontrado/
    );
  });

  it('destino inexistente lanza error', () => {
    const { from } = seedTwoUsers({ session1: 'control' }, {});
    assert.throws(
      () => store.transferLines(from.id, 'missing-to'),
      /Usuario destino no encontrado/
    );
  });

  it('sin líneas lanza error', () => {
    const { from, to } = seedTwoUsers({}, { session1: 'control' });
    assert.throws(
      () => store.transferLines(from.id, to.id),
      /Ese usuario no tiene líneas para pasar/
    );
  });
});
