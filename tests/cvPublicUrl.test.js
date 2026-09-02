const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  publicBaseUrl,
  buildCvPublicUrl,
  isCvUrlReachableByPanel,
  panelUnreachableCvUrlError
} = require('../cvFileStore');

const KEYS = ['CV_PUBLIC_URL', 'WEBHOOK_PUBLIC_URL', 'OPENWA_API_KEY', 'AUTH_SESSION_SECRET'];

describe('cvUrl para el panel (no para OpenWA)', () => {
  const prev = {};

  beforeEach(() => {
    for (const key of KEYS) {
      prev[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AUTH_SESSION_SECRET = 'test-cv-url-secret';
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });

  it('publicBaseUrl prefiere CV_PUBLIC_URL sobre WEBHOOK_PUBLIC_URL', () => {
    process.env.WEBHOOK_PUBLIC_URL = 'http://172.17.0.1:3445';
    process.env.CV_PUBLIC_URL = 'https://msg.protalentconnections.com';
    assert.equal(publicBaseUrl(), 'https://msg.protalentconnections.com');
  });

  it('publicBaseUrl usa WEBHOOK_PUBLIC_URL si no hay CV_PUBLIC_URL', () => {
    process.env.WEBHOOK_PUBLIC_URL = 'https://msg.protalentconnections.com/';
    assert.equal(publicBaseUrl(), 'https://msg.protalentconnections.com');
  });

  it('buildCvPublicUrl usa el host público, no la IP de Docker', () => {
    process.env.WEBHOOK_PUBLIC_URL = 'http://172.17.0.1:3445';
    process.env.CV_PUBLIC_URL = 'https://msg.protalentconnections.com';
    const url = buildCvPublicUrl('9f9c9de781272e213aae946a');
    assert.match(url, /^https:\/\/msg\.protalentconnections\.com\/api\/public\/cv\/9f9c9de781272e213aae946a\?token=/);
    assert.equal(url.includes('172.17.0.1'), false);
  });

  it('marca IPs Docker/privadas como inalcanzables para el panel', () => {
    assert.equal(isCvUrlReachableByPanel('http://172.17.0.1:3445/api/public/cv/x'), false);
    assert.equal(isCvUrlReachableByPanel('http://127.0.0.1:3445/api/public/cv/x'), false);
    assert.equal(isCvUrlReachableByPanel('http://localhost:3445/api/public/cv/x'), false);
    assert.equal(isCvUrlReachableByPanel('http://10.0.0.4:3445/api/public/cv/x'), false);
    assert.equal(isCvUrlReachableByPanel('http://192.168.1.10:3445/api/public/cv/x'), false);
    assert.equal(isCvUrlReachableByPanel('http://host.docker.internal:3445/api/public/cv/x'), false);
  });

  it('acepta un host público HTTPS', () => {
    assert.equal(
      isCvUrlReachableByPanel(
        'https://msg.protalentconnections.com/api/public/cv/9f9c9de781272e213aae946a?token=abc'
      ),
      true
    );
  });

  it('explica por qué 172.17.0.1 provoca 504 en el panel', () => {
    const msg = panelUnreachableCvUrlError('http://172.17.0.1:3445/api/public/cv/abc?token=x');
    assert.match(msg, /172\.17\.0\.1/);
    assert.match(msg, /CV_PUBLIC_URL/);
    assert.match(msg, /panel/i);
  });
});
