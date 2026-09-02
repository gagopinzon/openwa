/**
 * Detecta si el lead confirma que el CV enviado es el correcto.
 * @param {string} text
 */
function looksLikeCvConfirmYes(text) {
  const raw = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!raw) return false;
  if (looksLikeCvConfirmNo(text)) return false;

  if (/^(si|ok|vale|listo|correcto|confirmo|exacto|así es|asi es)\.?$/i.test(raw)) {
    return true;
  }

  return (
    /\b(si|correcto|confirmo|ese es|es ese|es el mismo|es mi cv|asi es|exacto)\b/.test(raw) ||
    /\beste es\b/.test(raw) ||
    /\bes correcto\b/.test(raw)
  );
}

/**
 * @param {string} text
 */
function looksLikeCvConfirmNo(text) {
  const raw = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!raw) return false;

  if (/^(no|nop)\.?$/i.test(raw)) return true;

  return (
    /\b(no es|no es ese|incorrecto|equivocado|otro cv|diferente)\b/.test(raw) ||
    /\b(envio|enviare|mandare|comparto)\s+otro\b/.test(raw) ||
    /\botro\s+cv\b/.test(raw)
  );
}

/**
 * @param {string} stage
 */
function isAwaitingCvConfirm(stage) {
  return String(stage || '').trim() === 'confirm_cv';
}

module.exports = {
  looksLikeCvConfirmYes,
  looksLikeCvConfirmNo,
  isAwaitingCvConfirm
};
