const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'users.json');
const store = require('../usersStore');
const auth = require('../auth');

describe('ops role', () => {
  let backup;
  let prevUser;
  let prevPass;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, users: [] }, null, 2));
    prevUser = process.env.AUTH_USERNAME;
    prevPass = process.env.AUTH_PASSWORD;
    process.env.AUTH_USERNAME = 'admin_test';
    process.env.AUTH_PASSWORD = 'secret12';
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(STORE_FILE, backup);
    else if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
    if (prevUser === undefined) delete process.env.AUTH_USERNAME;
    else process.env.AUTH_USERNAME = prevUser;
    if (prevPass === undefined) delete process.env.AUTH_PASSWORD;
    else process.env.AUTH_PASSWORD = prevPass;
  });

  it('crea usuario ops sin permisos por línea', () => {
    const user = store.createUser({
      username: 'ops_demo',
      password: 'secret12',
      role: 'ops',
      permissions: { session1: 'control' }
    });
    assert.equal(user.role, 'ops');
    assert.deepEqual(user.permissions, {});
  });

  it('ops autentica y tiene control implícito de todas las sesiones', () => {
    store.createUser({
      username: 'ops_full',
      password: 'secret12',
      role: 'ops'
    });
    const result = auth.validateCredentials('ops_full', 'secret12');
    assert.equal(result.ok, true);
    assert.equal(result.user.role, 'ops');
    assert.equal(result.user.isOps, true);
    assert.equal(result.user.isSuper, false);
    assert.equal(auth.getSessionAccess(result.user, 'session1'), 'control');
    assert.equal(auth.getSessionAccess(result.user, 'session99'), 'control');
  });

  it('presentSessionsForUser enmascara solo remitente para ops', () => {
    store.createUser({
      username: 'ops_mask',
      password: 'secret12',
      role: 'ops'
    });
    const result = auth.validateCredentials('ops_mask', 'secret12');
    const sessions = [
      {
        id: 'session4',
        label: 'oxxo05',
        openwaSessionId: 'abc-uuid',
        senderName: 'Ana PTC',
        androidDeviceId: 'phone-1',
        outreachChannel: 'android'
      }
    ];
    const presented = auth.presentSessionsForUser(result.user, sessions);
    assert.equal(presented.length, 1);
    assert.equal(presented[0].id, 'session4');
    assert.equal(presented[0].label, 'Ana PTC');
    assert.equal(presented[0].senderName, 'Ana PTC');
    assert.equal(presented[0].openwaSessionId, undefined);
    assert.equal(presented[0].androidDeviceId, undefined);
    assert.equal(presented[0].outreachChannel, undefined);
  });
});
