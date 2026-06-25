/**
 * Lista de números de teléfono válidos conocidos y sus identificadores de WhatsApp Business
 * Estos números han sido verificados y pueden enviar mensajes correctamente
 */

module.exports = {
  validNumbers: [
    {
      phone: '+5213340115616',
      phoneId: '951754178010349',
      businessAccountId: '4143359182569077',
      description: 'Cuenta de WhatsApp Business válida - Envía mensajes correctamente',
      verified: true,
      verifiedDate: new Date().toISOString()
    }
  ],

  /**
   * Verifica si un número está en la lista de números válidos conocidos
   * @param {string} phone - Número de teléfono a verificar (formato: +521234567890)
   * @returns {Object|null} - Información del número si es válido, null si no
   */
  isValidNumber(phone) {
    // Normalizar el número para comparación
    const normalizedPhone = phone.replace(/[\s().-]/g, '');
    
    return this.validNumbers.find(num => {
      const normalizedValid = num.phone.replace(/[\s().-]/g, '');
      return normalizedValid === normalizedPhone || 
             normalizedValid.endsWith(normalizedPhone) ||
             normalizedPhone.endsWith(normalizedValid);
    }) || null;
  },

  /**
   * Agrega un nuevo número válido a la lista
   * @param {Object} numberInfo - Información del número válido
   */
  addValidNumber(numberInfo) {
    this.validNumbers.push({
      ...numberInfo,
      verified: true,
      verifiedDate: new Date().toISOString()
    });
  }
};








