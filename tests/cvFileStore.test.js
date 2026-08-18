const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CV_TTL_MS,
  isCvExpired,
  getWorkspaceCvs,
  archiveAllWorkspace,
  archiveSentByPhones,
  partitionExpired,
  mergeIncomingBatch,
  stampMissingSavedAt
} = require('../cvFileStore');

function phonesMatch(a, b) {
  return String(a || '').replace(/\D/g, '') === String(b || '').replace(/\D/g, '');
}

describe('cvFileStore archivo 7 días', () => {
  const now = Date.parse('2026-08-17T18:00:00Z');

  it('CV_TTL_MS es exactamente 7 días', () => {
    assert.equal(CV_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it('no expira antes de 7 días; sí al cumplirse la semana', () => {
    const sixDays = {
      cvId: 'a',
      savedAt: new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString()
    };
    const sevenDays = {
      cvId: 'b',
      savedAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
    };
    assert.equal(isCvExpired(sixDays, now), false);
    assert.equal(isCvExpired(sevenDays, now), true);
  });

  it('sin savedAt no se considera expirado (migración)', () => {
    assert.equal(isCvExpired({ cvId: 'x' }, now), false);
  });

  it('stampMissingSavedAt rellena savedAt y no pisa el existente', () => {
    const stamped = stampMissingSavedAt(
      [{ cvId: 'a' }, { cvId: 'b', savedAt: '2026-08-01T00:00:00.000Z' }],
      now
    );
    assert.equal(stamped[0].savedAt, new Date(now).toISOString());
    assert.equal(stamped[1].savedAt, '2026-08-01T00:00:00.000Z');
  });

  it('partitionExpired separa vencidos y vigentes', () => {
    const cvs = [
      { cvId: 'keep', savedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString() },
      { cvId: 'drop', savedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() }
    ];
    const { kept, expired } = partitionExpired(cvs, now);
    assert.deepEqual(
      kept.map((c) => c.cvId),
      ['keep']
    );
    assert.deepEqual(
      expired.map((c) => c.cvId),
      ['drop']
    );
  });
});

describe('cvFileStore mesa de trabajo vs archivo', () => {
  it('getWorkspaceCvs omite inWorkspace false', () => {
    const cvs = [
      { cvId: '1', inWorkspace: true, nombre: 'Ana' },
      { cvId: '2', inWorkspace: false, nombre: 'Luis' },
      { cvId: '3', nombre: 'Sin flag' }
    ];
    const ws = getWorkspaceCvs(cvs);
    assert.deepEqual(
      ws.map((c) => c.cvId),
      ['1', '3']
    );
  });

  it('archiveAllWorkspace saca todo de la mesa y conserva los CVs', () => {
    const cvs = [
      { cvId: '1', inWorkspace: true },
      { cvId: '2' }
    ];
    const archived = archiveAllWorkspace(cvs);
    assert.equal(archived.length, 2);
    assert.equal(
      archived.every((c) => c.inWorkspace === false),
      true
    );
    assert.deepEqual(getWorkspaceCvs(archived), []);
  });

  it('archiveSentByPhones solo archiva los enviados', () => {
    const cvs = [
      { cvId: '1', telefono: '5215551112233', inWorkspace: true },
      { cvId: '2', telefono: '5215559998877', inWorkspace: true }
    ];
    const next = archiveSentByPhones(cvs, ['5215551112233'], phonesMatch);
    assert.equal(next[0].inWorkspace, false);
    assert.equal(next[1].inWorkspace, true);
    assert.equal(next.length, 2);
  });

  it('mergeIncomingBatch no borra el archivo previo y pone el lote nuevo en mesa', () => {
    const archive = [
      {
        cvId: 'old-1',
        telefono: '5551112233',
        nombre: 'Ana',
        inWorkspace: true
      },
      {
        cvId: 'old-2',
        telefono: '5550001111',
        nombre: 'Luis',
        inWorkspace: false
      }
    ];
    const incoming = [
      {
        cvId: 'new-1',
        telefono: '5559998877',
        nombre: 'Beto'
      }
    ];
    const { cvs, replacedIds } = mergeIncomingBatch(archive, incoming, phonesMatch);
    assert.deepEqual(replacedIds, []);
    assert.equal(cvs.length, 3);
    assert.equal(
      cvs.find((c) => c.cvId === 'old-1').inWorkspace,
      false
    );
    assert.equal(
      cvs.find((c) => c.cvId === 'new-1').inWorkspace,
      true
    );
    assert.deepEqual(
      getWorkspaceCvs(cvs).map((c) => c.cvId),
      ['new-1']
    );
  });

  it('mergeIncomingBatch reemplaza el CV del mismo teléfono y reporta el id viejo', () => {
    const archive = [
      { cvId: 'old-ana', telefono: '5551112233', nombre: 'Ana', inWorkspace: false }
    ];
    const incoming = [
      { cvId: 'new-ana', telefono: '5551112233', nombre: 'Ana Actualizada' }
    ];
    const { cvs, replacedIds } = mergeIncomingBatch(archive, incoming, phonesMatch);
    assert.deepEqual(replacedIds, ['old-ana']);
    assert.equal(cvs.length, 1);
    assert.equal(cvs[0].cvId, 'new-ana');
    assert.equal(cvs[0].inWorkspace, true);
  });
});
