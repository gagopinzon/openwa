const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractMeetUrlFromPanel,
  isRetryablePanelError
} = require('../panelMeetUtils');

describe('panelMeetUtils', () => {
  it('extrae urlReunion del panel', () => {
    const url = extractMeetUrlFromPanel({
      reunion: { urlReunion: 'https://meet.google.com/abc-defg-hij' }
    });
    assert.equal(url, 'https://meet.google.com/abc-defg-hij');
  });

  it('extrae urlReunionLead y urls.lead', () => {
    assert.equal(
      extractMeetUrlFromPanel({ urlReunionLead: 'https://meet.google.com/lead-1' }),
      'https://meet.google.com/lead-1'
    );
    assert.equal(
      extractMeetUrlFromPanel({ urls: { lead: 'https://meet.google.com/lead-2' } }),
      'https://meet.google.com/lead-2'
    );
  });

  it('detecta errores reintentables del panel', () => {
    assert.equal(isRetryablePanelError(new Error('timeout al procesar el cv')), true);
    assert.equal(isRetryablePanelError({ status: 409, message: 'ocupado' }), false);
  });

  it('no reintenta 400 por 401 al descargar el CV', () => {
    assert.equal(
      isRetryablePanelError({
        status: 400,
        message: 'No se pudo procesar el CV (descarga, extracción o análisis)',
        panelBody: {
          message: 'No se pudo procesar el CV (descarga, extracción o análisis)',
          details: 'Request failed with status code 401'
        }
      }),
      false
    );
  });
});
