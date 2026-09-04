const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cvFileStore = require('../cvFileStore');
const {
  resolveUsableCvId,
  lookupCvIdFromArchive,
  syncClientCvEditsIntoArchive
} = require('../cvLookup');

const PDF_MIN = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('cvLookup', () => {
  const createdIds = [];

  after(() => {
    for (const id of createdIds) {
      try {
        cvFileStore.deleteCvFile(id);
      } catch {
        /* ignore */
      }
    }
    // Restaurar manifesto limpio de basura de test
    const kept = (cvFileStore.loadCvsManifest() || []).filter(
      (c) => c && !createdIds.includes(c.cvId)
    );
    cvFileStore.saveCvsManifest(kept);
  });

  it('lookupCvIdFromArchive encuentra por teléfono con formato distinto', () => {
    const saved = cvFileStore.saveCvFile(PDF_MIN, 'ana-test.pdf');
    createdIds.push(saved.cvId);
    const entry = {
      nombre: 'Ana Test',
      telefono: '5551112233',
      experiencia: 'Ventas',
      archivoOriginal: 'ana-test.pdf',
      cvId: saved.cvId,
      cvFileName: saved.cvFileName,
      procesado: true,
      inWorkspace: false,
      savedAt: new Date().toISOString()
    };
    const manifest = cvFileStore.loadCvsManifest() || [];
    cvFileStore.saveCvsManifest([...manifest, entry]);

    assert.equal(lookupCvIdFromArchive('5215551112233'), saved.cvId);
    assert.equal(lookupCvIdFromArchive('+52 55 5111 2233'), saved.cvId);
  });

  it('si el teléfono no coincide, usa el CV cargado con el mismo nombre', () => {
    const saved = cvFileStore.saveCvFile(PDF_MIN, 'gonzalo-test.pdf');
    createdIds.push(saved.cvId);
    const entry = {
      nombre: 'Gonzaloqaunique Hernández',
      telefono: 'No encontrado',
      experiencia: 'Ops',
      archivoOriginal: 'gonzalo-test.pdf',
      cvId: saved.cvId,
      cvFileName: saved.cvFileName,
      procesado: true,
      inWorkspace: true,
      savedAt: new Date().toISOString()
    };
    const manifest = cvFileStore.loadCvsManifest() || [];
    cvFileStore.saveCvsManifest([...manifest, entry]);

    assert.equal(
      lookupCvIdFromArchive('5215550001111', { name: 'Gonzaloqaunique' }),
      saved.cvId
    );
    assert.equal(
      resolveUsableCvId({
        leadCv: null,
        contactSession: { name: 'Gonzaloqaunique' },
        phone: '5215550001111',
        name: 'Gonzaloqaunique'
      }),
      saved.cvId
    );
  });

  it('no adivina el CV si hay dos cargados con el mismo nombre de pila', () => {
    const a = cvFileStore.saveCvFile(PDF_MIN, 'gonzalo-a.pdf');
    const b = cvFileStore.saveCvFile(PDF_MIN, 'gonzalo-b.pdf');
    createdIds.push(a.cvId, b.cvId);
    const manifest = cvFileStore.loadCvsManifest() || [];
    cvFileStore.saveCvsManifest([
      ...manifest,
      {
        nombre: 'Dostwinqa Pérez',
        telefono: 'No encontrado',
        cvId: a.cvId,
        cvFileName: a.cvFileName,
        procesado: true,
        savedAt: new Date().toISOString()
      },
      {
        nombre: 'Dostwinqa Ruiz',
        telefono: 'No encontrado',
        cvId: b.cvId,
        cvFileName: b.cvFileName,
        procesado: true,
        savedAt: new Date().toISOString()
      }
    ]);

    assert.equal(lookupCvIdFromArchive('5215550002222', { name: 'Dostwinqa' }), null);
  });

  it('resolveUsableCvId cae al archivo si Mongo trae cvId stale sin PDF', () => {
    const saved = cvFileStore.saveCvFile(PDF_MIN, 'luis-test.pdf');
    createdIds.push(saved.cvId);
    const entry = {
      nombre: 'Luis Test',
      telefono: '5587654321',
      experiencia: 'Ops',
      archivoOriginal: 'luis-test.pdf',
      cvId: saved.cvId,
      cvFileName: saved.cvFileName,
      procesado: true,
      inWorkspace: false,
      savedAt: new Date().toISOString()
    };
    const manifest = cvFileStore.loadCvsManifest() || [];
    cvFileStore.saveCvsManifest([...manifest, entry]);

    const id = resolveUsableCvId({
      leadCv: null,
      contactSession: { cvId: 'deadbeefdeadbeefdeadbeef' },
      phone: '5215587654321'
    });
    assert.equal(id, saved.cvId);
  });

  it('syncClientCvEditsIntoArchive persiste teléfono editado (relación cliente↔CV)', () => {
    const archive = [
      {
        cvId: 'abc123abc123abc1',
        archivoOriginal: 'cv.pdf',
        telefono: 'No encontrado',
        nombre: 'Sin nombre',
        mensajeIA: 'hola viejo'
      }
    ];
    const synced = syncClientCvEditsIntoArchive(archive, [
      {
        cvId: 'abc123abc123abc1',
        archivoOriginal: 'cv.pdf',
        telefono: '5215559998877',
        nombre: 'María',
        mensajeIA: 'hola nuevo',
        saludo: '¡Hola!'
      }
    ]);
    assert.equal(synced[0].telefono, '5215559998877');
    assert.equal(synced[0].nombre, 'María');
    assert.equal(synced[0].mensajeIA, 'hola nuevo');
    assert.equal(synced[0].saludo, '¡Hola!');
  });
});
