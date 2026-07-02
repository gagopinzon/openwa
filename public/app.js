class CVAnalyzer {
    constructor() {
        this.selectedFiles = [];
        this.cvsData = [];
        this.testMode = false;
        this.whatsappProvider = 'openwa';
        this.configuredSessions = [];
        this.eventSource = null;
        this.sendJobCompleted = null;
        this.initializeElements();
        this.attachEventListeners();
        this.setupSendingControls();
        this.loadConfig().then(() => this.loadSessions());
    }

    initializeElements() {
        this.dropzone = document.getElementById('dropzone');
        this.fileInput = document.getElementById('fileInput');
        this.fileList = document.getElementById('fileList');
        this.fileItems = document.getElementById('fileItems');
        this.uploadBtn = document.getElementById('uploadBtn');
        this.resultsSection = document.getElementById('resultsSection');
        this.generateMessagesBtn = document.getElementById('generateMessagesBtn');
        this.sendWhatsAppBtn = document.getElementById('sendWhatsAppBtn');
        this.openWhatsAppBtn = document.getElementById('openWhatsAppBtn');
        this.sessionSelect = document.getElementById('sessionSelect');
        this.sessionCheckboxes = document.getElementById('sessionCheckboxes');
        this.sessionsList = document.getElementById('sessionsList');
        this.sessionsEmptyHint = document.getElementById('sessionsEmptyHint');
        this.openwaSessionPicker = document.getElementById('openwaSessionPicker');
        this.sessionLabelInput = document.getElementById('sessionLabelInput');
        this.addSessionBtn = document.getElementById('addSessionBtn');
        this.importConnectedBtn = document.getElementById('importConnectedBtn');
        this.refreshOpenwaListBtn = document.getElementById('refreshOpenwaListBtn');
        this.clearDataBtn = document.getElementById('clearDataBtn');
        this.cvsTableBody = document.getElementById('cvsTableBody');
        this.statusMessage = document.getElementById('statusMessage');
        this.progressSection = document.getElementById('progressSection');
        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');
        this.currentMessage = document.getElementById('currentMessage');
        this.logContainer = document.getElementById('logContainer');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        this.loadingText = document.getElementById('loadingText');
        this.sessionSendingPanel = document.getElementById('sessionSendingPanel');
        this.sessionSendingCards = document.getElementById('sessionSendingCards');
        this.abortAllSessionsBtn = document.getElementById('abortAllSessionsBtn');
        this.sessionLiveState = {};

        // Cargar el sonido de notificación
        this.notificationSound = new Audio('/notification-ping-372479.mp3');
        this.notificationSound.volume = 0.7; // Volumen moderado
    }

    attachEventListeners() {
        // Dropzone events
        this.dropzone.addEventListener('click', () => this.fileInput.click());
        this.dropzone.addEventListener('dragover', this.handleDragOver.bind(this));
        this.dropzone.addEventListener('dragleave', this.handleDragLeave.bind(this));
        this.dropzone.addEventListener('drop', this.handleDrop.bind(this));

        // File input
        this.fileInput.addEventListener('change', this.handleFileSelect.bind(this));

        // Buttons
        this.uploadBtn.addEventListener('click', this.uploadFiles.bind(this));
        this.generateMessagesBtn.addEventListener('click', this.generateMessages.bind(this));
        this.sendWhatsAppBtn.addEventListener('click', this.sendWhatsApp.bind(this));
        this.openWhatsAppBtn.addEventListener('click', this.openWhatsApp.bind(this));
        this.clearDataBtn.addEventListener('click', this.clearData.bind(this));
        if (this.addSessionBtn) {
            this.addSessionBtn.addEventListener('click', this.addSession.bind(this));
        }
        if (this.importConnectedBtn) {
            this.importConnectedBtn.addEventListener('click', this.importConnectedSessions.bind(this));
        }
        if (this.refreshOpenwaListBtn) {
            this.refreshOpenwaListBtn.addEventListener('click', this.loadOpenWASessionPicker.bind(this));
        }
        if (this.abortAllSessionsBtn) {
            this.abortAllSessionsBtn.addEventListener('click', () => this.abortSending('__roundrobin__'));
        }
    }

    getSessionLabel(sessionId) {
        const found = this.configuredSessions.find((s) => s.id === sessionId);
        return found ? found.label : sessionId;
    }

    /** Devuelve array de sessionId de los checkboxes marcados */
    getSelectedSessionIds() {
        if (!this.sessionCheckboxes) return [];
        const ids = [];
        this.sessionCheckboxes.querySelectorAll('.session-send-checkbox:checked').forEach((cb) => {
            if (cb.value) ids.push(cb.value);
        });
        return ids;
    }

    getControlSessionId() {
        return this.activeControlSessionId || '__roundrobin__';
    }

    renderSessionUI() {
        const sessions = this.configuredSessions || [];

        if (this.sessionSelect) {
            const prev = this.sessionSelect.value;
            this.sessionSelect.innerHTML = '';
            if (sessions.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'Sin sesiones configuradas';
                this.sessionSelect.appendChild(opt);
                this.sessionSelect.disabled = true;
            } else {
                this.sessionSelect.disabled = false;
                sessions.forEach((s) => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.textContent = s.label;
                    this.sessionSelect.appendChild(opt);
                });
                if (prev && sessions.some((s) => s.id === prev)) {
                    this.sessionSelect.value = prev;
                }
            }
        }

        if (this.sessionCheckboxes) {
            const previouslyChecked = new Set(
                [...this.sessionCheckboxes.querySelectorAll('.session-send-checkbox:checked')].map(
                    (cb) => cb.value
                )
            );
            const defaultAllChecked = !this._sessionsCheckboxesInitialized;

            this.sessionCheckboxes.innerHTML = '';
            sessions.forEach((s) => {
                const label = document.createElement('label');
                label.style.cssText =
                    'display: inline-flex; align-items: center; cursor: pointer; background: #f0f9ff; padding: 8px 15px; border-radius: 20px; border: 1px solid #bae6fd;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'session-send-checkbox';
                cb.value = s.id;
                cb.checked = defaultAllChecked || previouslyChecked.has(s.id);
                cb.style.cssText = 'margin-right: 8px; width: 18px; height: 18px;';
                const span = document.createElement('span');
                span.style.cssText = 'font-weight: 500; color: #0369a1;';
                span.textContent = s.label;
                label.appendChild(cb);
                label.appendChild(span);
                this.sessionCheckboxes.appendChild(label);
            });
            this._sessionsCheckboxesInitialized = true;
        }

        if (this.sessionsList) {
            if (sessions.length === 0) {
                this.sessionsList.innerHTML =
                    '<p style="color:#64748b;font-size:13px;">Aún no hay sesiones guardadas.</p>';
            } else {
                this.sessionsList.innerHTML = sessions
                    .map(
                        (s) => `
                    <div class="session-row" data-session-id="${s.id}" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;margin-bottom:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                        <strong style="min-width:120px;">${this.escapeHtml(s.label)}</strong>
                        <code style="font-size:12px;background:#e2e8f0;padding:2px 6px;border-radius:4px;">${this.escapeHtml(s.openwaSessionId)}</code>
                        <button type="button" class="btn btn-danger btn-sm remove-session-btn" data-id="${s.id}" style="margin-left:auto;padding:4px 10px;font-size:12px;">Quitar</button>
                    </div>`
                    )
                    .join('');

                this.sessionsList.querySelectorAll('.remove-session-btn').forEach((btn) => {
                    btn.addEventListener('click', () => this.removeSession(btn.dataset.id));
                });
            }
        }

        if (this.sessionsEmptyHint) {
            this.sessionsEmptyHint.style.display = sessions.length === 0 ? 'block' : 'none';
        }
    }

    escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async loadSessions() {
        try {
            const response = await fetch('/api/sessions');
            const data = await response.json();
            if (data.success) {
                this.configuredSessions = data.sessions || [];
                this.renderSessionUI();
            }
        } catch (error) {
            console.error('Error cargando sesiones:', error);
        }

        if (!this.testMode) {
            this.loadOpenWASessionPicker();
        }
    }

    async loadOpenWASessionPicker() {
        if (!this.openwaSessionPicker || this.testMode) return;

        try {
            const response = await fetch('/api/openwa/sessions');
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'No se pudo cargar OpenWA');
            }

            const configuredIds = new Set(
                (this.configuredSessions || []).map((s) => s.openwaSessionId.toLowerCase())
            );

            this.openwaSessionPicker.innerHTML = '<option value="">— Elegir sesión de OpenWA —</option>';
            (data.sessions || []).forEach((row) => {
                const already = configuredIds.has(String(row.id).toLowerCase());
                const status = row.status ? ` [${row.status}]` : '';
                const phone = row.phoneNumber ? ` (${row.phoneNumber})` : '';
                const opt = document.createElement('option');
                opt.value = row.id;
                opt.textContent = `${row.name || row.id}${phone}${status}${already ? ' ✓' : ''}`;
                opt.disabled = already;
                opt.dataset.name = row.name || row.id;
                this.openwaSessionPicker.appendChild(opt);
            });
        } catch (error) {
            console.error('Error listando sesiones OpenWA:', error);
            const hint =
                error.message && /ENOTFOUND/i.test(error.message)
                    ? 'OpenWA no alcanzable (revisa OPENWA_BASE_URL / DNS)'
                    : 'Error al cargar OpenWA (revisa OPENWA_API_KEY y OPENWA_BASE_URL)';
            this.openwaSessionPicker.innerHTML = `<option value="">${hint}</option>`;
        }
    }

    async addSession() {
        const openwaSessionId = this.openwaSessionPicker ? this.openwaSessionPicker.value : '';
        if (!openwaSessionId) {
            this.showStatus('Selecciona una sesión de OpenWA en el desplegable', 'error');
            return;
        }

        const selectedOpt = this.openwaSessionPicker.selectedOptions[0];
        const label =
            (this.sessionLabelInput && this.sessionLabelInput.value.trim()) ||
            (selectedOpt && selectedOpt.dataset.name) ||
            openwaSessionId;

        try {
            const response = await fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ openwaSessionId, label })
            });
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'No se pudo agregar');
            }

            if (this.sessionLabelInput) this.sessionLabelInput.value = '';
            await this.loadSessions();
            this.showStatus(`Sesión "${label}" guardada`, 'success');
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async importConnectedSessions() {
        try {
            const response = await fetch('/api/sessions/import-connected', { method: 'POST' });
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'Importación fallida');
            }
            await this.loadSessions();
            this.showStatus(data.message || 'Importación completada', 'success');
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async removeSession(sessionId) {
        const label = this.getSessionLabel(sessionId);
        if (!confirm(`¿Quitar la sesión "${label}" de la configuración?`)) return;

        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
                method: 'DELETE'
            });
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'No se pudo eliminar');
            }
            await this.loadSessions();
            this.showStatus(`Sesión "${label}" eliminada`, 'success');
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async loadConfig() {
        try {
            const response = await fetch('/config');
            const config = await response.json();

            if (config.success) {
                this.testMode = config.testMode;
                this.whatsappProvider = config.whatsappProvider || 'openwa';
                if (Array.isArray(config.sessions)) {
                    this.configuredSessions = config.sessions;
                    this.renderSessionUI();
                }
                this.updateTestModeDisplay();
            }
        } catch (error) {
            console.error('Error cargando configuración:', error);
        }
    }

    updateTestModeDisplay() {
        const footer = document.querySelector('footer');
        const isOpenWA = this.whatsappProvider === 'openwa';

        // Mostrar u ocultar el botón de verificar sesiones según el modo
        if (this.openWhatsAppBtn) {
            this.openWhatsAppBtn.style.display = this.testMode ? 'none' : 'inline-block';
            if (!this.testMode && isOpenWA) {
                this.openWhatsAppBtn.textContent = 'Verificar sesiones OpenWA';
            }
        }

        if (this.testMode) {
            footer.innerHTML = `
                <div style="background: #fef3c7; color: #92400e; padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #fbbf24;">
                    🧪 <strong>Modo de Prueba Activado</strong><br>
                    Los mensajes de WhatsApp se simularán. No se enviarán por OpenWA.
                </div>
                <p>Asegúrate de tener configurada tu API key de DeepSeek</p>
                <p>Para cambiar a modo producción, edita TEST_MODE=false en el archivo .env</p>
            `;
        } else if (isOpenWA) {
            footer.innerHTML = `
                <div style="background: #dbeafe; color: #1e40af; padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #93c5fd;">
                    <strong>OpenWA</strong><br>
                    Los mensajes se envían vía API OpenWA. Verifica que las sesiones estén conectadas en el dashboard antes de enviar.
                </div>
                <div style="background: #d1fae5; color: #065f46; padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #10b981;">
                    🚀 <strong>Modo Producción</strong><br>
                    Los mensajes se enviarán realmente por WhatsApp.
                </div>
                <p>Asegúrate de tener configurada tu API key de DeepSeek y OPENWA_API_KEY en .env. Las sesiones WhatsApp se configuran arriba y se guardan en el servidor.</p>
            `;
        } else {
            footer.innerHTML = `
                <div style="background: #d1fae5; color: #065f46; padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #10b981;">
                    🚀 <strong>Modo Producción</strong><br>
                    Los mensajes se enviarán realmente por WhatsApp.
                </div>
                <p>Asegúrate de tener configurada tu API key de DeepSeek</p>
                <p>WhatsApp se abrirá automáticamente cuando envíes mensajes</p>
            `;
        }
    }

    handleDragOver(e) {
        e.preventDefault();
        this.dropzone.classList.add('dragover');
    }

    handleDragLeave(e) {
        e.preventDefault();
        this.dropzone.classList.remove('dragover');
    }

    handleDrop(e) {
        e.preventDefault();
        this.dropzone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files).filter(file =>
            file.type === 'application/pdf'
        );
        this.processSelectedFiles(files);
    }

    handleFileSelect(e) {
        const files = Array.from(e.target.files).filter(file =>
            file.type === 'application/pdf'
        );
        this.processSelectedFiles(files);
    }

    processSelectedFiles(files) {
        if (files.length === 0) {
            this.showStatus('Solo se pueden cargar archivos PDF', 'error');
            return;
        }

        if (files.length > 100) {
            this.showStatus('Máximo 100 archivos por carga', 'error');
            return;
        }

        // Verificar tamaño de archivos
        const oversizedFiles = files.filter(file => file.size > 10 * 1024 * 1024);
        if (oversizedFiles.length > 0) {
            this.showStatus(`Los siguientes archivos exceden 10MB: ${oversizedFiles.map(f => f.name).join(', ')}`, 'error');
            return;
        }

        this.selectedFiles = files;
        this.displaySelectedFiles();
        this.showStatus(`${files.length} archivos seleccionados`, 'success');
    }

    displaySelectedFiles() {
        this.fileItems.innerHTML = '';
        this.selectedFiles.forEach((file, index) => {
            const li = document.createElement('li');
            li.innerHTML = `
                <strong>${index + 1}.</strong> ${file.name} 
                <span style="color: #7f8c8d;">(${(file.size / 1024 / 1024).toFixed(2)} MB)</span>
            `;
            this.fileItems.appendChild(li);
        });
        this.fileList.style.display = 'block';
    }

    async uploadFiles() {
        if (this.selectedFiles.length === 0) {
            this.showStatus('No hay archivos seleccionados', 'error');
            return;
        }

        this.showLoading('Procesando archivos PDF...');

        const formData = new FormData();
        this.selectedFiles.forEach(file => {
            formData.append('cvs', file);
        });

        try {
            const response = await fetch('/upload-cvs', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (result.success) {
                this.cvsData = result.cvs;
                this.displayResults();
                this.showStatus(result.message, 'success');
                this.generateMessagesBtn.disabled = false;
            } else {
                this.showStatus(`Error: ${result.message}`, 'error');
            }

        } catch (error) {
            console.error('Error uploading files:', error);
            this.showStatus(`Error de conexión: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    displayResults() {
        this.cvsTableBody.innerHTML = '';

        this.cvsData.forEach((cv, index) => {
            const row = document.createElement('tr');
            row.className = 'fade-in';

            const estadoClass = cv.procesado ? 'procesado' : 'error';
            const estadoText = cv.procesado ? 'Procesado' : 'Error';

            const mensajeId = `mensaje-${index}`;
            const mensajeTexto = cv.mensajeIA || 'Pendiente de generar...';

            // Escapar HTML para seguridad pero preservar saltos de línea
            const mensajeEscapado = mensajeTexto
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');

            // Escapar HTML para nombre, teléfono y experiencia
            const nombreEscapado = (cv.nombre || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
            const telefonoEscapado = (cv.telefono || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
            const experienciaEscapada = (cv.experiencia || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

            row.innerHTML = `
                <td>${cv.archivoOriginal}</td>
                <td class="nombre-cell editable-cell">
                    <div class="editable-display" id="nombre-display-${index}" data-field="nombre" data-index="${index}">${nombreEscapado || '(sin nombre)'}</div>
                    <input type="text" class="editable-input" id="nombre-input-${index}" data-field="nombre" data-index="${index}" value="${(cv.nombre || '').replace(/"/g, '&quot;')}" style="display: none;">
                </td>
                <td class="telefono-cell editable-cell">
                    <div class="editable-display" id="telefono-display-${index}" data-field="telefono" data-index="${index}">${telefonoEscapado || '(sin teléfono)'}</div>
                    <input type="text" class="editable-input" id="telefono-input-${index}" data-field="telefono" data-index="${index}" value="${(cv.telefono || '').replace(/"/g, '&quot;')}" style="display: none;">
                </td>
                <td class="experiencia-cell editable-cell">
                    <div class="editable-display" id="experiencia-display-${index}" data-field="experiencia" data-index="${index}">${experienciaEscapada || '(sin experiencia)'}</div>
                    <textarea class="editable-input editable-textarea" id="experiencia-input-${index}" data-field="experiencia" data-index="${index}" style="display: none;" rows="3">${(cv.experiencia || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                </td>
                <td class="mensaje-ia-cell">
                    <div class="mensaje-display" id="display-${mensajeId}">${mensajeEscapado}</div>
                    <textarea class="mensaje-edit" id="edit-${mensajeId}" style="display: none;" rows="6">${mensajeTexto}</textarea>
                </td>
                <td class="acciones-cell">
                    <button class="btn-edit-mensaje" data-index="${index}" data-mensaje-id="${mensajeId}" title="Editar mensaje">
                        ✏️ Editar
                    </button>
                    <button class="btn-save-mensaje" data-index="${index}" data-mensaje-id="${mensajeId}" style="display: none;" title="Guardar cambios">
                        💾 Guardar
                    </button>
                    <button class="btn-cancel-edit" data-index="${index}" data-mensaje-id="${mensajeId}" style="display: none;" title="Cancelar">
                        ❌ Cancelar
                    </button>
                </td>
                <td class="estado ${estadoClass}">${estadoText}</td>
            `;

            this.cvsTableBody.appendChild(row);

            // Configurar edición con doble clic para nombre, teléfono y experiencia
            // Los elementos ya están en el DOM después de appendChild e innerHTML
            this.setupEditableField(row, index, 'nombre', cv.nombre || '');
            this.setupEditableField(row, index, 'telefono', cv.telefono || '');
            this.setupEditableField(row, index, 'experiencia', cv.experiencia || '');

            // Agregar event listeners para editar/guardar mensaje
            const editBtn = row.querySelector('.btn-edit-mensaje');
            const saveBtn = row.querySelector('.btn-save-mensaje');
            const cancelBtn = row.querySelector('.btn-cancel-edit');
            const displayDiv = row.querySelector(`#display-${mensajeId}`);
            const editTextarea = row.querySelector(`#edit-${mensajeId}`);

            editBtn.addEventListener('click', () => {
                displayDiv.style.display = 'none';
                editTextarea.style.display = 'block';
                editBtn.style.display = 'none';
                saveBtn.style.display = 'inline-block';
                cancelBtn.style.display = 'inline-block';
                editTextarea.focus();
            });

            saveBtn.addEventListener('click', () => {
                const nuevoMensaje = editTextarea.value.trim();
                if (nuevoMensaje) {
                    // Actualizar en cvsData
                    this.cvsData[index].mensajeIA = nuevoMensaje;
                    // Actualizar display (escapar HTML pero preservar saltos de línea)
                    const mensajeEscapado = nuevoMensaje
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#039;');
                    displayDiv.innerHTML = mensajeEscapado;
                    displayDiv.style.display = 'block';
                    editTextarea.style.display = 'none';
                    editBtn.style.display = 'inline-block';
                    saveBtn.style.display = 'none';
                    cancelBtn.style.display = 'none';
                    this.showStatus('Mensaje guardado correctamente', 'success');
                } else {
                    this.showStatus('El mensaje no puede estar vacío', 'error');
                }
            });

            cancelBtn.addEventListener('click', () => {
                // Restaurar valor original
                editTextarea.value = mensajeTexto;
                displayDiv.style.display = 'block';
                editTextarea.style.display = 'none';
                editBtn.style.display = 'inline-block';
                saveBtn.style.display = 'none';
                cancelBtn.style.display = 'none';
            });
        });

        this.resultsSection.style.display = 'block';
    }

    /**
     * Configura un campo editable con doble clic
     * @param {HTMLElement} row - Fila de la tabla
     * @param {number} index - Índice del CV en cvsData
     * @param {string} fieldName - Nombre del campo ('nombre', 'telefono', 'experiencia')
     * @param {string} originalValue - Valor original del campo
     */
    setupEditableField(row, index, fieldName, originalValue) {
        // Intentar múltiples formas de encontrar los elementos
        const displayDiv = row.querySelector(`#${fieldName}-display-${index}`) || 
                          row.querySelector(`[data-field="${fieldName}"][data-index="${index}"].editable-display`);
        const inputElement = row.querySelector(`#${fieldName}-input-${index}`) || 
                            row.querySelector(`[data-field="${fieldName}"][data-index="${index}"].editable-input`);
        const isTextarea = fieldName === 'experiencia';

        if (!displayDiv || !inputElement) {
            console.error(`No se encontraron elementos para ${fieldName}-${index}`, { 
                displayDiv, 
                inputElement,
                rowHTML: row.innerHTML.substring(0, 200)
            });
            return;
        }

        // Debug: verificar que los elementos existen
        if (displayDiv && inputElement) {
            console.log(`✅ Campo editable configurado: ${fieldName}-${index}`);
        }

        // Guardar valor original
        let savedValue = originalValue;
        let isCancelling = false;

        // Función para escapar HTML
        const escapeHtml = (text) => {
            return (text || '').replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        };

        // Función para activar modo edición
        const activateEdit = () => {
            displayDiv.style.display = 'none';
            inputElement.style.display = 'block';
            inputElement.value = savedValue;
            inputElement.focus();
            inputElement.select();
            isCancelling = false;
        };

        // Función para guardar cambios
        const saveEdit = () => {
            if (isCancelling) return;
            
            const newValue = inputElement.value.trim();
            savedValue = newValue;
            
            // Actualizar en cvsData
            this.cvsData[index][fieldName] = newValue;
            
            // Actualizar display
            displayDiv.innerHTML = escapeHtml(newValue) || '(vacío)';
            displayDiv.style.display = 'block';
            inputElement.style.display = 'none';
            
            this.showStatus(`${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} guardado correctamente`, 'success');
        };

        // Función para cancelar edición
        const cancelEdit = () => {
            isCancelling = true;
            inputElement.value = savedValue;
            displayDiv.style.display = 'block';
            inputElement.style.display = 'none';
            // Resetear flag después de un pequeño delay
            setTimeout(() => {
                isCancelling = false;
            }, 100);
        };

        // Doble clic para editar
        displayDiv.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault();
            console.log(`Doble clic detectado en ${fieldName}-${index}`);
            activateEdit();
        });

        // Manejar teclas
        inputElement.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !isTextarea) {
                e.preventDefault();
                saveEdit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
            } else if (e.key === 'Enter' && e.ctrlKey && isTextarea) {
                // Ctrl+Enter para guardar en textarea
                e.preventDefault();
                saveEdit();
            }
        });

        // Guardar al perder el foco (pero no si se canceló)
        inputElement.addEventListener('blur', () => {
            // Pequeño delay para permitir que Escape se procese primero
            setTimeout(() => {
                if (!isCancelling) {
                    saveEdit();
                }
            }, 200);
        });

        // Prevenir que el doble clic se propague
        displayDiv.style.cursor = 'pointer';
        displayDiv.title = 'Doble clic para editar';
    }

    async generateMessages() {
        if (this.cvsData.length === 0) {
            this.showStatus('No hay CVs procesados', 'error');
            return;
        }

        this.showLoading('Iniciando generación de mensajes con IA...');
        this.generateMessagesBtn.disabled = true;
        this.progressSection.style.display = 'block';
        this.progressFill.style.width = '0%';
        this.progressText.textContent = '0 / 0';

        try {
            const response = await fetch('/generate-messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const result = await response.json();

            if (response.status === 409) {
                this.showStatus('Ya hay una generación en curso. Espera a que termine.', 'info');
                await this.waitForGenerationComplete(result.generation?.total || this.cvsData.length);
                return;
            }

            if (!response.ok || !result.started) {
                const errMsg = result.error || result.message || 'No se pudo iniciar la generación';
                this.showStatus(`Error: ${errMsg}`, 'error');
                return;
            }

            this.progressText.textContent = `0 / ${result.total}`;
            await this.waitForGenerationComplete(result.total);
        } catch (error) {
            console.error('Error generating messages:', error);
            this.showStatus(`Error de conexión: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
            this.generateMessagesBtn.disabled = false;
        }
    }

    async waitForGenerationComplete(total) {
        const pollIntervalMs = 2000;

        while (true) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

            let status;
            try {
                const statusRes = await fetch('/generation-status');
                status = await statusRes.json();
            } catch (error) {
                console.warn('Error consultando estado de generación:', error);
                continue;
            }

            if (status.inProgress) {
                const current = status.current || 0;
                const progressTotal = status.total || total;
                const label = status.nombre ? `: ${status.nombre}` : '';
                this.loadingText.textContent = `Generando mensaje ${current}/${progressTotal}${label}...`;
                const progress = progressTotal > 0 ? (current / progressTotal) * 100 : 0;
                this.progressFill.style.width = `${progress}%`;
                this.progressText.textContent = `${current} / ${progressTotal}`;
                continue;
            }

            if (status.error) {
                this.showStatus(`Error generando mensajes: ${status.error}`, 'error');
                this.progressSection.style.display = 'none';
                return;
            }

            try {
                const cvsRes = await fetch('/cvs-status');
                const cvsResult = await cvsRes.json();
                if (cvsResult.success && Array.isArray(cvsResult.cvs)) {
                    this.cvsData = cvsResult.cvs;
                    this.displayResults();
                }
            } catch (error) {
                console.warn('Error cargando CVs generados:', error);
            }

            const doneTotal = status.total || total;
            this.progressFill.style.width = '100%';
            this.progressText.textContent = `${doneTotal} / ${doneTotal}`;
            this.showStatus(`Se generaron mensajes de IA para ${doneTotal} CVs`, 'success');
            this.sendWhatsAppBtn.disabled = false;
            this.progressSection.style.display = 'none';
            return;
        }
    }

    async sendWhatsApp() {
        const cvsToSend = this.cvsData.filter(cv =>
            cv.procesado &&
            cv.mensajeIA &&
            cv.mensajeIA.trim() !== '' &&
            cv.telefono !== 'No encontrado'
        );

        if (cvsToSend.length === 0) {
            this.showStatus('No hay CVs válidos para enviar', 'error');
            return;
        }

        const selectedSessions = this.getSelectedSessionIds();
        if (selectedSessions.length === 0) {
            this.showStatus('Marca al menos una sesión para enviar mensajes', 'error');
            return;
        }

        const sessionLabels = selectedSessions.map((s) => this.getSessionLabel(s)).join(', ');
        let confirmMessage = `¿Estás seguro de enviar ${cvsToSend.length} mensajes por WhatsApp?\n\n`;
        if (this.testMode) {
            confirmMessage += '🧪 MODO PRUEBA: Los mensajes se simularán (no se abrirá WhatsApp Web).';
        } else {
            if (selectedSessions.length > 1) {
                confirmMessage += `📱 Envío paralelo entre ${selectedSessions.length} sesiones: ${sessionLabels}\n`;
                confirmMessage += 'Cada celular envía su primer mensaje al mismo tiempo.\n';
                confirmMessage += 'Luego cada sesión espera su propio tiempo aleatorio (1-5 min).\n';
            } else {
                confirmMessage += `Se usará la sesión: ${sessionLabels}.\n`;
                confirmMessage += 'Se enviará con delay aleatorio de 1-5 minutos entre cada mensaje.';
            }
            confirmMessage += '\nAsegúrate de tener las sesiones verificadas en OpenWA.';
        }

        if (!confirm(confirmMessage)) {
            return;
        }

        // Deshabilitar botones y mostrar controles inmediatamente
        this.sendWhatsAppBtn.disabled = true;
        this.generateMessagesBtn.disabled = true;

        // Mostrar controles de envío inmediatamente (sin esperar respuesta del servidor)
        this.showSendingControls();
        this.showStatus(this.testMode ? 'Simulando envío...' : 'Iniciando envío de mensajes...', 'info');

        this.activeSendingSessionIds = [...selectedSessions];
        this.activeControlSessionId =
            selectedSessions.length > 1 ? '__roundrobin__' : selectedSessions[0];

        this.initSessionSendingPanel(selectedSessions);
        this.showProgress(cvsToSend.length);

        try {
            const response = await fetch('/send-whatsapp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    cvs: this.cvsData,
                    selectedSessions
                })
            });

            const result = await response.json();

            if (response.status === 409) {
                this.showStatus('Ya hay un envío en curso. Mostrando progreso...', 'info');
                await this.waitForSendComplete(result.sendJob?.total || cvsToSend.length);
                return;
            }

            if (result.allSkippedOrEmpty) {
                this.showStatus(result.message, 'success');
                this.sendWhatsAppBtn.disabled = false;
                this.generateMessagesBtn.disabled = false;
                this.hideSendingControls();
                this.hideSessionSendingPanel();
                this.progressSection.style.display = 'none';
                return;
            }

            if (!response.ok || (!result.started && !result.success)) {
                const errMsg = result.error || result.message || 'No se pudo iniciar el envío';
                this.showStatus(`Error: ${errMsg}`, 'error');
                this.sendWhatsAppBtn.disabled = false;
                this.generateMessagesBtn.disabled = false;
                this.hideSendingControls();
                this.hideSessionSendingPanel();
                return;
            }

            if (result.started) {
                this.playNotificationSound();
                if (result.skippedAlreadyContacted?.length > 0) {
                    this.addLogEntry(
                        `${result.skippedAlreadyContacted.length} contacto(s) omitidos (ya contactados)`,
                        'info'
                    );
                }
                await this.waitForSendComplete(result.total);
                return;
            }

            // Respuesta síncrona legacy (por compatibilidad)
            if (result.success) {
                let message = result.message;
                if (result.testMode) {
                    message += ' (Modo de Prueba)';
                }
                this.showStatus(message, 'success');
                this.playNotificationSound();
                this.finalizeSendingProgress(result.results || []);
            } else {
                this.showStatus(`Error: ${result.message}`, 'error');
                this.sendWhatsAppBtn.disabled = false;
                this.generateMessagesBtn.disabled = false;
                this.hideSendingControls();
                this.hideSessionSendingPanel();
            }

        } catch (error) {
            console.error('Error sending WhatsApp:', error);
            this.showStatus(`Error de conexión: ${error.message}`, 'error');
            this.sendWhatsAppBtn.disabled = false;
            this.generateMessagesBtn.disabled = false;
            this.hideSendingControls();
            this.hideSessionSendingPanel();
        }
    }

    async waitForSendComplete(total) {
        const pollIntervalMs = 3000;
        let seenInProgress = false;

        while (true) {
            if (this.sendJobCompleted) {
                const status = this.sendJobCompleted;
                this.sendJobCompleted = null;
                this.applySendJobResult(status);
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

            try {
                const res = await fetch('/send-job-status');
                const status = await res.json();

                if (status.inProgress || status.anyInProgress) {
                    seenInProgress = true;
                    continue;
                }

                if (status.error) {
                    this.showStatus(`Error: ${status.error}`, 'error');
                    this.sendWhatsAppBtn.disabled = false;
                    this.generateMessagesBtn.disabled = false;
                    this.hideSendingControls();
                    this.hideSessionSendingPanel();
                    this.disconnectFromEvents();
                    return;
                }

                if (status.completedAt || (seenInProgress && status.results)) {
                    this.applySendJobResult(status);
                    return;
                }
            } catch (error) {
                console.warn('Error consultando estado de envío:', error);
            }
        }
    }

    applySendJobResult(status) {
        let message = status.message || 'Envío completado';
        if (status.testMode) {
            message += ' (Modo de Prueba)';
        }
        this.showStatus(message, 'success');
        this.finalizeSendingProgress(status.results || []);
    }

    initSessionSendingPanel(sessionIds) {
        if (!this.sessionSendingPanel || !this.sessionSendingCards) return;

        this.sessionLiveState = {};
        sessionIds.forEach((id) => {
            this.sessionLiveState[id] = {
                phase: 'starting',
                sessionCurrent: 0,
                sessionTotal: 0
            };
        });

        this.sessionSendingCards.innerHTML = sessionIds
            .map((id) => {
                const label = this.getSessionLabel(id);
                return `
                <div class="session-sending-card" data-session-id="${id}">
                    <h3>${label}</h3>
                    <div class="session-sending-status" id="sessionStatus-${id}">Iniciando...</div>
                    <div class="session-sending-progress" id="sessionProgress-${id}">—</div>
                    <div class="session-sending-actions">
                        <button type="button" class="btn btn-warning btn-session-pause" data-session-id="${id}">⏸️ Pausar</button>
                        <button type="button" class="btn btn-secondary btn-session-resume" data-session-id="${id}" style="display:none;">▶️ Reanudar</button>
                        <button type="button" class="btn btn-info btn-session-skip" data-session-id="${id}">⏩ Siguiente</button>
                        <button type="button" class="btn btn-danger btn-session-abort" data-session-id="${id}">🛑 Parar</button>
                    </div>
                </div>`;
            })
            .join('');

        this.sessionSendingPanel.style.display = 'block';

        this.sessionSendingCards.querySelectorAll('.btn-session-pause').forEach((btn) => {
            btn.addEventListener('click', () => this.pauseSending(btn.dataset.sessionId));
        });
        this.sessionSendingCards.querySelectorAll('.btn-session-resume').forEach((btn) => {
            btn.addEventListener('click', () => this.resumeSending(btn.dataset.sessionId));
        });
        this.sessionSendingCards.querySelectorAll('.btn-session-skip').forEach((btn) => {
            btn.addEventListener('click', () => this.skipWaitSending(btn.dataset.sessionId));
        });
        this.sessionSendingCards.querySelectorAll('.btn-session-abort').forEach((btn) => {
            btn.addEventListener('click', () => this.abortSending(btn.dataset.sessionId));
        });
    }

    hideSessionSendingPanel() {
        if (this.sessionSendingPanel) {
            this.sessionSendingPanel.style.display = 'none';
        }
        if (this.sessionSendingCards) {
            this.sessionSendingCards.innerHTML = '';
        }
        this.sessionLiveState = {};
    }

    formatWaitTime(remainingMs) {
        const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        if (min > 0 && sec > 0) return `${min}m ${sec}s`;
        if (min > 0) return `${min}m`;
        return `${sec}s`;
    }

    updateSessionCard(sessionId, data = {}) {
        const state = { ...(this.sessionLiveState[sessionId] || {}), ...data };
        this.sessionLiveState[sessionId] = state;

        const statusEl = document.getElementById(`sessionStatus-${sessionId}`);
        const progressEl = document.getElementById(`sessionProgress-${sessionId}`);
        const card = this.sessionSendingCards?.querySelector(`[data-session-id="${sessionId}"]`);
        if (!statusEl || !progressEl) return;

        let statusText = 'En espera...';
        if (state.phase === 'starting') statusText = 'Iniciando envío...';
        else if (state.phase === 'sending') {
            statusText = state.nombre
                ? `Enviando a <strong>${state.nombre}</strong> (${state.telefono || ''})`
                : 'Enviando mensaje...';
        } else if (state.phase === 'waiting') {
            const wait = state.remainingMs != null ? this.formatWaitTime(state.remainingMs) : '...';
            statusText = state.nombre
                ? `Esperando <strong>${wait}</strong> → próximo: ${state.nombre}`
                : `Esperando <strong>${wait}</strong> para el siguiente mensaje`;
        } else if (state.phase === 'paused') {
            statusText = '⏸️ Envío pausado';
        } else if (state.phase === 'time_paused') {
            statusText = '⏸️ Tiempo de espera pausado';
        } else if (state.phase === 'sent') {
            statusText = state.nombre
                ? `✓ Enviado a ${state.nombre}`
                : '✓ Mensaje enviado';
        } else if (state.phase === 'done') {
            statusText = '✅ Cola completada';
        } else if (state.phase === 'aborted') {
            statusText = '🛑 Detenido';
        }

        statusEl.innerHTML = statusText;

        if (state.sessionTotal > 0) {
            progressEl.textContent = `Progreso: ${state.sessionCurrent || 0} / ${state.sessionTotal}`;
        } else {
            progressEl.textContent = '—';
        }

        if (card) {
            const pauseBtn = card.querySelector('.btn-session-pause');
            const resumeBtn = card.querySelector('.btn-session-resume');
            const isPaused = state.phase === 'paused' || state.sendingPaused;
            if (pauseBtn && resumeBtn) {
                pauseBtn.style.display = isPaused ? 'none' : 'inline-block';
                resumeBtn.style.display = isPaused ? 'inline-block' : 'none';
            }
        }
    }

    finalizeSendingProgress(results) {
        this.addLogEntry('Envío completado', 'success');
        this.hideSendingControls();
        this.hideSessionSendingPanel();
        this.disconnectFromEvents();
        this.sendWhatsAppBtn.disabled = false;
        this.generateMessagesBtn.disabled = false;

        if (!results.length) return;

        const total = results.length;
        let sentCount = 0;
        results.forEach((result, index) => {
            sentCount++;
            const progress = (sentCount / total) * 100;
            this.progressFill.style.width = `${progress}%`;
            this.progressText.textContent = `${sentCount} / ${total}`;
            const sessionLabel = result.sessionId ? this.getSessionLabel(result.sessionId) : '';
            const viaSession = sessionLabel ? ` · ${sessionLabel}` : '';
            this.currentMessage.innerHTML = `
                <strong>Enviado a:</strong> ${result.nombre}${viaSession}<br>
                <strong>Teléfono:</strong> ${result.telefono}<br>
                <strong>Estado:</strong> ${result.success ? 'Enviado' : 'Error'}
            `;
            if (result.mensajeIA) {
                this.showMessagePreview(result.mensajeIA);
            }
            this.addLogEntry(
                `${result.nombre} (${result.telefono})${sessionLabel ? ` [${sessionLabel}]` : ''} - ${result.success ? 'Enviado' : 'Error'}`,
                result.success ? 'success' : 'error'
            );
        });
    }

    showProgress(total) {
        this.progressSection.style.display = 'block';
        this.progressFill.style.width = '0%';
        this.progressText.textContent = `0 / ${total}`;
        this.currentMessage.innerHTML = 'Preparando envío...';
        this.logContainer.innerHTML = '';

        // Los controles ya se muestran en showSendingControls() antes de llamar a showProgress
        // this.showSendingControls(); // Ya se muestra antes

        // Ocultar vista previa del mensaje inicialmente
        this.hideMessagePreview();

        // Conectar a eventos en tiempo real para recibir notificaciones
        this.connectToEvents();
    }

    simulateProgress(results) {
        let current = 0;
        const total = results.length;

        const interval = setInterval(() => {
            if (current >= total) {
                clearInterval(interval);
                this.addLogEntry('Envío completado', 'success');
                this.hideSendingControls(); // Ocultar controles al finalizar
                this.disconnectFromEvents(); // Desconectar eventos cuando termine el envío
                this.sendWhatsAppBtn.disabled = false; // Re-habilitar botones
                this.generateMessagesBtn.disabled = false;
                return;
            }

            const result = results[current];
            const progress = ((current + 1) / total) * 100;

            // Reproducir sonido cuando está listo para enviar el siguiente mensaje
            if (current > 0) {
                this.playNotificationSound();
            }

            this.progressFill.style.width = `${progress}%`;
            this.progressText.textContent = `${current + 1} / ${total}`;
            const sessionLabel = result.sessionId ? this.getSessionLabel(result.sessionId) : '';
            const viaSession = sessionLabel ? ` · ${sessionLabel}` : '';
            this.currentMessage.innerHTML = `
                <strong>Enviando a:</strong> ${result.nombre}${viaSession}<br>
                <strong>Teléfono:</strong> ${result.telefono}<br>
                <strong>Estado:</strong> ${result.success ? 'Enviado' : 'Error'}
            `;

            // Mostrar mensaje que se está enviando
            if (result.mensajeIA) {
                this.showMessagePreview(result.mensajeIA);
            }

            this.addLogEntry(
                `${result.nombre} (${result.telefono})${sessionLabel ? ` [${sessionLabel}]` : ''} - ${result.success ? 'Enviado' : 'Error'}`,
                result.success ? 'success' : 'error'
            );

            current++;
        }, 500); // Actualizar cada 500ms para simular progreso
    }

    addLogEntry(message, type = 'info') {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
    }

    async openWhatsApp() {
        if (this.testMode) {
            this.showStatus('No se puede verificar sesiones OpenWA en modo de prueba', 'error');
            return;
        }

        this.openWhatsAppBtn.disabled = true;

        try {
            const response = await fetch('/open-whatsapp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ openAllSessions: true })
            });

            const result = await response.json();

            if (result.success) {
                let msg = result.message || 'Listo';
                if (Array.isArray(result.results) && result.results.length > 1) {
                    const failed = result.results.filter((r) => !r.success);
                    if (failed.length) {
                        msg += ` Fallos: ${failed.map((f) => f.sessionId + (f.error ? ` (${f.error})` : '')).join(', ')}`;
                    }
                }
                this.showStatus(msg, 'success');
            } else {
                this.showStatus(`Error: ${result.error || result.message}`, 'error');
            }

        } catch (error) {
            console.error('Error opening WhatsApp:', error);
            this.showStatus(`Error de conexión: ${error.message}`, 'error');
        } finally {
            this.openWhatsAppBtn.disabled = false;
        }
    }

    async clearData() {
        if (confirm('¿Estás seguro de limpiar todos los datos?')) {
            try {
                const response = await fetch('/clear-data', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const result = await response.json();

                if (result.success) {
                    this.cvsData = [];
                    this.selectedFiles = [];
                    this.fileList.style.display = 'none';
                    this.resultsSection.style.display = 'none';
                    this.progressSection.style.display = 'none';
                    this.generateMessagesBtn.disabled = true;
                    this.sendWhatsAppBtn.disabled = true;
                    this.fileInput.value = '';
                    this.hideSendingControls();
                    this.hideMessagePreview();
                    this.disconnectFromEvents(); // Desconectar eventos al limpiar
                    this.showStatus('Datos limpiados correctamente', 'success');
                }
            } catch (error) {
                console.error('Error clearing data:', error);
                this.showStatus('Error limpiando datos', 'error');
            }
        }
    }

    showStatus(message, type = 'info') {
        this.statusMessage.textContent = message;
        this.statusMessage.className = `status-message ${type}`;
        this.statusMessage.style.display = 'block';

        // Auto-hide después de 5 segundos
        setTimeout(() => {
            this.statusMessage.style.display = 'none';
        }, 5000);
    }

    showLoading(text = 'Procesando...') {
        this.loadingText.textContent = text;
        this.loadingOverlay.style.display = 'flex';
    }

    hideLoading() {
        this.loadingOverlay.style.display = 'none';
    }

    // Configurar controles de envío
    setupSendingControls() {
        this.pauseBtn = document.getElementById('pauseBtn');
        this.resumeBtn = document.getElementById('resumeBtn');
        this.pauseTimeBtn = document.getElementById('pauseTimeBtn');
        this.resumeTimeBtn = document.getElementById('resumeTimeBtn');
        this.skipWaitBtn = document.getElementById('skipWaitBtn');
        this.abortBtn = document.getElementById('abortBtn');
        this.sendingControls = document.getElementById('sendingControls');
        this.messagePreview = document.getElementById('messagePreview');
        this.messageContent = document.getElementById('messageContent');

        console.log('setupSendingControls - sendingControls encontrado:', !!this.sendingControls);
        console.log('setupSendingControls - pauseBtn encontrado:', !!this.pauseBtn);
        console.log('setupSendingControls - pauseTimeBtn encontrado:', !!this.pauseTimeBtn);
        console.log('setupSendingControls - skipWaitBtn encontrado:', !!this.skipWaitBtn);

        if (this.pauseBtn) {
            this.pauseBtn.addEventListener('click', () => this.pauseSending());
        }
        if (this.resumeBtn) {
            this.resumeBtn.addEventListener('click', () => this.resumeSending());
        }
        if (this.pauseTimeBtn) {
            this.pauseTimeBtn.addEventListener('click', () => this.pauseTime());
        }
        if (this.resumeTimeBtn) {
            this.resumeTimeBtn.addEventListener('click', () => this.resumeTime());
        }
        if (this.skipWaitBtn) {
            this.skipWaitBtn.addEventListener('click', () => this.skipWaitSending());
        }
        if (this.abortBtn) {
            this.abortBtn.addEventListener('click', () => this.abortSending());
        }
    }

    // Mostrar controles de envío (solo en producción)
    showSendingControls() {
        console.log('showSendingControls llamado, testMode:', this.testMode);
        console.log('sendingControls existe:', !!this.sendingControls);

        // Verificar si estamos en modo de prueba
        if (!this.testMode) {
            if (this.sendingControls) {
                this.sendingControls.style.display = 'block';
                this.sendingControls.style.visibility = 'visible';
                // Asegurar que los botones estén en el estado correcto
                if (this.pauseBtn) {
                    this.pauseBtn.style.display = 'inline-block';
                    this.pauseBtn.style.visibility = 'visible';
                }
                if (this.resumeBtn) {
                    this.resumeBtn.style.display = 'none';
                }
                if (this.pauseTimeBtn) {
                    this.pauseTimeBtn.style.display = 'inline-block';
                    this.pauseTimeBtn.style.visibility = 'visible';
                }
                if (this.resumeTimeBtn) {
                    this.resumeTimeBtn.style.display = 'none';
                }
                if (this.skipWaitBtn) {
                    this.skipWaitBtn.style.display = 'inline-block';
                    this.skipWaitBtn.style.visibility = 'visible';
                }
                if (this.abortBtn) {
                    this.abortBtn.style.display = 'inline-block';
                    this.abortBtn.style.visibility = 'visible';
                }
                console.log('Controles configurados, display:', this.sendingControls.style.display);
            } else {
                console.error('sendingControls no encontrado!');
            }
        } else {
            console.log('En modo prueba, no se muestran controles');
        }
    }

    // Ocultar controles de envío
    hideSendingControls() {
        if (this.sendingControls) {
            this.sendingControls.style.display = 'none';
        }
        if (this.messagePreview) {
            this.messagePreview.style.display = 'none';
        }
    }

    // Pausar envío
    async pauseSending(sessionId = null) {
        try {
            const targetSession = sessionId || this.getControlSessionId();
            const response = await fetch('/pause-sending', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionId: targetSession })
            });

            const result = await response.json();

            if (result.success) {
                if (sessionId) {
                    this.updateSessionCard(sessionId, { phase: 'paused', sendingPaused: true });
                } else {
                    this.pauseBtn.style.display = 'none';
                    this.resumeBtn.style.display = 'inline-block';
                }
                this.addLogEntry(`⏸️ Envío pausado${sessionId ? ` (${this.getSessionLabel(sessionId)})` : ''}`, 'warning');
            } else {
                this.showStatus(result.error, 'error');
            }
        } catch (error) {
            console.error('Error pausing sending:', error);
            this.showStatus('Error pausando envío', 'error');
        }
    }

    // Reanudar envío
    async resumeSending(sessionId = null) {
        try {
            const targetSession = sessionId || this.getControlSessionId();
            const response = await fetch('/resume-sending', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionId: targetSession })
            });

            const result = await response.json();

            if (result.success) {
                if (sessionId) {
                    this.updateSessionCard(sessionId, { phase: 'waiting', sendingPaused: false });
                } else {
                    this.pauseBtn.style.display = 'inline-block';
                    this.resumeBtn.style.display = 'none';
                }
                this.addLogEntry(`▶️ Envío reanudado${sessionId ? ` (${this.getSessionLabel(sessionId)})` : ''}`, 'success');
            } else {
                this.showStatus(result.error, 'error');
            }
        } catch (error) {
            console.error('Error resuming sending:', error);
            this.showStatus('Error reanudando envío', 'error');
        }
    }

    // Pausar el tiempo de espera
    async pauseTime() {
        try {
            const sessionId = this.getControlSessionId();
            const response = await fetch('/pause-time', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionId })
            });

            const result = await response.json();

            if (result.success) {
                this.pauseTimeBtn.style.display = 'none';
                this.resumeTimeBtn.style.display = 'inline-block';
                this.addLogEntry('⏸️  Tiempo de espera pausado', 'warning');
                this.showStatus('Tiempo de espera pausado', 'success');
            } else {
                this.showStatus(result.error, 'error');
            }
        } catch (error) {
            console.error('Error pausing time:', error);
            this.showStatus('Error pausando tiempo', 'error');
        }
    }

    // Reanudar el tiempo de espera
    async resumeTime() {
        try {
            const sessionId = this.getControlSessionId();
            const response = await fetch('/resume-time', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionId })
            });

            const result = await response.json();

            if (result.success) {
                this.pauseTimeBtn.style.display = 'inline-block';
                this.resumeTimeBtn.style.display = 'none';
                this.addLogEntry('▶️ Tiempo de espera reanudado', 'success');
                this.showStatus('Tiempo de espera reanudado', 'success');
            } else {
                this.showStatus(result.error, 'error');
            }
        } catch (error) {
            console.error('Error resuming time:', error);
            this.showStatus('Error reanudando tiempo', 'error');
        }
    }

    // Enviar siguiente mensaje manualmente (saltar espera)
    async skipWaitSending(sessionId = null) {
        try {
            const targetSession = sessionId || this.getControlSessionId();
            const response = await fetch('/skip-wait', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionId: targetSession })
            });

            const result = await response.json();

            if (result.success) {
                this.pauseTimeBtn.style.display = 'inline-block';
                this.resumeTimeBtn.style.display = 'none';
                const label = sessionId ? this.getSessionLabel(sessionId) : 'todas las sesiones';
                this.addLogEntry(`⏩ Saltando espera en ${label}`, 'info');
                this.showStatus('El siguiente mensaje se enviará inmediatamente', 'success');
            } else {
                this.showStatus(result.error, 'error');
            }
        } catch (error) {
            console.error('Error skipping wait:', error);
            this.showStatus('Error saltando espera', 'error');
        }
    }

    // Abortar envío
    async abortSending(sessionId = null) {
        const targetSession = sessionId || this.getControlSessionId();
        const isGlobal = targetSession === '__roundrobin__';
        const confirmMsg = isGlobal
            ? '¿Abortar el envío en TODAS las sesiones?'
            : `¿Parar el envío en ${this.getSessionLabel(targetSession)}?`;

        if (!confirm(confirmMsg)) return;

        try {
            const response = await fetch('/abort-sending', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionId: targetSession })
            });

            const result = await response.json();

            if (result.success) {
                if (isGlobal) {
                    Object.keys(this.sessionLiveState).forEach((id) => {
                        this.updateSessionCard(id, { phase: 'aborted' });
                    });
                    this.addLogEntry('🛑 Envío abortado en todas las sesiones', 'error');
                    this.sendWhatsAppBtn.disabled = false;
                    this.generateMessagesBtn.disabled = false;
                    this.hideSendingControls();
                    this.hideSessionSendingPanel();
                    this.disconnectFromEvents();
                } else {
                    this.updateSessionCard(targetSession, { phase: 'aborted' });
                    this.addLogEntry(`🛑 Envío detenido en ${this.getSessionLabel(targetSession)}`, 'error');
                }
            } else {
                this.showStatus(result.error, 'error');
            }
        } catch (error) {
            console.error('Error aborting sending:', error);
            this.showStatus('Error abortando envío', 'error');
        }
    }

    // Mostrar mensaje que se está enviando
    showMessagePreview(mensaje) {
        if (this.messagePreview && this.messageContent) {
            this.messageContent.textContent = mensaje;
            this.messagePreview.style.display = 'block';
        }
    }

    // Ocultar vista previa del mensaje
    hideMessagePreview() {
        if (this.messagePreview) {
            this.messagePreview.style.display = 'none';
        }
    }

    // Reproducir sonido de notificación
    playNotificationSound() {
        if (this.notificationSound) {
            // Resetear el audio al inicio para poder reproducirlo múltiples veces
            this.notificationSound.currentTime = 0;
            this.notificationSound.play().catch(error => {
                console.log('No se pudo reproducir el sonido:', error);
                // Algunos navegadores requieren interacción del usuario primero
            });
        }
    }

    // Conectar a Server-Sent Events para recibir notificaciones en tiempo real
    connectToEvents() {
        // Cerrar conexión anterior si existe
        if (this.eventSource) {
            this.eventSource.close();
        }

        // Crear nueva conexión SSE
        this.eventSource = new EventSource('/events');

        // Escuchar evento cuando está listo para enviar el siguiente mensaje
        this.eventSource.addEventListener('readyToSend', (event) => {
            const data = JSON.parse(event.data);

            // Filtrar eventos por sesión seleccionada
            const activeIds = this.activeSendingSessionIds || [];
            if (
                data.sessionId &&
                activeIds.length > 0 &&
                !activeIds.includes(data.sessionId) &&
                data.sessionId !== this.activeControlSessionId
            ) {
                return;
            }

            console.log('🔔 Listo para enviar mensaje:', data);

            if (data.sessionId && activeIds.includes(data.sessionId)) {
                this.updateSessionCard(data.sessionId, {
                    phase: 'sending',
                    nombre: data.nombre,
                    telefono: data.telefono,
                    sessionCurrent: data.sessionCurrent,
                    sessionTotal: data.sessionTotal
                });
            }

            // Reproducir sonido de notificación
            this.playNotificationSound();

            // Actualizar la interfaz si es necesario
            if (data.nombre) {
                const sessionLabel = data.sessionId ? this.getSessionLabel(data.sessionId) : '';
                this.addLogEntry(
                    `🔔 ${sessionLabel ? `[${sessionLabel}] ` : ''}Enviando a ${data.nombre}`,
                    'info'
                );
                if (this.currentMessage) {
                    this.currentMessage.innerHTML = `
                        <strong>Enviando a:</strong> ${data.nombre}${sessionLabel ? ` (${sessionLabel})` : ''}<br>
                        <strong>Teléfono:</strong> ${data.telefono}<br>
                        <strong>Estado:</strong> Enviando...
                    `;
                }
                if (this.progressText && data.total) {
                    this.progressText.textContent = `${data.current} / ${data.total}`;
                    const progress = (data.current / data.total) * 100;
                    if (this.progressFill) {
                        this.progressFill.style.width = `${progress}%`;
                    }
                }
            }
        });

        this.eventSource.addEventListener('waitProgress', (event) => {
            const data = JSON.parse(event.data);
            if (!data.sessionId) return;
            this.updateSessionCard(data.sessionId, {
                phase: data.phase || 'waiting',
                remainingMs: data.remainingMs,
                totalWaitMs: data.totalWaitMs
            });
        });

        this.eventSource.addEventListener('sessionProgress', (event) => {
            const data = JSON.parse(event.data);
            if (!data.sessionId) return;

            if (data.phase === 'waiting') {
                this.updateSessionCard(data.sessionId, {
                    phase: 'waiting',
                    nombre: data.nombre,
                    telefono: data.telefono,
                    sessionCurrent: data.sessionCurrent,
                    sessionTotal: data.sessionTotal
                });
            } else if (data.phase === 'sent') {
                this.updateSessionCard(data.sessionId, {
                    phase: 'sent',
                    nombre: data.nombre,
                    telefono: data.telefono,
                    sessionCurrent: data.sessionCurrent,
                    sessionTotal: data.sessionTotal
                });
                if (this.progressText && data.total) {
                    this.progressText.textContent = `${data.current} / ${data.total}`;
                    const progress = (data.current / data.total) * 100;
                    if (this.progressFill) {
                        this.progressFill.style.width = `${progress}%`;
                    }
                }
            } else if (data.phase === 'done') {
                this.updateSessionCard(data.sessionId, {
                    phase: 'done',
                    sessionCurrent: data.sessionTotal,
                    sessionTotal: data.sessionTotal
                });
            }
        });

        this.eventSource.addEventListener('sendComplete', async (event) => {
            try {
                const res = await fetch('/send-job-status');
                const status = await res.json();
                this.sendJobCompleted = status;
            } catch (error) {
                console.warn('Error cargando resultado de envío:', error);
            }
        });

        this.eventSource.addEventListener('sendError', (event) => {
            const data = JSON.parse(event.data);
            this.showStatus(`Error en envío: ${data.error}`, 'error');
            this.sendWhatsAppBtn.disabled = false;
            this.generateMessagesBtn.disabled = false;
            this.hideSendingControls();
            this.hideSessionSendingPanel();
            this.disconnectFromEvents();
        });

        // Manejar errores de conexión
        this.eventSource.onerror = (error) => {
            console.error('Error en conexión de eventos:', error);
            // Intentar reconectar después de un delay
            setTimeout(() => {
                if (this.eventSource && this.eventSource.readyState === EventSource.CLOSED) {
                    this.connectToEvents();
                }
            }, 5000);
        };
    }

    // Desconectar de eventos
    disconnectFromEvents() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }
}

// Inicializar la aplicación cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    new CVAnalyzer();
});

// Las sesiones WhatsApp se gestionan en el dashboard de OpenWA (no hay Chrome local que cerrar)
window.closeWhatsApp = async function () {
    alert(
        'Las sesiones WhatsApp se gestionan en el dashboard de OpenWA (openwa.protalentconnections.com). ' +
            'Este botón no aplica en la versión OpenWA.'
    );
};
