const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isPanelCvProcessingError } = require('../autoReplyService');

describe('isPanelCvProcessingError', () => {
  it('reconoce que el panel sigue analizando el CV', () => {
    assert.equal(
      isPanelCvProcessingError(new Error('No se pudo procesar el CV (análisis DeepSeek)')),
      true
    );
    assert.equal(
      isPanelCvProcessingError(new Error('timeout al procesar el cv')),
      true
    );
  });

  it('no trata un fallo de OCC/Playwright como si el panel estuviera procesando', () => {
    assert.equal(
      isPanelCvProcessingError(
        new Error('locator.waitFor: Timeout 60000ms exceeded.')
      ),
      false
    );
    assert.equal(
      isPanelCvProcessingError(
        Object.assign(new Error('No se pudo descargar CV de OCC'), {
          code: 'occ_download_failed'
        })
      ),
      false
    );
  });
});
