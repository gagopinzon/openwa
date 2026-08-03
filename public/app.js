class CVAnalyzer {
    constructor() {
        this.selectedFiles = [];
        this.cvsData = [];
        this.testMode = false;
        this.whatsappProvider = 'openwa';
        this.configuredSessions = [];
        this.currentUser = window.__pendingAuthUser || null;
        this.managedUsers = [];
        this.panelConfig = {
            configured: false,
            publicCvUrlConfigured: false,
            gerenteEmail: '',
            baseUrl: ''
        };
        this.disponibilidadCache = null;
        this.disponibilidadCacheAt = 0;
        this.agendarCvIndex = null;
        this.eventSource = null;
        this.sendJobCompleted = null;
        this.initializeElements();
        this.initAutoReplyElements();
        this.initUsersElements();
        this.initPanelProfile();
        this.initAgendarModal();
        this.initDisponibilidadCalendar();
        this.initAgendaPendingPanel();
        this.attachEventListeners();
        this.setupSendingControls();
        this.applyPermissionUI();
        this.loadConfig().then(async () => {
            await this.loadSessions();
            await this.refreshCvsFromServer({ silent: true });
            await this.refreshSendQueue();
            if (this.isSuperUser() || this.getControllableSessions().length > 0) {
                this.loadAutoReplyStatus();
                this.loadAutoReplyConfig();
                this.applyAutoReplyRoleUI();
            }
            this.loadIncomingInbox();
            this.connectToEvents();
            if (this.isSuperUser()) {
                this.loadUsers();
            }
            this.loadDisponibilidadCalendar({ silent: true });
        });
        window.cvAnalyzer = this;
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
        this.sessionWeightPreview = document.getElementById('sessionWeightPreview');
        this.sessionWeightSum = document.getElementById('sessionWeightSum');
        this.distributeWeightsEquallyBtn = document.getElementById('distributeWeightsEquallyBtn');
        this.sessionsList = document.getElementById('sessionsList');
        this.sessionsEmptyHint = document.getElementById('sessionsEmptyHint');
        this.openwaSessionPicker = document.getElementById('openwaSessionPicker');
        this.sessionLabelInput = document.getElementById('sessionLabelInput');
        this.addSessionBtn = document.getElementById('addSessionBtn');
        this.importConnectedBtn = document.getElementById('importConnectedBtn');
        this.refreshOpenwaListBtn = document.getElementById('refreshOpenwaListBtn');
        this.clearDataBtn = document.getElementById('clearDataBtn');
        this.enqueueBtn = document.getElementById('enqueueBtn');
        this.scheduleAtInput = document.getElementById('scheduleAtInput');
        this.sendQueuePanel = document.getElementById('sendQueuePanel');
        this.sendQueueStatus = document.getElementById('sendQueueStatus');
        this.sendQueueMeta = document.getElementById('sendQueueMeta');
        this.dispatchQueueBtn = document.getElementById('dispatchQueueBtn');
        this.cancelQueueBtn = document.getElementById('cancelQueueBtn');
        this.queueState = null;
        this.sendProgressTrackingPromise = null;
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
        this.autoReplyRules = [];

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
        this.enqueueBtn?.addEventListener('click', this.enqueueBatch.bind(this));
        this.dispatchQueueBtn?.addEventListener('click', this.dispatchQueue.bind(this));
        this.cancelQueueBtn?.addEventListener('click', this.cancelQueue.bind(this));
        if (this.addSessionBtn) {
            this.addSessionBtn.addEventListener('click', this.addSession.bind(this));
        }
        if (this.importConnectedBtn) {
            this.importConnectedBtn.addEventListener('click', this.importConnectedSessions.bind(this));
        }
        if (this.refreshOpenwaListBtn) {
            this.refreshOpenwaListBtn.addEventListener('click', this.loadOpenWASessionPicker.bind(this));
        }
        if (this.distributeWeightsEquallyBtn) {
            this.distributeWeightsEquallyBtn.addEventListener('click', () => this.distributeSessionWeightsEqually());
        }
        if (this.abortAllSessionsBtn) {
            this.abortAllSessionsBtn.addEventListener('click', () => this.abortSending('__roundrobin__'));
        }
        this.attachAutoReplyListeners();
        if (this.createUserForm) {
            this.createUserForm.addEventListener('submit', (event) => {
                event.preventDefault();
                this.createUser();
            });
        }
    }

    initUsersElements() {
        this.usersPanel = document.getElementById('usersPanel');
        this.usersList = document.getElementById('usersList');
        this.createUserForm = document.getElementById('createUserForm');
        this.newUserUsername = document.getElementById('newUserUsername');
        this.newUserPassword = document.getElementById('newUserPassword');
        this.newUserGerenteEmail = document.getElementById('newUserGerenteEmail');
        this.newUserPermissions = document.getElementById('newUserPermissions');
        this.usersFormStatus = document.getElementById('usersFormStatus');
        this.sessionsAddForm = document.querySelector('.sessions-add-form');
        this.autoReplyPanel = document.getElementById('autoReplyPanel');
    }

    initPanelProfile() {
        this.panelProfileSection = document.getElementById('panelProfileSection');
        this.myGerenteEmail = document.getElementById('myGerenteEmail');
        this.saveMyGerenteEmailBtn = document.getElementById('saveMyGerenteEmailBtn');
        this.panelProfileStatus = document.getElementById('panelProfileStatus');
        if (this.saveMyGerenteEmailBtn) {
            this.saveMyGerenteEmailBtn.addEventListener('click', () => this.saveMyGerenteEmail());
        }
    }

    setPanelProfileStatus(message, ok = true) {
        if (!this.panelProfileStatus) return;
        if (!message) {
            this.panelProfileStatus.style.display = 'none';
            this.panelProfileStatus.textContent = '';
            return;
        }
        this.panelProfileStatus.style.display = 'block';
        this.panelProfileStatus.textContent = message;
        this.panelProfileStatus.style.color = ok ? '#15803d' : '#b91c1c';
    }

    async saveMyGerenteEmail() {
        const gerenteEmail = this.myGerenteEmail ? this.myGerenteEmail.value.trim() : '';
        try {
            const response = await fetch('/api/me', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gerenteEmail })
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'No se pudo guardar');
            }
            const saved = (data.user && data.user.gerenteEmail) || gerenteEmail;
            if (this.currentUser) {
                this.currentUser.gerenteEmail = saved;
            }
            this.panelConfig.gerenteEmail = saved;
            if (this.myGerenteEmail) this.myGerenteEmail.value = saved;
            this.disponibilidadCacheAt = 0;
            this.setPanelProfileStatus(
                saved
                    ? `Correo guardado: ${saved}. El panel usará este gerente al agendar.`
                    : 'Correo borrado. Usa MSG_GERENTE_EMAIL del .env o escríbelo al agendar.',
                true
            );
            this.showStatus('Correo de gerente actualizado', 'success');
            this.loadDisponibilidadCalendar({ force: true });
        } catch (error) {
            this.setPanelProfileStatus(error.message, false);
        }
    }

    setCurrentUser(user) {
        this.currentUser = user || null;
        if (this.myGerenteEmail && user && user.gerenteEmail != null) {
            this.myGerenteEmail.value = user.gerenteEmail || '';
        }
        this.applyPermissionUI();
        if (this.isSuperUser()) {
            this.loadUsers();
        }
        this.renderSessionUI();
        this.renderNewUserPermissions();
    }

    isSuperUser() {
        return Boolean(this.currentUser && this.currentUser.isSuper);
    }

    getSessionAccess(sessionId) {
        if (this.isSuperUser()) return 'control';
        const session = (this.configuredSessions || []).find((s) => s.id === sessionId);
        if (session && session.access) return session.access;
        const perms = (this.currentUser && this.currentUser.permissions) || {};
        return perms[sessionId] || null;
    }

    canControlSession(sessionId) {
        return this.getSessionAccess(sessionId) === 'control';
    }

    getControllableSessions() {
        return (this.configuredSessions || []).filter((s) => this.canControlSession(s.id));
    }

    applyPermissionUI() {
        const isSuper = this.isSuperUser();
        const hasControl = this.getControllableSessions().length > 0 || isSuper;

        if (this.usersPanel) {
            this.usersPanel.style.display = isSuper ? 'block' : 'none';
        }
        if (this.sessionsAddForm) {
            this.sessionsAddForm.style.display = isSuper ? 'flex' : 'none';
        }
        if (this.openWhatsAppBtn) {
            this.openWhatsAppBtn.style.display = hasControl ? '' : 'none';
        }
        if (this.autoReplyPanel) {
            const showAutoReply = isSuper || this.getControllableSessions().length > 0;
            this.autoReplyPanel.style.display = showAutoReply ? '' : 'none';
        }
        if (this.agendaPendingPanel) {
            this.agendaPendingPanel.style.display = hasControl ? '' : 'none';
            if (hasControl) this.loadAgendaPending();
        }
        this.applyAutoReplyRoleUI();

        const uploadSection = document.querySelector('.upload-section');
        const resultsSection = document.getElementById('resultsSection');
        if (!hasControl) {
            if (uploadSection) uploadSection.style.display = 'none';
            if (resultsSection) resultsSection.style.display = 'none';
        } else if (uploadSection) {
            uploadSection.style.display = '';
        }
    }

    applyAutoReplyRoleUI() {
        const isSuper = this.isSuperUser();
        document.querySelectorAll('.auto-reply-admin-only').forEach((el) => {
            el.style.display = isSuper ? '' : 'none';
        });
        if (this.autoReplyUserHint) {
            this.autoReplyUserHint.style.display = isSuper ? 'none' : '';
        }
    }

    initAutoReplyElements() {
        this.autoReplyPanel = document.getElementById('autoReplyPanel');
        this.autoReplyStatus = document.getElementById('autoReplyStatus');
        this.autoReplyEnabledToggle = document.getElementById('autoReplyEnabledToggle');
        this.activateAutoReplyBtn = document.getElementById('activateAutoReplyBtn');
        this.deactivateAutoReplyBtn = document.getElementById('deactivateAutoReplyBtn');
        this.testAutoReplyBtn = document.getElementById('testAutoReplyBtn');
        this.autoReplyWebhooksPill = document.getElementById('autoReplyWebhooksPill');
        this._autoReplyWebhooksBusy = false;
        this._lastAutoReplyStatus = null;
        this.autoReplyTestPhone = document.getElementById('autoReplyTestPhone');
        this.autoReplyTestMessage = document.getElementById('autoReplyTestMessage');
        this.autoReplyBasePrompt = document.getElementById('autoReplyBasePrompt');
        this.autoReplyRulesList = document.getElementById('autoReplyRulesList');
        this.addAutoReplyRuleBtn = document.getElementById('addAutoReplyRuleBtn');
        this.saveAutoReplyConfigBtn = document.getElementById('saveAutoReplyConfigBtn');
        this.autoReplyConversations = document.getElementById('autoReplyConversations');
        this.autoReplySessionsList = document.getElementById('autoReplySessionsList');
        this.autoReplyGlobalBadge = document.getElementById('autoReplyGlobalBadge');
        this.autoReplyUserHint = document.getElementById('autoReplyUserHint');
        this.autoReplyEnabledSessionIds = null; // null = todas
        this.incomingInboxList = document.getElementById('incomingInboxList');
        this.incomingInboxCount = document.getElementById('incomingInboxCount');
        this.refreshIncomingInboxBtn = document.getElementById('refreshIncomingInboxBtn');
        this.clearIncomingInboxBtn = document.getElementById('clearIncomingInboxBtn');
        this.incomingInboxSoundToggle = document.getElementById('incomingInboxSoundToggle');
        this.incomingInboxIds = new Set();
        this.conversationsSessionSelect = document.getElementById('conversationsSessionSelect');
        this.refreshConversationsBtn = document.getElementById('refreshConversationsBtn');
        this.conversationsUnreadOnlyToggle = document.getElementById('conversationsUnreadOnlyToggle');
        this.conversationsChatList = document.getElementById('conversationsChatList');
        this.conversationsThreadHeader = document.getElementById('conversationsThreadHeader');
        this.conversationsThreadMessages = document.getElementById('conversationsThreadMessages');
        this.conversationsStatus = document.getElementById('conversationsStatus');
        this.conversationsReplyInput = document.getElementById('conversationsReplyInput');
        this.conversationsReplyBtn = document.getElementById('conversationsReplyBtn');
        this.conversationsThreadActions = document.getElementById('conversationsThreadActions');
        this.conversationsBlockBtn = document.getElementById('conversationsBlockBtn');
        this.conversationsDeleteChatBtn = document.getElementById('conversationsDeleteChatBtn');
        this.conversationsAiPauseBtn = document.getElementById('conversationsAiPauseBtn');
        this.conversationsAgendarBtn = document.getElementById('conversationsAgendarBtn');
        this.conversationsChats = [];
        this.activeConversation = null;
        this.activeConversationBlocked = false;
        this.activeConversationAiPaused = false;
        this.activeConversationKnownContact = false;
        this.activeConversationSessionAiEnabled = true;
        this.activeConversationAutoReplyEnabled = false;
        this.conversationsEverLoaded = false;
        this.conversationsUnreadOnly = false;
        this._conversationsRefreshTimer = null;
        this._conversationsLoadInFlight = false;
        this._conversationsLoadPending = false;
        this._conversationsListPollTimer = null;
        this._conversationsThreadPollTimer = null;
        this._conversationsThreadLoadInFlight = false;
        this._conversationsListPollMs = 20000;
        this._conversationsThreadPollMs = 15000;
    }

    attachAutoReplyListeners() {
        if (this.saveAutoReplyConfigBtn) {
            this.saveAutoReplyConfigBtn.addEventListener('click', () => this.saveAutoReplyConfig());
        }
        if (this.addAutoReplyRuleBtn) {
            this.addAutoReplyRuleBtn.addEventListener('click', () => this.addAutoReplyRule());
        }
        if (this.activateAutoReplyBtn) {
            this.activateAutoReplyBtn.addEventListener('click', () => this.activateAutoReply());
        }
        if (this.deactivateAutoReplyBtn) {
            this.deactivateAutoReplyBtn.addEventListener('click', () => this.deactivateAutoReply());
        }
        if (this.testAutoReplyBtn) {
            this.testAutoReplyBtn.addEventListener('click', () => this.testAutoReply());
        }
        if (this.autoReplyEnabledToggle) {
            this.autoReplyEnabledToggle.addEventListener('change', () => {
                this.saveAutoReplyConfig({ silent: true, enabledOnly: true });
            });
        }
        if (this.refreshIncomingInboxBtn) {
            this.refreshIncomingInboxBtn.addEventListener('click', () => this.loadIncomingInbox());
        }
        if (this.clearIncomingInboxBtn) {
            this.clearIncomingInboxBtn.addEventListener('click', () => this.clearIncomingInbox());
        }
        if (this.refreshConversationsBtn) {
            this.refreshConversationsBtn.addEventListener('click', () => this.loadConversationsChats());
        }
        if (this.conversationsUnreadOnlyToggle) {
            this.conversationsUnreadOnlyToggle.addEventListener('change', () => {
                this.conversationsUnreadOnly = Boolean(this.conversationsUnreadOnlyToggle.checked);
                this.renderConversationsChatList();
                this.updateConversationsStatus();
            });
        }
        if (this.conversationsSessionSelect) {
            this.conversationsSessionSelect.addEventListener('change', () => {
                this.activeConversation = null;
                this.setConversationsReplyEnabled(false);
                if (this.conversationsThreadHeader) {
                    this.conversationsThreadHeader.textContent = 'Selecciona un chat';
                }
                if (this.conversationsThreadMessages) {
                    this.conversationsThreadMessages.innerHTML =
                        '<p class="auto-reply-empty">Aquí verás el historial de la conversación.</p>';
                }
                this.activeConversation = null;
                this.activeConversationBlocked = false;
                this.activeConversationAiPaused = false;
                this.activeConversationKnownContact = false;
                this.updateConversationThreadActions();
                this.setConversationsReplyEnabled(false);
                this.loadConversationsChats();
            });
        }
        if (this.conversationsReplyBtn) {
            this.conversationsReplyBtn.addEventListener('click', () => this.sendConversationReply());
        }
        if (this.conversationsReplyInput) {
            this.conversationsReplyInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    this.sendConversationReply();
                }
            });
        }
        if (this.conversationsBlockBtn) {
            this.conversationsBlockBtn.addEventListener('click', () => this.toggleBlockActiveConversation());
        }
        if (this.conversationsDeleteChatBtn) {
            this.conversationsDeleteChatBtn.addEventListener('click', () => this.deleteActiveConversationChat());
        }
        if (this.conversationsAiPauseBtn) {
            this.conversationsAiPauseBtn.addEventListener('click', () => this.toggleAiPauseActiveConversation());
        }
        if (this.conversationsAgendarBtn) {
            this.conversationsAgendarBtn.addEventListener('click', () => this.openAgendarFromConversation());
        }
        if (this.conversationsThreadMessages && !this._conversationActionsBound) {
            this._conversationActionsBound = true;
            this.conversationsThreadMessages.addEventListener('click', (event) => {
                const btn = event.target.closest('.bubble-action-btn');
                if (!btn) return;
                const messageId = btn.dataset.messageId;
                const action = btn.dataset.action;
                if (!messageId || !action) return;
                if (action === 'edit') {
                    let body = '';
                    try {
                        body = decodeURIComponent(btn.dataset.body || '');
                    } catch {
                        body = btn.dataset.body || '';
                    }
                    this.editConversationMessage(messageId, body);
                }
                if (action === 'delete') this.deleteConversationMessage(messageId);
            });
        }
        document.querySelectorAll('.accordion-header').forEach((btn) => {
            btn.addEventListener('click', () => this.toggleAccordion(btn));
        });
    }

    toggleAccordion(button) {
        const item = button.closest('.accordion-item');
        if (!item) return;
        const body = item.querySelector('.accordion-body');
        if (!body) return;
        const isOpen = !body.classList.contains('accordion-body-collapsed');
        body.classList.toggle('accordion-body-collapsed', isOpen);
        item.classList.toggle('accordion-item-open', !isOpen);
    }

    getWebhookActivationState(data) {
        const sessions = Number(data.sessionsConfigured) || 0;
        const active = Number(data.webhooksActive) || 0;
        if (active <= 0) return { key: 'off', label: 'Webhooks: inactivos', detail: 'No hay webhooks registrados en OpenWA' };
        if (sessions > 0 && active >= sessions) {
            return {
                key: 'on',
                label: `Webhooks: activos (${active}/${sessions})`,
                detail: 'OpenWA está enviando mensajes entrantes a esta app'
            };
        }
        return {
            key: 'partial',
            label: `Webhooks: parcial (${active}/${sessions || '?'})`,
            detail: 'Solo algunas sesiones tienen webhook; vuelve a Activar webhooks'
        };
    }

    updateWebhookControlsUI(data, options = {}) {
        const busy = Boolean(options.busy);
        this._autoReplyWebhooksBusy = busy;
        const state = data ? this.getWebhookActivationState(data) : { key: 'off', label: 'Webhooks: inactivos' };
        const canActivate = Boolean(data && (data.canListen || data.canActivate));
        const activeCount = Number(data?.webhooksActive) || 0;

        if (this.autoReplyWebhooksPill) {
            this.autoReplyWebhooksPill.textContent = busy
                ? options.busyLabel || 'Webhooks: procesando…'
                : state.label;
            this.autoReplyWebhooksPill.className = `auto-reply-pill ${busy ? 'is-busy' : `is-${state.key}`}`;
        }

        if (this.activateAutoReplyBtn) {
            this.activateAutoReplyBtn.disabled = busy || !canActivate;
            this.activateAutoReplyBtn.textContent = busy && options.mode === 'activate'
                ? 'Activando…'
                : activeCount > 0
                  ? 'Reactivar webhooks'
                  : 'Activar webhooks';
            this.activateAutoReplyBtn.classList.toggle('is-active-state', !busy && activeCount > 0);
            this.activateAutoReplyBtn.title = canActivate
                ? 'Registra en OpenWA la URL para recibir mensajes entrantes'
                : 'Configura WEBHOOK_PUBLIC_URL y al menos una sesión';
        }

        if (this.deactivateAutoReplyBtn) {
            this.deactivateAutoReplyBtn.disabled = busy || activeCount <= 0;
            this.deactivateAutoReplyBtn.textContent = busy && options.mode === 'deactivate'
                ? 'Desactivando…'
                : 'Desactivar webhooks';
            this.deactivateAutoReplyBtn.classList.toggle('is-active-state', !busy && activeCount <= 0);
            this.deactivateAutoReplyBtn.title =
                activeCount > 0
                    ? 'Elimina los webhooks registrados en OpenWA'
                    : 'No hay webhooks activos para desactivar';
        }
    }

    async loadAutoReplyStatus() {
        if (!this.autoReplyStatus) return;
        try {
            const response = await fetch('/api/auto-reply/status');
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Error de estado');
            this._lastAutoReplyStatus = data;

            const state = this.getWebhookActivationState(data);
            let html = `<span class="webhook-state-line">${this.escapeHtml(state.label)}</span>`;
            html += `${this.escapeHtml(state.detail)}<br>`;
            if (!data.webhookConfigured) {
                html += '<strong>WEBHOOK_PUBLIC_URL</strong> no configurado en el servidor. Sin esto no llegan mensajes a la bandeja.<br>';
            } else {
                html += `URL: <code>${this.escapeHtml(data.webhookUrl)}</code><br>`;
            }
            if (!data.mongodbConfigured) {
                html += 'MongoDB no configurado: la bandeja sí funciona; la auto-respuesta IA no filtrará contactos.<br>';
            }
            html += `Sesiones: ${data.sessionsConfigured}`;
            if (typeof data.enabledSessionsCount === 'number') {
                html += ` · Líneas IA: ${data.enabledSessionsCount}/${data.sessionsConfigured}`;
            }
            if (data.enabled) {
                html += ' · <strong>Auto-respuesta ON</strong>';
            } else {
                html += ' · Auto-respuesta global OFF';
            }

            const statusClass =
                state.key === 'on' ? 'ok' : state.key === 'partial' ? 'ok' : 'warning';
            this.autoReplyStatus.innerHTML = html;
            this.autoReplyStatus.className = `auto-reply-status ${
                data.canListen || data.canActivate ? statusClass : 'warning'
            }`;

            this.updateWebhookControlsUI(data);

            if (this.autoReplyGlobalBadge) {
                const on = Boolean(data.enabled);
                this.autoReplyGlobalBadge.textContent = on
                    ? 'Auto-respuesta global: activa'
                    : 'Auto-respuesta global: inactiva (solo el admin puede encenderla)';
                this.autoReplyGlobalBadge.className = `auto-reply-status ${on ? 'ok' : 'warning'}`;
            }
        } catch (error) {
            this.autoReplyStatus.innerHTML = `Error cargando estado: ${this.escapeHtml(error.message)}`;
            this.autoReplyStatus.className = 'auto-reply-status warning';
            this.updateWebhookControlsUI(null);
        }
    }

    async loadIncomingInbox() {
        if (!this.incomingInboxList) return;
        try {
            const response = await fetch('/api/incoming-messages?limit=200');
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Error cargando bandeja');
            this.incomingInboxIds = new Set();
            this.incomingInboxList.innerHTML = '';
            const messages = data.messages || [];
            if (!messages.length) {
                this.incomingInboxList.innerHTML =
                    '<p class="auto-reply-empty">Aún no hay mensajes. Activa los webhooks y espera respuestas en los celulares.</p>';
            } else {
                messages.forEach((msg) => this.appendIncomingMessage(msg, { prepend: false, playSound: false }));
            }
            this.updateIncomingInboxCount(messages.length);
        } catch (error) {
            console.error('Error cargando bandeja:', error);
            this.incomingInboxList.innerHTML = `<p class="auto-reply-empty">Error: ${this.escapeHtml(error.message)}</p>`;
        }
    }

    async clearIncomingInbox() {
        if (!confirm('¿Limpiar toda la bandeja de mensajes entrantes?')) return;
        try {
            const response = await fetch('/api/incoming-messages', { method: 'DELETE' });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo limpiar');
            this.incomingInboxIds = new Set();
            if (this.incomingInboxList) {
                this.incomingInboxList.innerHTML =
                    '<p class="auto-reply-empty">Bandeja limpia. Los nuevos mensajes aparecerán aquí.</p>';
            }
            this.updateIncomingInboxCount(0);
            this.showStatus('Bandeja limpiada', 'success');
        } catch (error) {
            this.showStatus(error.message, 'error');
        }
    }

    updateIncomingInboxCount(n) {
        if (!this.incomingInboxCount) return;
        const count = typeof n === 'number' ? n : this.incomingInboxIds.size;
        this.incomingInboxCount.textContent = `${count} mensaje${count === 1 ? '' : 's'}`;
    }

    appendIncomingMessage(item, options = {}) {
        if (!this.incomingInboxList || !item) return;
        const id = item.id || `${item.telefono}_${item.timestamp}`;
        if (this.incomingInboxIds.has(id)) return;
        this.incomingInboxIds.add(id);

        const empty = this.incomingInboxList.querySelector('.auto-reply-empty');
        if (empty) empty.remove();

        const sessionLabel = item.sessionId
            ? this.getSessionLabel(item.sessionId)
            : item.openwaSessionId || 'Sesión';
        const phone = item.telefono || item.chatId || 'desconocido';
        const name = item.contactName ? ` · ${item.contactName}` : '';
        const when = new Date(item.timestamp || Date.now()).toLocaleString();
        const reasonLabels = {
            auto_reply_disabled: 'IA global off',
            session_ai_disabled: 'IA off en esta línea',
            ai_paused_for_contact: 'IA pausada (humano)',
            unknown_contact: 'contacto desconocido',
            lid_without_phone: 'WhatsApp LID sin teléfono',
            wrong_session_for_contact: 'sesión incorrecta',
            no_text_body: 'sin texto',
            is_group: 'grupo',
            duplicate: 'duplicado',
            chat_busy: 'chat ocupado',
            mongodb_not_configured: 'sin MongoDB'
        };
        const reasonText =
            item.autoReplyReason && reasonLabels[item.autoReplyReason]
                ? reasonLabels[item.autoReplyReason]
                : item.autoReplyReason;
        const replyHint = item.replyMessage
            ? `<div class="reply-hint">Auto-respuesta enviada</div>`
            : item.autoReplyReason && item.autoReplyReason !== 'replied'
              ? `<div class="reply-hint" style="color:#92400e">Sin auto-respuesta (${this.escapeHtml(reasonText)})</div>`
              : '';

        const el = document.createElement('div');
        el.className = `incoming-inbox-item fade-in${options.highlight ? ' is-new' : ''}`;
        el.dataset.id = id;
        el.innerHTML = `
            <div class="meta">
                <span class="phone">${this.escapeHtml(phone)}${this.escapeHtml(name)}</span>
                <span class="session-tag">${this.escapeHtml(sessionLabel)}</span>
                <span>${this.escapeHtml(when)}</span>
            </div>
            <div class="body">${this.escapeHtml(item.body || '')}</div>
            ${replyHint}
        `;

        if (options.prepend === false) {
            this.incomingInboxList.appendChild(el);
        } else {
            this.incomingInboxList.prepend(el);
        }

        this.updateIncomingInboxCount();

        if (options.highlight) {
            setTimeout(() => el.classList.remove('is-new'), 4000);
        }
        if (options.playSound && this.incomingInboxSoundToggle && this.incomingInboxSoundToggle.checked) {
            this.playNotificationSound();
        }
    }

    populateConversationsSessionSelect() {
        if (!this.conversationsSessionSelect) return;
        const prev = this.conversationsSessionSelect.value || 'all';
        this.conversationsSessionSelect.innerHTML = '';

        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = 'Todas las sesiones';
        this.conversationsSessionSelect.appendChild(allOpt);

        if (!this.configuredSessions.length) {
            return;
        }
        this.configuredSessions.forEach((s) => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.label || s.id;
            this.conversationsSessionSelect.appendChild(opt);
        });
        if (prev === 'all' || this.configuredSessions.some((s) => s.id === prev)) {
            this.conversationsSessionSelect.value = prev;
        } else {
            this.conversationsSessionSelect.value = 'all';
        }
    }

    formatConversationTime(ts) {
        if (ts == null || ts === '') return '';
        const n = Number(ts);
        if (!Number.isFinite(n) || n <= 0) return '';
        const ms = String(Math.trunc(n)).length <= 10 ? n * 1000 : n;
        try {
            return new Date(ms).toLocaleString();
        } catch {
            return '';
        }
    }

    setConversationsReplyEnabled(enabled) {
        const canReply =
            enabled &&
            this.activeConversation &&
            this.canControlSession(this.activeConversation.sessionId);
        if (this.conversationsReplyInput) {
            this.conversationsReplyInput.disabled = !canReply;
            if (!canReply) this.conversationsReplyInput.value = '';
            this.conversationsReplyInput.placeholder = canReply
                ? 'Escribe una respuesta…'
                : 'Solo lectura en esta sesión';
        }
        if (this.conversationsReplyBtn) {
            this.conversationsReplyBtn.disabled = !canReply;
        }
    }

    updateConversationsStatus(extra = {}) {
        if (!this.conversationsStatus) return;
        const sessionId = (this.conversationsSessionSelect && this.conversationsSessionSelect.value) || 'all';
        const unreadTotal = this.conversationsChats.reduce(
            (sum, c) => sum + (Number(c.unreadCount) || 0),
            0
        );
        const unreadChats = this.conversationsChats.filter((c) => (Number(c.unreadCount) || 0) > 0).length;
        const visible = this.getVisibleConversationsChats().length;
        const statusParts = [
            this.conversationsUnreadOnly
                ? `${visible} no leídos`
                : `${this.conversationsChats.length} chats`
        ];
        if (!this.conversationsUnreadOnly && unreadChats > 0) {
            statusParts.push(`${unreadChats} sin leer (${unreadTotal})`);
        }
        if (sessionId === 'all' && extra.sessionCount != null) {
            statusParts.push(`${extra.sessionCount} sesiones`);
        }
        if (extra.errCount) statusParts.push(`${extra.errCount} con error`);
        if (extra.suffix) statusParts.push(extra.suffix);
        this.conversationsStatus.textContent = statusParts.join(' · ');
    }

    getVisibleConversationsChats() {
        if (!this.conversationsUnreadOnly) return this.conversationsChats;
        return this.conversationsChats.filter((c) => (Number(c.unreadCount) || 0) > 0);
    }

    scheduleConversationsRefresh(delayMs = 600) {
        if (!this.conversationsEverLoaded) return;
        if (this._conversationsRefreshTimer) clearTimeout(this._conversationsRefreshTimer);
        this._conversationsRefreshTimer = setTimeout(() => {
            this._conversationsRefreshTimer = null;
            this.loadConversationsChats({ silent: true });
            if (this.activeConversation) {
                this.refreshActiveConversationMessages({ silent: true });
            }
        }, delayMs);
    }

    startConversationsPolling() {
        if (!this._conversationsListPollTimer) {
            this._conversationsListPollTimer = setInterval(() => {
                if (document.hidden) return;
                if (!this.conversationsEverLoaded) return;
                this.loadConversationsChats({ silent: true });
            }, this._conversationsListPollMs);
        }

        if (!this._conversationsThreadPollTimer) {
            this._conversationsThreadPollTimer = setInterval(() => {
                if (document.hidden) return;
                if (!this.activeConversation) return;
                this.refreshActiveConversationMessages({ silent: true });
            }, this._conversationsThreadPollMs);
        }
    }

    stopConversationsPolling() {
        if (this._conversationsListPollTimer) {
            clearInterval(this._conversationsListPollTimer);
            this._conversationsListPollTimer = null;
        }
        if (this._conversationsThreadPollTimer) {
            clearInterval(this._conversationsThreadPollTimer);
            this._conversationsThreadPollTimer = null;
        }
    }

    sameConversationChatId(a, b) {
        const left = String(a || '').trim().toLowerCase();
        const right = String(b || '').trim().toLowerCase();
        if (!left || !right) return false;
        if (left === right) return true;
        const strip = (id) => id.replace(/@.*$/, '').replace(/\D/g, '');
        const la = strip(left);
        const lb = strip(right);
        return Boolean(la && lb && la === lb);
    }

    /**
     * Actualiza la lista/hilo de conversaciones cuando el webhook llega por SSE.
     */
    handleConversationIncomingMessage(msg) {
        if (!msg || msg.fromMe) return;
        if (!this.conversationsEverLoaded && !this.conversationsChats.length) {
            return;
        }

        const selectedSession =
            (this.conversationsSessionSelect && this.conversationsSessionSelect.value) || 'all';
        if (
            selectedSession !== 'all' &&
            msg.sessionId &&
            String(msg.sessionId) !== String(selectedSession)
        ) {
            return;
        }

        const chatId = msg.chatId || null;
        const isActive =
            this.activeConversation &&
            this.sameConversationChatId(this.activeConversation.chatId, chatId) &&
            (!msg.sessionId ||
                String(this.activeConversation.sessionId) === String(msg.sessionId));

        if (isActive && this.conversationsThreadMessages) {
            const empty = this.conversationsThreadMessages.querySelector('.auto-reply-empty');
            if (empty) empty.remove();
            const bubble = document.createElement('div');
            bubble.className = 'conv-bubble incoming';
            const time = msg.timestamp
                ? this.formatConversationTime(
                      Math.floor(new Date(msg.timestamp).getTime() / 1000)
                  ) || new Date(msg.timestamp).toLocaleString()
                : new Date().toLocaleString();
            bubble.innerHTML = `
                ${this.escapeHtml(msg.body || '')}
                ${time ? `<span class="bubble-time">${this.escapeHtml(time)}</span>` : ''}
            `;
            this.conversationsThreadMessages.appendChild(bubble);
            this.conversationsThreadMessages.scrollTop =
                this.conversationsThreadMessages.scrollHeight;
        }

        let chat = this.conversationsChats.find(
            (c) =>
                this.sameConversationChatId(c.id, chatId) &&
                (!msg.sessionId || String(c.sessionId) === String(msg.sessionId))
        );

        if (!chat && chatId) {
            const session =
                this.configuredSessions.find((s) => s.id === msg.sessionId) || null;
            chat = {
                id: chatId,
                name: msg.contactName || chatId,
                sessionId: msg.sessionId || selectedSession,
                sessionLabel:
                    (session && (session.label || session.id)) ||
                    msg.sessionId ||
                    'Sesión',
                openwaSessionId: msg.openwaSessionId || null,
                key: `${msg.sessionId || selectedSession}::${chatId}`,
                lastMessage: msg.body || '',
                timestamp: msg.timestamp
                    ? Math.floor(new Date(msg.timestamp).getTime() / 1000)
                    : Math.floor(Date.now() / 1000),
                unreadCount: isActive ? 0 : 1,
                isGroup: Boolean(msg.isGroup)
            };
            this.conversationsChats.unshift(chat);
        } else if (chat) {
            chat.lastMessage = msg.body || chat.lastMessage || '';
            chat.timestamp = msg.timestamp
                ? Math.floor(new Date(msg.timestamp).getTime() / 1000)
                : Math.floor(Date.now() / 1000);
            if (msg.contactName && (!chat.name || chat.name === chat.id)) {
                chat.name = msg.contactName;
            }
            if (!isActive) {
                chat.unreadCount = (Number(chat.unreadCount) || 0) + 1;
            }
            this.conversationsChats.sort(
                (a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)
            );
        }

        this.renderConversationsChatList();
        this.updateConversationsStatus({ suffix: 'en vivo' });
    }

    async loadConversationsChats(options = {}) {
        const silent = Boolean(options.silent);
        if (!this.conversationsChatList || !this.conversationsSessionSelect) {
            console.error('Conversaciones: faltan elementos del DOM');
            if (!silent) {
                this.showStatus('No se encontró el panel de conversaciones. Recarga forzada (Ctrl+F5).', 'error');
            }
            return;
        }
        if (!this.configuredSessions.length) {
            if (!silent) {
                this.conversationsChatList.innerHTML =
                    '<p class="auto-reply-empty">Configura al menos una sesión primero.</p>';
                this.showStatus('Configura sesiones antes de cargar chats', 'error');
            }
            return;
        }
        if (silent && this._conversationsLoadInFlight) {
            this._conversationsLoadPending = true;
            return;
        }

        const sessionId = this.conversationsSessionSelect.value || 'all';

        this._conversationsLoadInFlight = true;
        this._conversationsLoadPending = false;
        if (this.refreshConversationsBtn) this.refreshConversationsBtn.disabled = true;
        if (!silent) {
            if (this.conversationsStatus) {
                this.conversationsStatus.textContent = 'Cargando chats…';
            }
            this.conversationsChatList.innerHTML =
                '<p class="auto-reply-empty">Cargando chats desde OpenWA…</p>';
        } else if (this.conversationsStatus) {
            this.conversationsStatus.textContent = 'Actualizando…';
        }
        console.log('[conversations] fetch', sessionId, silent ? '(silent)' : '');

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        // Varias sesiones en paralelo pueden tardar más
        const timer = controller ? setTimeout(() => controller.abort(), 90000) : null;

        try {
            const response = await fetch(
                `/api/conversations?sessionId=${encodeURIComponent(sessionId)}&limit=120`,
                controller ? { signal: controller.signal } : undefined
            );
            const raw = await response.text();
            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                throw new Error(
                    response.status === 401 || response.status === 302
                        ? 'Sesión expirada: vuelve a iniciar sesión'
                        : `Respuesta inválida del servidor (HTTP ${response.status})`
                );
            }
            if (!response.ok || !data.success) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }

            this.conversationsChats = data.chats || [];
            this.conversationsEverLoaded = true;
            this.startConversationsPolling();
            if (this.activeConversation) {
                const active = this.conversationsChats.find(
                    (c) =>
                        (c.key || `${c.sessionId}::${c.id}`) === this.activeConversation.key ||
                        (this.sameConversationChatId(c.id, this.activeConversation.chatId) &&
                            String(c.sessionId) === String(this.activeConversation.sessionId))
                );
                if (active) active.unreadCount = 0;
            }
            this.renderConversationsChatList();

            const errCount = (data.errors || []).length;
            this.updateConversationsStatus({
                errCount,
                sessionCount: sessionId === 'all' ? (data.sessions || []).length : null
            });
            console.log('[conversations] OK', this.conversationsChats.length, data.errors || []);
            if (!silent) {
                this.showStatus(
                    errCount
                        ? `Cargados ${this.conversationsChats.length} chats (${errCount} sesión(es) fallaron)`
                        : `Cargados ${this.conversationsChats.length} chats`,
                    errCount ? 'error' : 'success'
                );
            }
        } catch (error) {
            const msg =
                error.name === 'AbortError'
                    ? 'Tiempo agotado al cargar chats (OpenWA no respondió)'
                    : error.message || String(error);
            console.error('[conversations] error', error);
            if (!silent) {
                this.conversationsChatList.innerHTML = `<p class="auto-reply-empty">Error: ${this.escapeHtml(msg)}</p>`;
                if (this.conversationsStatus) {
                    this.conversationsStatus.textContent = 'Error';
                }
                this.showStatus(msg, 'error');
            } else if (this.conversationsStatus) {
                this.updateConversationsStatus({ suffix: 'sync falló' });
            }
        } finally {
            if (timer) clearTimeout(timer);
            this._conversationsLoadInFlight = false;
            if (this.refreshConversationsBtn) this.refreshConversationsBtn.disabled = false;
            if (this._conversationsLoadPending) {
                this._conversationsLoadPending = false;
                this.loadConversationsChats({ silent: true });
            }
        }
    }

    renderConversationsChatList() {
        if (!this.conversationsChatList) return;
        const chats = this.getVisibleConversationsChats();
        if (!this.conversationsChats.length) {
            this.conversationsChatList.innerHTML =
                '<p class="auto-reply-empty">No hay chats en estas sesiones.</p>';
            return;
        }
        if (!chats.length) {
            this.conversationsChatList.innerHTML = this.conversationsUnreadOnly
                ? '<p class="auto-reply-empty">No hay conversaciones sin leer.</p>'
                : '<p class="auto-reply-empty">No hay chats en estas sesiones.</p>';
            return;
        }

        const activeKey = this.activeConversation && this.activeConversation.key;
        this.conversationsChatList.innerHTML = '';
        chats.forEach((chat) => {
            const key = chat.key || `${chat.sessionId}::${chat.id}`;
            const hasUnread = (Number(chat.unreadCount) || 0) > 0;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `conversations-chat-item${activeKey === key ? ' active' : ''}${hasUnread ? ' has-unread' : ''}`;
            const unread = hasUnread
                ? `<span class="unread">${chat.unreadCount}</span>`
                : '';
            const sessionLabel = chat.sessionLabel || chat.sessionId || '';
            btn.innerHTML = `
                <span class="chat-session">${this.escapeHtml(sessionLabel)}</span>
                <div class="chat-name">${this.escapeHtml(chat.name || chat.id)}</div>
                <div class="chat-preview">${this.escapeHtml(chat.lastMessage || '')}</div>
                <div class="chat-meta">
                    <span>${this.escapeHtml(this.formatConversationTime(chat.timestamp))}</span>
                    ${unread}
                </div>
            `;
            btn.addEventListener('click', () => this.openConversationChat(chat));
            this.conversationsChatList.appendChild(btn);
        });
    }

    async openConversationChat(chat) {
        if (!chat || !chat.id || !chat.sessionId) return;
        const key = chat.key || `${chat.sessionId}::${chat.id}`;
        this.activeConversation = {
            key,
            chatId: chat.id,
            sessionId: chat.sessionId,
            sessionLabel: chat.sessionLabel || chat.sessionId,
            name: chat.name || chat.id,
            isGroup: Boolean(chat.isGroup)
        };
        this.activeConversationBlocked = false;
        this.activeConversationAiPaused = false;
        this.activeConversationKnownContact = false;
        this.activeConversationSessionAiEnabled = true;
        this.activeConversationAutoReplyEnabled = false;
        // Al abrir, marcar como leído en la UI (OpenWA actualizará en el próximo sync)
        chat.unreadCount = 0;
        this.renderConversationsChatList();
        this.updateConversationsStatus();
        this.setConversationsReplyEnabled(true);
        this.updateConversationThreadActions();

        if (this.conversationsThreadHeader) {
            this.conversationsThreadHeader.innerHTML = `
                ${this.escapeHtml(this.activeConversation.name)}
                <span class="thread-session">Desde: ${this.escapeHtml(this.activeConversation.sessionLabel)}</span>
            `;
        }
        if (this.conversationsThreadMessages) {
            this.conversationsThreadMessages.innerHTML =
                '<p class="auto-reply-empty">Cargando historial…</p>';
            delete this.conversationsThreadMessages.dataset.lastMessagesHtml;
        }
        if (this.conversationsReplyInput) {
            this.conversationsReplyInput.focus();
        }

        await Promise.all([
            this.refreshActiveConversationMessages({ silent: false }),
            this.refreshActiveConversationBlockStatus()
        ]);
    }

    updateConversationThreadActions() {
        const canControl =
            this.activeConversation && this.canControlSession(this.activeConversation.sessionId);
        const isGroup = Boolean(this.activeConversation && this.activeConversation.isGroup);

        if (this.conversationsThreadActions) {
            this.conversationsThreadActions.style.display = canControl ? 'flex' : 'none';
        }
        if (this.conversationsBlockBtn) {
            this.conversationsBlockBtn.textContent = this.activeConversationBlocked
                ? 'Desbloquear'
                : 'Bloquear';
            this.conversationsBlockBtn.className = this.activeConversationBlocked
                ? 'btn btn-secondary btn-sm'
                : 'btn btn-danger btn-sm';
            this.conversationsBlockBtn.disabled = !canControl || isGroup;
            this.conversationsBlockBtn.style.display = isGroup ? 'none' : '';
        }
        if (this.conversationsDeleteChatBtn) {
            this.conversationsDeleteChatBtn.disabled = !canControl;
            this.conversationsDeleteChatBtn.title =
                'Elimina el chat en WhatsApp y limpia el historial local (también pausa la IA)';
        }
        if (this.conversationsAiPauseBtn) {
            const known = this.activeConversationKnownContact;
            const paused = this.activeConversationAiPaused;
            this.conversationsAiPauseBtn.textContent = paused ? 'Reactivar IA' : 'Pausar IA';
            this.conversationsAiPauseBtn.className = paused
                ? 'btn btn-success btn-sm'
                : 'btn btn-warning btn-sm';
            this.conversationsAiPauseBtn.disabled = !canControl || isGroup || !known;
            this.conversationsAiPauseBtn.style.display = isGroup ? 'none' : '';
            this.conversationsAiPauseBtn.title = !known
                ? 'Solo contactos del historial (mensaje masivo) tienen auto-respuesta IA'
                : paused
                  ? 'Volver a dejar que la IA responda a este remitente'
                  : 'Detener la IA en este chat para contestar tú';
        }
        if (this.conversationsAgendarBtn) {
            this.conversationsAgendarBtn.disabled = !canControl || isGroup;
            this.conversationsAgendarBtn.style.display = isGroup ? 'none' : '';
            this.conversationsAgendarBtn.title = isGroup
                ? 'No se puede agendar desde un grupo'
                : 'Agendar reunión en Panel con este contacto';
        }
    }

    updateActiveConversationHeaderBadges() {
        if (!this.conversationsThreadHeader || !this.activeConversation) return;
        const blockedBadge = this.activeConversationBlocked
            ? '<span class="thread-blocked">Bloqueado</span>'
            : '';
        let aiBadge = '';
        if (!this.activeConversation.isGroup) {
            if (!this.activeConversationSessionAiEnabled) {
                aiBadge = '<span class="thread-ai-line-off">IA off en esta línea</span>';
            } else if (this.activeConversationAiPaused) {
                aiBadge = '<span class="thread-ai-paused">IA pausada (tú contestas)</span>';
            } else if (
                this.activeConversationAutoReplyEnabled &&
                this.activeConversationKnownContact
            ) {
                aiBadge = '<span class="thread-ai-active">IA activa</span>';
            }
        }
        this.conversationsThreadHeader.innerHTML = `
            ${this.escapeHtml(this.activeConversation.name)}
            <span class="thread-session">Desde: ${this.escapeHtml(this.activeConversation.sessionLabel)}</span>
            ${blockedBadge}${aiBadge}
        `;
    }

    async refreshActiveConversationBlockStatus() {
        const active = this.activeConversation;
        if (!active || active.isGroup || String(active.chatId || '').endsWith('@g.us')) {
            this.activeConversationBlocked = false;
            this.activeConversationAiPaused = false;
            this.activeConversationKnownContact = false;
            this.updateConversationThreadActions();
            return;
        }

        try {
            const response = await fetch(
                `/api/conversations/contact-status?sessionId=${encodeURIComponent(active.sessionId)}&chatId=${encodeURIComponent(active.chatId)}`
            );
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo consultar el contacto');
            this.activeConversationBlocked = Boolean(data.isBlocked);
            this.activeConversationAiPaused = Boolean(data.aiPaused);
            this.activeConversationKnownContact = Boolean(data.knownContact);
            this.activeConversationSessionAiEnabled =
                data.sessionAiEnabled !== undefined ? Boolean(data.sessionAiEnabled) : true;
            this.activeConversationAutoReplyEnabled = Boolean(data.autoReplyEnabled);
            this.updateActiveConversationHeaderBadges();
        } catch (error) {
            console.warn('contact-status:', error.message);
        }
        this.updateConversationThreadActions();
    }

    async toggleAiPauseActiveConversation() {
        const active = this.activeConversation;
        if (!active) return;
        if (!this.canControlSession(active.sessionId)) {
            this.showStatus('No tienes permiso de control en esta sesión', 'error');
            return;
        }
        if (active.isGroup || String(active.chatId || '').endsWith('@g.us')) {
            this.showStatus('La IA no se aplica a grupos', 'error');
            return;
        }
        if (!this.activeConversationKnownContact) {
            this.showStatus(
                'Este número no está en el historial; la IA solo responde a contactos del envío masivo',
                'error'
            );
            return;
        }

        const willPause = !this.activeConversationAiPaused;
        const label = active.name || active.chatId;

        try {
            const response = await fetch('/api/conversations/ai-control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: active.sessionId,
                    chatId: active.chatId,
                    aiPaused: willPause
                })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo actualizar la IA');
            this.activeConversationAiPaused = Boolean(data.aiPaused);
            this.updateConversationThreadActions();
            this.updateActiveConversationHeaderBadges();
            this.showStatus(
                willPause
                    ? `IA pausada para ${label}. Puedes contestar tú.`
                    : `IA reactivada para ${label}`,
                'success'
            );
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async toggleBlockActiveConversation() {
        const active = this.activeConversation;
        if (!active) return;
        if (!this.canControlSession(active.sessionId)) {
            this.showStatus('No tienes permiso de control en esta sesión', 'error');
            return;
        }
        if (active.isGroup || String(active.chatId || '').endsWith('@g.us')) {
            this.showStatus('No se pueden bloquear grupos', 'error');
            return;
        }

        const willBlock = !this.activeConversationBlocked;
        const label = active.name || active.chatId;
        if (
            !confirm(
                willBlock
                    ? `¿Bloquear a "${label}" en WhatsApp?`
                    : `¿Desbloquear a "${label}"?`
            )
        ) {
            return;
        }

        try {
            const response = await fetch(
                willBlock ? '/api/conversations/block' : '/api/conversations/unblock',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: active.sessionId,
                        chatId: active.chatId
                    })
                }
            );
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo completar la acción');
            this.activeConversationBlocked = willBlock;
            this.updateConversationThreadActions();
            await this.refreshActiveConversationBlockStatus();
            this.showStatus(
                willBlock ? `Contacto bloqueado: ${label}` : `Contacto desbloqueado: ${label}`,
                'success'
            );
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async deleteActiveConversationChat() {
        const active = this.activeConversation;
        if (!active) return;
        if (!this.canControlSession(active.sessionId)) {
            this.showStatus('No tienes permiso de control en esta sesión', 'error');
            return;
        }

        const label = active.name || active.chatId;
        if (
            !confirm(
                `¿Borrar toda la conversación con "${label}"?\n\nSe elimina el chat en WhatsApp, se limpia el historial local y se pausa la IA para este contacto.`
            )
        ) {
            return;
        }

        try {
            const response = await fetch('/api/conversations/delete-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: active.sessionId,
                    chatId: active.chatId
                })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo borrar el chat');

            this.conversationsChats = (this.conversationsChats || []).filter(
                (c) => !(c.sessionId === active.sessionId && c.chatId === active.chatId)
            );
            this.activeConversation = null;
            this.activeConversationBlocked = false;
            this.activeConversationAiPaused = false;
            this.activeConversationKnownContact = false;
            this.setConversationsReplyEnabled(false);
            if (this.conversationsThreadHeader) {
                this.conversationsThreadHeader.textContent = 'Selecciona un chat';
            }
            if (this.conversationsThreadMessages) {
                this.conversationsThreadMessages.innerHTML =
                    '<p class="auto-reply-empty">Aquí verás el historial de la conversación.</p>';
                delete this.conversationsThreadMessages.dataset.lastMessagesHtml;
            }
            this.updateConversationThreadActions();
            this.renderConversationsChatList();
            this.updateConversationsStatus();
            if (typeof this.loadIncomingInbox === 'function') {
                this.loadIncomingInbox().catch(() => {});
            }

            const pausedNote = data.aiPaused === true ? ' IA pausada.' : '';
            this.showStatus(`Conversación borrada: ${label}.${pausedNote}`, 'success');
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async editConversationMessage(messageId, currentBody = '') {
        const active = this.activeConversation;
        if (!active) return;
        if (!this.canControlSession(active.sessionId)) {
            this.showStatus('No tienes permiso de control en esta sesión', 'error');
            return;
        }

        const nextBody = window.prompt('Editar mensaje:', currentBody || '');
        if (nextBody == null) return;
        const body = String(nextBody).trim();
        if (!body) {
            this.showStatus('El mensaje no puede estar vacío', 'error');
            return;
        }
        if (body === String(currentBody || '').trim()) return;

        try {
            const response = await fetch('/api/conversations/edit-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: active.sessionId,
                    chatId: active.chatId,
                    messageId,
                    body
                })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo editar');
            this.showStatus('Mensaje editado', 'success');
            await this.refreshActiveConversationMessages({ silent: true });
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async deleteConversationMessage(messageId) {
        const active = this.activeConversation;
        if (!active) return;
        if (!this.canControlSession(active.sessionId)) {
            this.showStatus('No tienes permiso de control en esta sesión', 'error');
            return;
        }
        if (!confirm('¿Eliminar este mensaje para todos?')) return;

        try {
            const response = await fetch('/api/conversations/delete-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: active.sessionId,
                    chatId: active.chatId,
                    messageId,
                    forEveryone: true
                })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo eliminar');
            this.showStatus('Mensaje eliminado', 'success');
            await this.refreshActiveConversationMessages({ silent: true });
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async refreshActiveConversationMessages(options = {}) {
        const silent = Boolean(options.silent);
        const active = this.activeConversation;
        if (!active || !active.chatId || !active.sessionId) return;
        if (silent && this._conversationsThreadLoadInFlight) return;

        this._conversationsThreadLoadInFlight = true;
        const requestKey = `${active.sessionId}::${active.chatId}`;

        try {
            const response = await fetch(
                `/api/conversations/${encodeURIComponent(active.chatId)}/messages?sessionId=${encodeURIComponent(active.sessionId)}&limit=80`
            );
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo cargar el historial');

            // Si el usuario cambió de chat mientras cargaba, descartar.
            if (
                !this.activeConversation ||
                `${this.activeConversation.sessionId}::${this.activeConversation.chatId}` !==
                    requestKey
            ) {
                return;
            }

            this.renderConversationMessages(data.messages || [], { preserveScroll: silent });
        } catch (error) {
            if (!silent && this.conversationsThreadMessages) {
                this.conversationsThreadMessages.innerHTML = `<p class="auto-reply-empty">Error: ${this.escapeHtml(error.message)}</p>`;
            }
        } finally {
            this._conversationsThreadLoadInFlight = false;
        }
    }

    renderConversationMessages(messages, options = {}) {
        if (!this.conversationsThreadMessages) return;
        const preserveScroll = Boolean(options.preserveScroll);
        const el = this.conversationsThreadMessages;
        const nearBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        const prevScrollTop = el.scrollTop;
        const canControl =
            this.activeConversation &&
            this.canControlSession(this.activeConversation.sessionId);

        if (!messages.length) {
            el.innerHTML = '<p class="auto-reply-empty">Sin mensajes en este chat.</p>';
            delete el.dataset.lastMessagesHtml;
            return;
        }

        const nextHtml = messages
            .map((msg) => {
                const time = this.formatConversationTime(msg.timestamp);
                const messageId = msg.id ? String(msg.id) : '';
                const canEdit =
                    canControl && msg.fromMe && messageId && msg.type !== 'revoked';
                const actions = canEdit
                    ? `<div class="bubble-actions">
                        <button type="button" class="bubble-action-btn" data-action="edit" data-message-id="${this.escapeHtml(messageId)}" data-body="${encodeURIComponent(msg.body || '')}">Editar</button>
                        <button type="button" class="bubble-action-btn" data-action="delete" data-message-id="${this.escapeHtml(messageId)}">Eliminar</button>
                       </div>`
                    : '';
                return `
                <div class="conv-bubble ${msg.fromMe ? 'outgoing' : 'incoming'}" data-message-id="${this.escapeHtml(messageId)}">
                    ${this.escapeHtml(msg.body || '')}
                    ${time ? `<span class="bubble-time">${this.escapeHtml(time)}</span>` : ''}
                    ${actions}
                </div>`;
            })
            .join('');

        // Evita re-render innecesario (menos parpadeo en el poll).
        if (el.dataset.lastMessagesHtml === nextHtml) {
            return;
        }
        el.dataset.lastMessagesHtml = nextHtml;
        el.innerHTML = nextHtml;

        if (preserveScroll && !nearBottom) {
            el.scrollTop = prevScrollTop;
        } else {
            el.scrollTop = el.scrollHeight;
        }
    }

    async sendConversationReply() {
        if (!this.activeConversation) {
            this.showStatus('Selecciona un chat primero', 'error');
            return;
        }
        const text = (this.conversationsReplyInput && this.conversationsReplyInput.value || '').trim();
        if (!text) {
            this.showStatus('Escribe un mensaje', 'error');
            return;
        }

        if (this.conversationsReplyBtn) this.conversationsReplyBtn.disabled = true;
        if (this.conversationsReplyInput) this.conversationsReplyInput.disabled = true;

        try {
            const response = await fetch('/api/conversations/reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.activeConversation.sessionId,
                    chatId: this.activeConversation.chatId,
                    text
                })
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }

            if (this.conversationsReplyInput) this.conversationsReplyInput.value = '';

            // Mostrar el mensaje enviado de inmediato en el hilo
            if (this.conversationsThreadMessages) {
                const empty = this.conversationsThreadMessages.querySelector('.auto-reply-empty');
                if (empty) empty.remove();
                const bubble = document.createElement('div');
                bubble.className = 'conv-bubble outgoing';
                bubble.innerHTML = `
                    ${this.escapeHtml(text)}
                    <span class="bubble-time">${this.escapeHtml(new Date().toLocaleString())}</span>
                `;
                this.conversationsThreadMessages.appendChild(bubble);
                this.conversationsThreadMessages.scrollTop =
                    this.conversationsThreadMessages.scrollHeight;
            }

            // Actualizar preview en la lista
            const chat = this.conversationsChats.find(
                (c) => (c.key || `${c.sessionId}::${c.id}`) === this.activeConversation.key
            );
            if (chat) {
                chat.lastMessage = text;
                chat.timestamp = Math.floor(Date.now() / 1000);
                this.conversationsChats.sort(
                    (a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)
                );
                this.renderConversationsChatList();
            }

            this.showStatus(
                data.aiPaused === true
                    ? `Enviado desde ${this.activeConversation.sessionLabel}. IA pausada en este chat.`
                    : `Enviado desde ${this.activeConversation.sessionLabel}`,
                'success'
            );

            if (data.aiPaused === true) {
                this.activeConversationAiPaused = true;
                this.activeConversationKnownContact = true;
                this.updateConversationThreadActions();
                this.updateActiveConversationHeaderBadges();
            }
        } catch (error) {
            console.error('[conversations] reply error', error);
            this.showStatus(error.message || 'No se pudo enviar', 'error');
        } finally {
            this.setConversationsReplyEnabled(Boolean(this.activeConversation));
            if (this.conversationsReplyInput && this.activeConversation) {
                this.conversationsReplyInput.focus();
            }
        }
    }

    async loadAutoReplyConfig() {
        try {
            const response = await fetch('/api/auto-reply/config');
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Error cargando config');
            const config = data.config || {};
            this.autoReplyRules = Array.isArray(config.rules) ? config.rules : [];
            this.autoReplyEnabledSessionIds =
                config.enabledSessionIds === null || config.enabledSessionIds === undefined
                    ? null
                    : Array.isArray(config.enabledSessionIds)
                      ? config.enabledSessionIds
                      : null;
            if (this.autoReplyBasePrompt) {
                this.autoReplyBasePrompt.value = config.basePrompt || '';
            }
            if (this.autoReplyEnabledToggle) {
                this.autoReplyEnabledToggle.checked = Boolean(config.enabled);
            }
            this.renderAutoReplyRules();
            this.renderAutoReplySessions();
        } catch (error) {
            console.error('Error cargando auto-reply config:', error);
        }
    }

    renderAutoReplySessions() {
        if (!this.autoReplySessionsList) return;
        const isSuper = this.isSuperUser();
        const sessions = isSuper
            ? this.configuredSessions || []
            : this.getControllableSessions();

        if (!sessions.length) {
            this.autoReplySessionsList.innerHTML =
                '<p class="auto-reply-empty">No hay líneas disponibles.</p>';
            return;
        }

        const allEnabled = this.autoReplyEnabledSessionIds === null;
        this.autoReplySessionsList.innerHTML = sessions
            .map((session) => {
                const checked =
                    allEnabled ||
                    (Array.isArray(this.autoReplyEnabledSessionIds) &&
                        this.autoReplyEnabledSessionIds.includes(session.id));
                return `
                <label class="auto-reply-session-item">
                    <input type="checkbox" class="auto-reply-session-check"
                        data-session-id="${this.escapeHtml(session.id)}"
                        ${checked ? 'checked' : ''}>
                    <span>${this.escapeHtml(session.label || session.id)}</span>
                </label>`;
            })
            .join('');

        this.autoReplySessionsList
            .querySelectorAll('.auto-reply-session-check')
            .forEach((el) => {
                el.addEventListener('change', () => {
                    const sessionId = el.dataset.sessionId;
                    const enabled = el.checked;
                    this.toggleSessionAi(sessionId, enabled, el);
                });
            });
    }

    async toggleSessionAi(sessionId, enabled, checkboxEl) {
        try {
            const response = await fetch('/api/auto-reply/sessions', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, enabled })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo actualizar');
            this.autoReplyEnabledSessionIds =
                data.config.enabledSessionIds === null ||
                data.config.enabledSessionIds === undefined
                    ? null
                    : data.config.enabledSessionIds;
            this.showStatus(
                enabled
                    ? `IA activada en ${sessionId}`
                    : `IA desactivada en ${sessionId}`,
                'success'
            );
            await this.loadAutoReplyStatus();
        } catch (error) {
            if (checkboxEl) checkboxEl.checked = !enabled;
            this.showStatus(error.message, 'error');
        }
    }

    collectEnabledSessionIdsFromDom() {
        if (!this.autoReplySessionsList) {
            return this.autoReplyEnabledSessionIds;
        }
        const checks = this.autoReplySessionsList.querySelectorAll('.auto-reply-session-check');
        if (!checks.length) return this.autoReplyEnabledSessionIds;
        return Array.from(checks)
            .filter((el) => el.checked)
            .map((el) => el.dataset.sessionId)
            .filter(Boolean);
    }

    renderAutoReplyRules() {
        if (!this.autoReplyRulesList) return;
        if (!this.autoReplyRules.length) {
            this.autoReplyRulesList.innerHTML = '<p class="auto-reply-empty">No hay reglas. Agrega una para respuestas por palabra clave.</p>';
            return;
        }
        this.autoReplyRulesList.innerHTML = this.autoReplyRules
            .map(
                (rule, index) => `
            <div class="auto-reply-rule-card" data-rule-index="${index}">
                <label>Etiqueta</label>
                <input type="text" class="auto-reply-rule-input rule-label" value="${this.escapeHtml(rule.label || '')}">
                <label>Palabras clave (separadas por coma)</label>
                <input type="text" class="auto-reply-rule-input rule-keywords" value="${this.escapeHtml((rule.keywords || []).join(', '))}">
                <label>Instrucción para la IA</label>
                <textarea class="auto-reply-rule-input rule-instruction" rows="2">${this.escapeHtml(rule.instruction || '')}</textarea>
                <div class="auto-reply-rule-actions">
                    <button type="button" class="btn btn-danger btn-sm remove-rule-btn" data-index="${index}">Eliminar</button>
                </div>
            </div>`
            )
            .join('');

        this.autoReplyRulesList.querySelectorAll('.remove-rule-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                this.autoReplyRules.splice(idx, 1);
                this.renderAutoReplyRules();
            });
        });
    }

    addAutoReplyRule() {
        this.autoReplyRules.push({
            id: `rule_${Date.now()}`,
            label: 'Nueva regla',
            keywords: [],
            instruction: ''
        });
        this.renderAutoReplyRules();
    }

    collectAutoReplyRulesFromDom() {
        if (!this.autoReplyRulesList) return [];
        const cards = this.autoReplyRulesList.querySelectorAll('.auto-reply-rule-card');
        return Array.from(cards).map((card, index) => {
            const label = card.querySelector('.rule-label')?.value || `Regla ${index + 1}`;
            const keywordsRaw = card.querySelector('.rule-keywords')?.value || '';
            const instruction = card.querySelector('.rule-instruction')?.value || '';
            const existing = this.autoReplyRules[index] || {};
            return {
                id: existing.id || `rule_${Date.now()}_${index}`,
                label: label.trim(),
                keywords: keywordsRaw
                    .split(',')
                    .map((k) => k.trim())
                    .filter(Boolean),
                instruction: instruction.trim()
            };
        });
    }

    async saveAutoReplyConfig(options = {}) {
        try {
            const payload = {
                enabled: this.autoReplyEnabledToggle ? this.autoReplyEnabledToggle.checked : false,
                basePrompt: this.autoReplyBasePrompt ? this.autoReplyBasePrompt.value : '',
                rules: options.enabledOnly ? undefined : this.collectAutoReplyRulesFromDom(),
                enabledSessionIds: options.enabledOnly
                    ? this.autoReplyEnabledSessionIds
                    : this.collectEnabledSessionIdsFromDom()
            };
            if (options.enabledOnly) {
                payload.rules = this.autoReplyRules;
            }
            const response = await fetch('/api/auto-reply/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo guardar');
            this.autoReplyRules = data.config.rules || [];
            this.autoReplyEnabledSessionIds =
                data.config.enabledSessionIds === null ||
                data.config.enabledSessionIds === undefined
                    ? null
                    : data.config.enabledSessionIds;
            if (!options.enabledOnly) {
                this.renderAutoReplyRules();
                this.renderAutoReplySessions();
            }
            if (!options.silent) {
                this.showStatus('Configuración de auto-respuesta guardada', 'success');
            }
            await this.loadAutoReplyStatus();
        } catch (error) {
            this.showStatus(error.message, 'error');
        }
    }

    async activateAutoReply() {
        this.updateWebhookControlsUI(this._lastAutoReplyStatus, {
            busy: true,
            mode: 'activate',
            busyLabel: 'Webhooks: activando…'
        });
        try {
            console.log('[auto-reply-ui] activate: saving config then calling /activate');
            await this.saveAutoReplyConfig({ silent: true });
            const response = await fetch('/api/auto-reply/activate', { method: 'POST' });
            const data = await response.json();
            console.log('[auto-reply-ui] activate response', {
                httpStatus: response.status,
                success: data.success,
                results: data.results,
                webhookIdsBySession: data.webhookIdsBySession
            });
            if (!data.success) throw new Error(data.error || 'No se pudo activar');
            const results = data.results || [];
            const ok = results.filter((r) => r.success).length;
            const fail = results.filter((r) => !r.success);
            const failDetail = fail
                .slice(0, 3)
                .map((r) => `${r.logicalSessionId || r.openwaSessionId || '?'}: ${r.error || 'error'}`)
                .join(' · ');
            const persisted = Object.keys(data.webhookIdsBySession || {}).length;
            if (ok > 0 && fail.length === 0) {
                this.showStatus(
                    `Webhooks ACTIVOS: ${ok} sesión(es) · persistidos ${persisted}`,
                    'success'
                );
            } else if (ok > 0) {
                this.showStatus(
                    `Webhooks parcial: ${ok} OK, ${fail.length} fallo(s)${failDetail ? ` — ${failDetail}` : ''}`,
                    'warning'
                );
            } else {
                this.showStatus(
                    `No se activó ningún webhook${failDetail ? `: ${failDetail}` : ''}`,
                    'error'
                );
            }
            await this.loadAutoReplyStatus();
            console.log('[auto-reply-ui] status after activate', this._lastAutoReplyStatus);
            await this.loadAutoReplyConfig();
            await this.loadIncomingInbox();
        } catch (error) {
            console.error('[auto-reply-ui] activate error', error);
            this.showStatus(error.message, 'error');
            this.updateWebhookControlsUI(this._lastAutoReplyStatus);
            await this.loadAutoReplyStatus();
        }
    }

    async deactivateAutoReply() {
        this.updateWebhookControlsUI(this._lastAutoReplyStatus, {
            busy: true,
            mode: 'deactivate',
            busyLabel: 'Webhooks: desactivando…'
        });
        try {
            const response = await fetch('/api/auto-reply/deactivate', { method: 'POST' });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo desactivar');
            const results = data.results || [];
            const ok = results.filter((r) => r.success).length;
            const fail = results.filter((r) => !r.success).length;
            if (ok > 0 && fail === 0) {
                this.showStatus(`Webhooks DESACTIVADOS (${ok} eliminados en OpenWA)`, 'success');
            } else if (results.length === 0) {
                this.showStatus('No había webhooks registrados; estado: inactivos', 'success');
            } else {
                this.showStatus(
                    `Desactivación parcial: ${ok} OK, ${fail} fallo(s). Revisa el estado abajo.`,
                    'warning'
                );
            }
            await this.loadAutoReplyStatus();
            await this.loadAutoReplyConfig();
        } catch (error) {
            this.showStatus(error.message, 'error');
            this.updateWebhookControlsUI(this._lastAutoReplyStatus);
            await this.loadAutoReplyStatus();
        }
    }

    async testAutoReply() {
        const telefono = this.autoReplyTestPhone ? this.autoReplyTestPhone.value.trim() : '';
        const message = this.autoReplyTestMessage ? this.autoReplyTestMessage.value.trim() : 'Hola, me interesa';
        if (!telefono) {
            this.showStatus('Indica un teléfono que ya esté en el historial de contactos', 'error');
            return;
        }
        try {
            await this.saveAutoReplyConfig({ silent: true });
            const response = await fetch('/api/auto-reply/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telefono, message })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Prueba fallida');
            if (data.result && data.result.replyMessage) {
                this.appendAutoReplyConversation(data.result);
            }
            this.showStatus('Prueba de auto-respuesta completada (sin enviar por WhatsApp)', 'success');
        } catch (error) {
            this.showStatus(error.message, 'error');
        }
    }

    appendAutoReplyConversation(item) {
        if (!this.autoReplyConversations) return;
        const empty = this.autoReplyConversations.querySelector('.auto-reply-empty');
        if (empty) empty.remove();

        const sessionLabel = item.sessionId ? this.getSessionLabel(item.sessionId) : item.openwaSessionId || '';
        const ruleLabel = item.matchedRuleLabel ? ` · Regla: ${item.matchedRuleLabel}` : '';
        const testBadge = item.testMode ? ' · PRUEBA' : '';

        const el = document.createElement('div');
        el.className = 'auto-reply-conversation-item fade-in';
        el.innerHTML = `
            <div class="meta">${this.escapeHtml(sessionLabel)}${this.escapeHtml(ruleLabel)}${testBadge} · ${new Date(item.timestamp || Date.now()).toLocaleString()}</div>
            <div class="incoming"><strong>Entrante:</strong> ${this.escapeHtml(item.incomingMessage || '')}</div>
            <div class="reply"><strong>Respuesta IA:</strong> ${this.escapeHtml(item.replyMessage || '')}</div>
        `;
        this.autoReplyConversations.prepend(el);
    }

    getSessionLabel(sessionId) {
        const found = this.configuredSessions.find((s) => s.id === sessionId);
        return found ? found.label : sessionId;
    }

    getSessionSenderName(sessionId) {
        const found = this.configuredSessions.find((s) => s.id === sessionId);
        if (!found) return sessionId || 'Remitente';
        return (found.senderName || found.label || found.id || sessionId).trim();
    }

    getPreviewSenderName() {
        const selected = this.getSelectedSessionIds();
        if (selected.length > 0) {
            return this.getSessionSenderName(selected[0]);
        }
        if (this.configuredSessions && this.configuredSessions.length > 0) {
            return this.getSessionSenderName(this.configuredSessions[0].id);
        }
        return 'Remitente';
    }

    resolveMessageForDisplay(message, sessionId = null) {
        if (!message) return message;
        const senderName = sessionId
            ? this.getSessionSenderName(sessionId)
            : this.getPreviewSenderName();
        return message
            .split('{{SENDER_NAME}}')
            .join(senderName)
            .replace(/(\nAtte:\s*\n)\s*Mónica González\s*$/i, `$1${senderName}`);
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

    getSessionWeightInputs() {
        if (!this.sessionCheckboxes) return [];
        return [...this.sessionCheckboxes.querySelectorAll('.session-weight-input')];
    }

    getStoredSessionWeight(sessionId) {
        const stored = this._sessionWeightValues && this._sessionWeightValues[sessionId];
        return Number.isFinite(stored) && stored > 0 ? stored : null;
    }

    /** Cantidades exactas de mensajes solo de sesiones seleccionadas */
    getSelectedSessionWeights() {
        const weights = {};
        if (!this.sessionCheckboxes) return weights;

        this.sessionCheckboxes.querySelectorAll('.session-send-row').forEach((row) => {
            const cb = row.querySelector('.session-send-checkbox');
            const input = row.querySelector('.session-weight-input');
            if (!cb || !input || !cb.checked) return;
            const value = parseInt(String(input.value).replace(',', '.'), 10);
            weights[cb.value] = Number.isFinite(value) && value > 0 ? value : 0;
        });

        return weights;
    }

    getReadyMessagesCount() {
        return this.cvsData.filter(
            (cv) =>
                cv.procesado &&
                cv.mensajeIA &&
                cv.mensajeIA.trim() !== '' &&
                cv.telefono !== 'No encontrado'
        ).length;
    }

    distributeSessionWeightsEqually() {
        const selected = this.getSelectedSessionIds();
        if (selected.length === 0) return;

        const total = this.getReadyMessagesCount();
        if (total <= 0) {
            this.showStatus('Primero genera los mensajes para repartir cantidades', 'error');
            return;
        }

        const base = Math.floor(total / selected.length);
        let remainder = total - base * selected.length;

        selected.forEach((id, index) => {
            const value = base + (index < remainder ? 1 : 0);
            if (!this._sessionWeightValues) this._sessionWeightValues = {};
            this._sessionWeightValues[id] = value;
        });

        this.getSessionWeightInputs().forEach((input) => {
            const stored = this.getStoredSessionWeight(input.dataset.sessionId);
            if (stored != null) input.value = String(stored);
        });

        this._lastSeededReadyCount = total;
        this.updateSessionWeightUI();
    }

    /**
     * Si cambió el total de mensajes listos, o los valores parecen % antiguos,
     * reparte cantidades exactas automáticamente.
     */
    maybeReseedSessionCounts() {
        const selected = this.getSelectedSessionIds();
        const total = this.getReadyMessagesCount();
        if (selected.length === 0 || total <= 0) return;

        const weights = this.getSelectedSessionWeights();
        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        const looksLikeOldPercent =
            sum === 100 &&
            total !== 100 &&
            Object.values(weights).every((w) => w > 0 && w <= 100);

        const totalChanged = this._lastSeededReadyCount !== total;
        if (!totalChanged && !looksLikeOldPercent) return;

        const base = Math.floor(total / selected.length);
        let remainder = total - base * selected.length;
        selected.forEach((id, index) => {
            if (!this._sessionWeightValues) this._sessionWeightValues = {};
            this._sessionWeightValues[id] = base + (index < remainder ? 1 : 0);
        });
        this.getSessionWeightInputs().forEach((input) => {
            const sid = input.dataset.sessionId;
            if (this._sessionWeightValues[sid] != null) {
                input.value = String(this._sessionWeightValues[sid]);
            }
        });
        this._lastSeededReadyCount = total;
    }

    computeWeightDistributionPreview(totalMessages, weightsBySession) {
        const sessionIds = Object.keys(weightsBySession);
        if (sessionIds.length === 0 || totalMessages <= 0) {
            return sessionIds.map((id) => ({ id, count: 0 }));
        }

        const values = sessionIds.map((id) => Math.floor(weightsBySession[id] || 0));
        const sum = values.reduce((a, b) => a + b, 0);

        if (sum === totalMessages) {
            return sessionIds.map((id, i) => ({ id, count: values[i] }));
        }

        // Vista previa si aún no suman el total: muestra lo capturado y avisa en UI.
        return sessionIds.map((id, i) => ({ id, count: values[i] }));
    }

    updateSessionWeightUI() {
        const selected = this.getSelectedSessionIds();
        const multi = selected.length > 1;
        const cvsCount = this.getReadyMessagesCount();

        this.getSessionWeightInputs().forEach((input) => {
            const row = input.closest('.session-send-row');
            const cb = row ? row.querySelector('.session-send-checkbox') : null;
            const enabled = Boolean(cb && cb.checked && multi);
            input.disabled = !enabled;
            input.max = cvsCount > 0 ? String(cvsCount) : '';
            row?.classList.toggle('session-send-row-disabled', Boolean(cb && !cb.checked));
        });

        if (this.distributeWeightsEquallyBtn) {
            this.distributeWeightsEquallyBtn.style.display = multi ? 'inline-block' : 'none';
        }

        const weights = this.getSelectedSessionWeights();
        const sum = Object.values(weights).reduce((a, b) => a + b, 0);

        if (this.sessionWeightSum) {
            if (!multi) {
                this.sessionWeightSum.textContent = '';
                this.sessionWeightSum.className = 'session-weight-sum';
            } else if (cvsCount > 0) {
                this.sessionWeightSum.textContent = `Asignados: ${sum} / ${cvsCount}`;
                this.sessionWeightSum.className =
                    'session-weight-sum' + (sum !== cvsCount ? ' session-weight-sum-warn' : '');
            } else {
                this.sessionWeightSum.textContent = `Asignados: ${sum}`;
                this.sessionWeightSum.className = 'session-weight-sum';
            }
        }

        if (this.sessionWeightPreview) {
            if (!multi) {
                this.sessionWeightPreview.textContent = '';
                return;
            }

            if (cvsCount === 0) {
                this.sessionWeightPreview.textContent =
                    'Indica cuántos mensajes enviará cada línea. Deben sumar el total de mensajes listos.';
                return;
            }

            const preview = this.computeWeightDistributionPreview(cvsCount, weights);
            const parts = preview.map(
                (row) => `${this.getSessionLabel(row.id)}: ${row.count}`
            );
            const diff = cvsCount - sum;
            let hint = '';
            if (diff > 0) hint = ` · faltan ${diff}`;
            else if (diff < 0) hint = ` · sobran ${Math.abs(diff)}`;
            this.sessionWeightPreview.textContent = `${cvsCount} mensajes → ${parts.join(' · ')}${hint}`;
        }
    }

    validateSessionWeights() {
        const selected = this.getSelectedSessionIds();
        if (selected.length <= 1) return { ok: true, weights: {} };

        const weights = this.getSelectedSessionWeights();
        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        const cvsCount = this.getReadyMessagesCount();

        if (Object.values(weights).some((w) => w <= 0)) {
            return {
                ok: false,
                message: 'Cada línea seleccionada debe tener al menos 1 mensaje.'
            };
        }

        if (cvsCount > 0 && sum !== cvsCount) {
            return {
                ok: false,
                message: `Las cantidades deben sumar ${cvsCount} mensajes (actualmente suman ${sum}). Usa "Repartir igual" o ajusta los valores.`
            };
        }

        return { ok: true, weights };
    }

    getControlSessionId() {
        return this.activeControlSessionId || '__roundrobin__';
    }

    renderSessionUI() {
        const sessions = this.configuredSessions || [];
        const controllable = this.getControllableSessions();
        const isSuper = this.isSuperUser();

        if (this.sessionSelect) {
            const prev = this.sessionSelect.value;
            this.sessionSelect.innerHTML = '';
            if (controllable.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = sessions.length
                    ? 'Sin sesiones con control'
                    : 'Sin sesiones configuradas';
                this.sessionSelect.appendChild(opt);
                this.sessionSelect.disabled = true;
            } else {
                this.sessionSelect.disabled = false;
                controllable.forEach((s) => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.textContent = s.label;
                    this.sessionSelect.appendChild(opt);
                });
                if (prev && controllable.some((s) => s.id === prev)) {
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
            if (!this._sessionWeightValues) this._sessionWeightValues = {};

            controllable.forEach((s, index) => {
                const row = document.createElement('div');
                row.className = 'session-send-row';
                row.dataset.sessionId = s.id;

                const label = document.createElement('label');
                label.className = 'session-send-label';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'session-send-checkbox';
                cb.value = s.id;
                cb.checked = defaultAllChecked || previouslyChecked.has(s.id);

                const span = document.createElement('span');
                span.className = 'session-send-name';
                span.textContent = s.label;

                const weightWrap = document.createElement('span');
                weightWrap.className = 'session-weight-wrap';

                const weightInput = document.createElement('input');
                weightInput.type = 'number';
                weightInput.min = '0';
                weightInput.step = '1';
                weightInput.className = 'session-weight-input form-select';
                weightInput.dataset.sessionId = s.id;
                weightInput.title = 'Cantidad exacta de mensajes para esta línea';

                const readyCount = this.getReadyMessagesCount();
                if (readyCount > 0) {
                    weightInput.max = String(readyCount);
                }

                if (this._sessionWeightValues[s.id] == null) {
                    if (readyCount > 0) {
                        const equalShare = Math.floor(readyCount / controllable.length);
                        const extra = index < readyCount % Math.max(controllable.length, 1) ? 1 : 0;
                        this._sessionWeightValues[s.id] = equalShare + extra;
                    } else {
                        this._sessionWeightValues[s.id] = 1;
                    }
                }
                weightInput.value = String(this._sessionWeightValues[s.id]);

                const countLabel = document.createElement('span');
                countLabel.className = 'session-weight-suffix';
                countLabel.textContent = 'msgs';

                weightWrap.appendChild(weightInput);
                weightWrap.appendChild(countLabel);

                label.appendChild(cb);
                label.appendChild(span);
                label.appendChild(weightWrap);
                row.appendChild(label);
                this.sessionCheckboxes.appendChild(row);

                cb.addEventListener('change', () => this.updateSessionWeightUI());
                weightInput.addEventListener('input', () => {
                    const value = parseInt(String(weightInput.value).replace(',', '.'), 10);
                    if (Number.isFinite(value) && value >= 0) {
                        this._sessionWeightValues[s.id] = value;
                    }
                    this.updateSessionWeightUI();
                });
            });
            this._sessionsCheckboxesInitialized = true;
            this.maybeReseedSessionCounts();
            this.updateSessionWeightUI();
        }

        if (this.sessionsList) {
            if (sessions.length === 0) {
                this.sessionsList.innerHTML =
                    '<p style="color:#64748b;font-size:13px;">Aún no hay sesiones guardadas.</p>';
            } else {
                this.sessionsList.innerHTML = sessions
                    .map((s) => {
                        const access = s.access || this.getSessionAccess(s.id) || 'view';
                        const accessLabel = access === 'control' ? 'Control' : 'Solo ver';
                        if (!isSuper) {
                            return `
                    <div class="session-row" data-session-id="${s.id}" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;margin-bottom:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                        <strong style="min-width:120px;">${this.escapeHtml(s.label)}</strong>
                        <span class="session-access-badge session-access-${access}">${accessLabel}</span>
                        <code style="font-size:12px;background:#e2e8f0;padding:2px 6px;border-radius:4px;">${this.escapeHtml(s.openwaSessionId)}</code>
                    </div>`;
                        }
                        return `
                    <div class="session-row" data-session-id="${s.id}" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;margin-bottom:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                        <strong style="min-width:120px;">${this.escapeHtml(s.label)}</strong>
                        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1;min-width:200px;">
                            <span style="font-size:12px;color:#64748b;">Remitente:</span>
                            <input type="text" class="session-sender-input form-select" data-id="${s.id}" value="${this.escapeHtml(s.senderName || s.label || '')}" placeholder="Nombre en WhatsApp" style="padding:4px 8px;min-width:180px;max-width:260px;font-size:13px;">
                            <button type="button" class="btn btn-secondary btn-sm save-sender-btn" data-id="${s.id}" style="padding:4px 10px;font-size:12px;">Guardar</button>
                            <button type="button" class="btn btn-secondary btn-sm sync-sender-btn" data-id="${s.id}" title="Obtener nombre desde WhatsApp" style="padding:4px 10px;font-size:12px;">↻ WhatsApp</button>
                        </div>
                        <code style="font-size:12px;background:#e2e8f0;padding:2px 6px;border-radius:4px;">${this.escapeHtml(s.openwaSessionId)}</code>
                        <button type="button" class="btn btn-danger btn-sm remove-session-btn" data-id="${s.id}" style="padding:4px 10px;font-size:12px;">Quitar</button>
                    </div>`;
                    })
                    .join('');

                if (isSuper) {
                    this.sessionsList.querySelectorAll('.remove-session-btn').forEach((btn) => {
                        btn.addEventListener('click', () => this.removeSession(btn.dataset.id));
                    });
                    this.sessionsList.querySelectorAll('.save-sender-btn').forEach((btn) => {
                        btn.addEventListener('click', () => this.saveSessionSenderName(btn.dataset.id));
                    });
                    this.sessionsList.querySelectorAll('.sync-sender-btn').forEach((btn) => {
                        btn.addEventListener('click', () => this.syncSessionSenderName(btn.dataset.id));
                    });
                }
            }
        }

        if (this.sessionsEmptyHint) {
            this.sessionsEmptyHint.style.display = sessions.length === 0 ? 'block' : 'none';
        }

        this.applyPermissionUI();
        this.renderNewUserPermissions();
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
                this.populateConversationsSessionSelect();
                this.renderAutoReplySessions();
            }
        } catch (error) {
            console.error('Error cargando sesiones:', error);
        }

        if (!this.testMode && this.isSuperUser()) {
            this.loadOpenWASessionPicker();
        }
    }

    collectPermissionsFromForm(container) {
        /** @type {Record<string, string>} */
        const permissions = {};
        if (!container) return permissions;
        container.querySelectorAll('.user-perm-select').forEach((select) => {
            const sessionId = select.dataset.sessionId;
            const value = String(select.value || '').trim();
            if (sessionId && (value === 'view' || value === 'control')) {
                permissions[sessionId] = value;
            }
        });
        return permissions;
    }

    renderNewUserPermissions() {
        if (!this.newUserPermissions) return;
        const sessions = this.isSuperUser()
            ? this.configuredSessions || []
            : [];
        if (!sessions.length) {
            this.newUserPermissions.innerHTML =
                '<p style="font-size:13px;color:#64748b;">Primero agrega sesiones WhatsApp para poder asignar permisos.</p>';
            return;
        }
        this.newUserPermissions.innerHTML = `
            <p style="font-size:13px;color:#64748b;margin:8px 0;">Permisos por sesión:</p>
            ${sessions
                .map(
                    (s) => `
                <div class="user-perm-row">
                    <span class="user-perm-label">${this.escapeHtml(s.label || s.id)}</span>
                    <select class="form-select user-perm-select" data-session-id="${this.escapeHtml(s.id)}">
                        <option value="">Sin acceso</option>
                        <option value="view">Solo ver</option>
                        <option value="control">Controlar</option>
                    </select>
                </div>`
                )
                .join('')}
        `;
    }

    async loadUsers() {
        if (!this.isSuperUser() || !this.usersList) return;
        try {
            const response = await fetch('/api/users');
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudieron cargar usuarios');
            this.managedUsers = data.users || [];
            this.renderUsersList();
        } catch (error) {
            this.usersList.innerHTML = `<p style="color:#b91c1c;font-size:13px;">Error: ${this.escapeHtml(error.message)}</p>`;
        }
    }

    renderUsersList() {
        if (!this.usersList) return;
        const users = this.managedUsers || [];
        const sessions = this.configuredSessions || [];

        if (!users.length) {
            this.usersList.innerHTML =
                '<p style="font-size:13px;color:#64748b;">Aún no hay usuarios creados.</p>';
            return;
        }

        this.usersList.innerHTML = users
            .map((user) => {
                const perms = user.permissions || {};
                const permRows = sessions
                    .map((s) => {
                        const current = perms[s.id] || '';
                        return `
                        <div class="user-perm-row">
                            <span class="user-perm-label">${this.escapeHtml(s.label || s.id)}</span>
                            <select class="form-select user-perm-select" data-user-id="${this.escapeHtml(user.id)}" data-session-id="${this.escapeHtml(s.id)}">
                                <option value="" ${!current ? 'selected' : ''}>Sin acceso</option>
                                <option value="view" ${current === 'view' ? 'selected' : ''}>Solo ver</option>
                                <option value="control" ${current === 'control' ? 'selected' : ''}>Controlar</option>
                            </select>
                        </div>`;
                    })
                    .join('');

                return `
                <div class="user-card" data-user-id="${this.escapeHtml(user.id)}">
                    <div class="user-card-header">
                        <strong>${this.escapeHtml(user.username)}</strong>
                        <button type="button" class="btn btn-danger btn-sm delete-user-btn" data-id="${this.escapeHtml(user.id)}">Eliminar</button>
                    </div>
                    <label style="font-size:12px;color:#64748b;display:block;margin:6px 0 4px;">Correo gerente (Panel)</label>
                    <input type="email" class="form-select user-gerente-input" data-id="${this.escapeHtml(user.id)}" value="${this.escapeHtml(user.gerenteEmail || '')}" placeholder="correo@protalentconnections.com" autocomplete="off">
                    <div class="user-card-perms">${permRows || '<p style="font-size:12px;color:#64748b;">No hay sesiones para asignar.</p>'}</div>
                    <div class="user-card-actions">
                        <input type="password" class="form-select user-password-input" data-id="${this.escapeHtml(user.id)}" placeholder="Nueva contraseña (opcional)" autocomplete="new-password">
                        <button type="button" class="btn btn-secondary btn-sm save-user-btn" data-id="${this.escapeHtml(user.id)}">Guardar cambios</button>
                    </div>
                </div>`;
            })
            .join('');

        this.usersList.querySelectorAll('.delete-user-btn').forEach((btn) => {
            btn.addEventListener('click', () => this.deleteUser(btn.dataset.id));
        });
        this.usersList.querySelectorAll('.save-user-btn').forEach((btn) => {
            btn.addEventListener('click', () => this.saveUser(btn.dataset.id));
        });
    }

    async createUser() {
        if (!this.isSuperUser()) return;
        const username = this.newUserUsername ? this.newUserUsername.value.trim() : '';
        const password = this.newUserPassword ? this.newUserPassword.value : '';
        const gerenteEmail = this.newUserGerenteEmail ? this.newUserGerenteEmail.value.trim() : '';
        const permissions = this.collectPermissionsFromForm(this.newUserPermissions);

        try {
            const response = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, permissions, gerenteEmail })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo crear');

            if (this.newUserUsername) this.newUserUsername.value = '';
            if (this.newUserPassword) this.newUserPassword.value = '';
            if (this.newUserGerenteEmail) this.newUserGerenteEmail.value = '';
            this.renderNewUserPermissions();
            if (this.usersFormStatus) {
                this.usersFormStatus.textContent = `Usuario "${username}" creado`;
                this.usersFormStatus.style.color = '#15803d';
            }
            await this.loadUsers();
        } catch (error) {
            if (this.usersFormStatus) {
                this.usersFormStatus.textContent = error.message;
                this.usersFormStatus.style.color = '#b91c1c';
            }
        }
    }

    async saveUser(userId) {
        if (!this.isSuperUser() || !this.usersList) return;
        const card = this.usersList.querySelector(`.user-card[data-user-id="${userId}"]`);
        if (!card) return;

        const passwordInput = card.querySelector('.user-password-input');
        const gerenteInput = card.querySelector('.user-gerente-input');
        const password = passwordInput ? passwordInput.value : '';
        const gerenteEmail = gerenteInput ? gerenteInput.value.trim() : '';
        const permissions = this.collectPermissionsFromForm(card);

        try {
            const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    permissions,
                    gerenteEmail,
                    ...(password ? { password } : {})
                })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo guardar');
            if (passwordInput) passwordInput.value = '';
            this.showStatus(`Usuario actualizado`, 'success');
            await this.loadUsers();
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async deleteUser(userId) {
        if (!this.isSuperUser()) return;
        const user = (this.managedUsers || []).find((u) => u.id === userId);
        const name = user ? user.username : userId;
        if (!confirm(`¿Eliminar al usuario "${name}"?`)) return;

        try {
            const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
                method: 'DELETE'
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'No se pudo eliminar');
            this.showStatus(`Usuario "${name}" eliminado`, 'success');
            await this.loadUsers();
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
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
        const senderName = selectedOpt && selectedOpt.dataset.name ? selectedOpt.dataset.name.trim() : '';
        const label =
            (this.sessionLabelInput && this.sessionLabelInput.value.trim()) ||
            senderName ||
            openwaSessionId;

        try {
            const response = await fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ openwaSessionId, label, senderName })
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

    async saveSessionSenderName(sessionId) {
        const input = this.sessionsList
            ? this.sessionsList.querySelector(`.session-sender-input[data-id="${sessionId}"]`)
            : null;
        const senderName = input ? input.value.trim() : '';
        if (!senderName) {
            this.showStatus('Escribe un nombre de remitente', 'error');
            return;
        }

        try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ senderName })
            });
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'No se pudo guardar');
            }
            await this.loadSessions();
            this.showStatus(`Remitente actualizado: ${senderName}`, 'success');
            if (this.cvsData && this.cvsData.length > 0) {
                this.displayResults();
            }
        } catch (error) {
            this.showStatus(`Error: ${error.message}`, 'error');
        }
    }

    async syncSessionSenderName(sessionId) {
        try {
            const response = await fetch(
                `/api/sessions/${encodeURIComponent(sessionId)}/sync-sender-name`,
                { method: 'POST' }
            );
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'No se pudo sincronizar');
            }
            await this.loadSessions();
            const name = data.session && data.session.senderName ? data.session.senderName : '';
            this.showStatus(
                name ? `Nombre sincronizado desde WhatsApp: ${name}` : 'Nombre sincronizado',
                'success'
            );
            if (this.cvsData && this.cvsData.length > 0) {
                this.displayResults();
            }
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
                if (config.user) {
                    this.currentUser = config.user;
                    if (this.myGerenteEmail && config.user.gerenteEmail != null) {
                        this.myGerenteEmail.value = config.user.gerenteEmail || '';
                    }
                }
                if (Array.isArray(config.sessions)) {
                    this.configuredSessions = config.sessions;
                    this.renderSessionUI();
                }
                if (config.panel && typeof config.panel === 'object') {
                    this.panelConfig = {
                        configured: Boolean(config.panel.configured),
                        publicCvUrlConfigured: Boolean(config.panel.publicCvUrlConfigured),
                        gerenteEmail: config.panel.gerenteEmail || '',
                        baseUrl: config.panel.baseUrl || ''
                    };
                    if (
                        this.myGerenteEmail &&
                        !this.myGerenteEmail.value &&
                        config.panel.gerenteEmail
                    ) {
                        this.myGerenteEmail.value = config.panel.gerenteEmail;
                    }
                }
                this.applyPermissionUI();
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
            const saludoTexto = cv.saludo || '';
            const mensajeTexto = cv.mensajeIA || 'Pendiente de generar...';
            const mensajeCompleto = saludoTexto
                ? `${saludoTexto}\n\n${mensajeTexto}`
                : mensajeTexto;
            const mensajeParaMostrar = this.resolveMessageForDisplay(mensajeCompleto);

            // Escapar HTML para seguridad pero preservar saltos de línea
            const mensajeEscapado = mensajeParaMostrar
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');

            // Escapar HTML para nombre, teléfono y experiencia
            const nombreEscapado = (cv.nombre || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
            const telefonoEscapado = (cv.telefono || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
            const experienciaEscapada = (cv.experiencia || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
            const saludoEscapadoAttr = saludoTexto.replace(/"/g, '&quot;');

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
                    <div class="mensaje-edit-wrap" id="edit-wrap-${mensajeId}" style="display: none;">
                        <label class="saludo-edit-label">Saludo (1er mensaje)</label>
                        <input type="text" class="saludo-edit" id="saludo-edit-${mensajeId}" value="${saludoEscapadoAttr}" placeholder="Hola Nombre / Qué tal Nombre">
                        <label class="saludo-edit-label">Mensaje principal (2º mensaje)</label>
                        <textarea class="mensaje-edit" id="edit-${mensajeId}" rows="6">${mensajeTexto}</textarea>
                    </div>
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
                    <button class="btn-agendar" data-index="${index}" ${cv.procesado && cv.cvId ? '' : 'disabled'} title="Agendar reunión en Panel">
                        📅 Agendar
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
            const editWrap = row.querySelector(`#edit-wrap-${mensajeId}`);
            const saludoInput = row.querySelector(`#saludo-edit-${mensajeId}`);
            const editTextarea = row.querySelector(`#edit-${mensajeId}`);

            editBtn.addEventListener('click', () => {
                displayDiv.style.display = 'none';
                editWrap.style.display = 'block';
                editBtn.style.display = 'none';
                saveBtn.style.display = 'inline-block';
                cancelBtn.style.display = 'inline-block';
                saludoInput.focus();
            });

            saveBtn.addEventListener('click', () => {
                const nuevoSaludo = saludoInput.value.trim();
                const nuevoMensaje = editTextarea.value.trim();
                if (nuevoMensaje) {
                    this.cvsData[index].saludo = nuevoSaludo;
                    this.cvsData[index].mensajeIA = nuevoMensaje;
                    const completo = nuevoSaludo
                        ? `${nuevoSaludo}\n\n${nuevoMensaje}`
                        : nuevoMensaje;
                    const mensajeEscapado = this.resolveMessageForDisplay(completo)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#039;');
                    displayDiv.innerHTML = mensajeEscapado;
                    displayDiv.style.display = 'block';
                    editWrap.style.display = 'none';
                    editBtn.style.display = 'inline-block';
                    saveBtn.style.display = 'none';
                    cancelBtn.style.display = 'none';
                    this.showStatus('Mensaje guardado correctamente', 'success');
                } else {
                    this.showStatus('El mensaje no puede estar vacío', 'error');
                }
            });

            cancelBtn.addEventListener('click', () => {
                saludoInput.value = saludoTexto;
                editTextarea.value = mensajeTexto;
                displayDiv.style.display = 'block';
                editWrap.style.display = 'none';
                editBtn.style.display = 'inline-block';
                saveBtn.style.display = 'none';
                cancelBtn.style.display = 'none';
            });

            const agendarBtn = row.querySelector('.btn-agendar');
            if (agendarBtn && !agendarBtn.disabled) {
                agendarBtn.addEventListener('click', () => this.openAgendarModal(index));
            }
        });

        this.resultsSection.style.display = 'block';
    }

    initAgendarModal() {
        this.agendarModal = document.getElementById('agendarModal');
        this.agendarCvLabel = document.getElementById('agendarCvLabel');
        this.agendarGerenteEmail = document.getElementById('agendarGerenteEmail');
        this.agendarVendedor = document.getElementById('agendarVendedor');
        this.agendarSlot = document.getElementById('agendarSlot');
        this.agendarUrlReunion = document.getElementById('agendarUrlReunion');
        this.agendarLeadCorreo = document.getElementById('agendarLeadCorreo');
        this.agendarHint = document.getElementById('agendarHint');
        this.agendarStatus = document.getElementById('agendarStatus');
        this.agendarConfirmBtn = document.getElementById('agendarConfirmBtn');
        this.agendarCvSelectWrap = document.getElementById('agendarCvSelectWrap');
        this.agendarCvSelect = document.getElementById('agendarCvSelect');
        this.agendarCvUploadWrap = document.getElementById('agendarCvUploadWrap');
        this.agendarCvFile = document.getElementById('agendarCvFile');
        this.agendarCvUploadHint = document.getElementById('agendarCvUploadHint');
        this.agendarCvId = null;
        this.agendarLeadNombre = '';
        this.agendarLeadTelefono = '';
        this.agendarNeedsCvUpload = false;

        const close = () => this.closeAgendarModal();
        const closeBtn = document.getElementById('agendarModalClose');
        const cancelBtn = document.getElementById('agendarCancelBtn');
        if (closeBtn) closeBtn.addEventListener('click', close);
        if (cancelBtn) cancelBtn.addEventListener('click', close);
        if (this.agendarModal) {
            this.agendarModal.addEventListener('click', (e) => {
                if (e.target === this.agendarModal) close();
            });
        }
        if (this.agendarVendedor) {
            this.agendarVendedor.addEventListener('change', () => this.renderAgendarSlots());
        }
        if (this.agendarConfirmBtn) {
            this.agendarConfirmBtn.addEventListener('click', () => this.confirmAgendarReunion());
        }
        if (this.agendarCvSelect) {
            this.agendarCvSelect.addEventListener('change', () => this.onAgendarCvSelectChange());
        }
        if (this.agendarCvFile) {
            this.agendarCvFile.addEventListener('change', () => {
                const file = this.agendarCvFile.files && this.agendarCvFile.files[0];
                if (file) {
                    this.agendarCvId = null;
                    this.agendarNeedsCvUpload = true;
                    if (this.agendarCvSelect) this.agendarCvSelect.value = '';
                    if (this.agendarCvLabel) {
                        this.agendarCvLabel.textContent = `CV a subir: ${file.name}${
                            this.agendarLeadNombre ? ` — ${this.agendarLeadNombre}` : ''
                        }`;
                    }
                }
            });
        }
    }

    setAgendarStatus(message, type = 'info') {
        if (!this.agendarStatus) return;
        if (!message) {
            this.agendarStatus.style.display = 'none';
            this.agendarStatus.textContent = '';
            return;
        }
        this.agendarStatus.style.display = 'block';
        this.agendarStatus.className = `agendar-status ${type}`;
        this.agendarStatus.textContent = message;
    }

    closeAgendarModal() {
        if (this.agendarModal) {
            this.agendarModal.style.display = 'none';
            this.agendarModal.setAttribute('aria-hidden', 'true');
        }
        this.agendarCvIndex = null;
        this.agendarCvId = null;
        this.agendarLeadNombre = '';
        this.agendarLeadTelefono = '';
        this.agendarNeedsCvUpload = false;
        if (this.agendarConfirmBtn) this.agendarConfirmBtn.disabled = false;
        if (this.agendarCvSelectWrap) this.agendarCvSelectWrap.style.display = 'none';
        if (this.agendarCvUploadWrap) this.agendarCvUploadWrap.style.display = 'none';
        if (this.agendarCvFile) this.agendarCvFile.value = '';
        if (this.agendarCvSelect) this.agendarCvSelect.innerHTML = '';
        if (this.agendarCvSelect) this.agendarCvSelect.disabled = false;
    }

    async refreshCvsFromServer({ silent = false } = {}) {
        try {
            const response = await fetch('/cvs-status');
            const data = await response.json();
            if (data.success && Array.isArray(data.cvs)) {
                this.cvsData = data.cvs;
                if (this.cvsData.length > 0) {
                    this.displayResults();
                }
                return this.cvsData;
            }
        } catch (error) {
            if (!silent) console.warn('No se pudieron refrescar CVs:', error.message);
        }
        return this.cvsData || [];
    }

    getReusableCvs() {
        return (this.cvsData || []).filter((cv) => cv && cv.procesado && cv.cvId);
    }

    phonesMatch(a, b) {
        const na = this.normalizePhoneDigits(a);
        const nb = this.normalizePhoneDigits(b);
        if (!na || !nb) return false;
        if (na === nb) return true;
        if (na.endsWith(nb) || nb.endsWith(na)) return true;
        const ta = na.slice(-10);
        const tb = nb.slice(-10);
        if (ta.length === 10 && ta === tb) return true;
        const stripMx = (p) => {
            if (p.startsWith('521') && p.length >= 13) return p.slice(3);
            if (p.startsWith('52') && p.length >= 12) return p.slice(2);
            return p;
        };
        const sa = stripMx(na);
        const sb = stripMx(nb);
        return sa === sb || sa.slice(-10) === sb.slice(-10);
    }

    populateAgendarCvSelect({ selectedCvId = '', preferredPhone = '' } = {}) {
        if (!this.agendarCvSelect) return [];
        const reusable = this.getReusableCvs();
        const options = ['<option value="">Selecciona un CV cargado…</option>'];
        let autoId = selectedCvId;
        if (!autoId && preferredPhone) {
            const matched = this.findCvByPhone(preferredPhone);
            if (matched) autoId = matched.cvId;
        }
        reusable.forEach((cv) => {
            const label = `${cv.nombre || 'Sin nombre'} · ${cv.telefono || 'sin tel'} · ${cv.archivoOriginal || cv.cvId}`;
            const selected = cv.cvId === autoId ? ' selected' : '';
            options.push(
                `<option value="${this.escapeHtml(cv.cvId)}"${selected}>${this.escapeHtml(label)}</option>`
            );
        });
        this.agendarCvSelect.innerHTML = options.join('');
        if (this.agendarCvSelectWrap) {
            this.agendarCvSelectWrap.style.display = reusable.length > 0 ? 'block' : 'none';
        }
        return reusable;
    }

    onAgendarCvSelectChange() {
        const cvId = this.agendarCvSelect ? this.agendarCvSelect.value : '';
        if (!cvId) {
            this.agendarCvId = null;
            return;
        }
        const cv = this.getReusableCvs().find((c) => c.cvId === cvId);
        if (!cv) return;
        this.agendarCvId = cv.cvId;
        this.agendarNeedsCvUpload = false;
        this.agendarLeadNombre = cv.nombre || this.agendarLeadNombre || '';
        if (!this.agendarLeadTelefono) this.agendarLeadTelefono = cv.telefono || '';
        if (this.agendarCvFile) this.agendarCvFile.value = '';
        if (this.agendarCvLabel) {
            this.agendarCvLabel.textContent = `CV reciclado: ${cv.nombre || cv.archivoOriginal} (${cv.archivoOriginal})`;
        }
        this.setAgendarStatus('Usando el CV ya cargado en leads. No hace falta subirlo de nuevo.', 'info');
    }

    canOpenAgendarModal() {
        if (!this.panelConfig.configured) {
            this.showStatus(
                'Integración con panel no configurada. Define MSG_INTEGRATION_API_KEY en .env',
                'error'
            );
            return false;
        }
        const gerentePreview =
            (this.currentUser && this.currentUser.gerenteEmail) ||
            this.panelConfig.gerenteEmail ||
            '';
        if (!gerentePreview) {
            this.showStatus(
                'Guarda tu correo de gerente arriba (Tu correo en Panel) antes de agendar.',
                'error'
            );
            return false;
        }
        if (!this.panelConfig.publicCvUrlConfigured) {
            this.showStatus(
                'Configura WEBHOOK_PUBLIC_URL para que el panel pueda descargar el CV.',
                'error'
            );
            return false;
        }
        return true;
    }

    normalizePhoneDigits(raw) {
        return String(raw || '').replace(/\D/g, '');
    }

    findCvByPhone(phone) {
        if (!phone) return null;
        return this.getReusableCvs().find((cv) => this.phonesMatch(cv.telefono, phone)) || null;
    }

    phoneFromChatId(chatId) {
        const local = String(chatId || '').replace(/@.*$/, '');
        return this.normalizePhoneDigits(local);
    }

    async prepareAgendarModalShell({
        label,
        leadNombre,
        leadTelefono,
        cvId,
        needsUpload,
        showCvPicker = false,
        preferredPhone = '',
        lockMatchedCv = false,
        matchSource = '',
        presetSlot = null
    }) {
        this.agendarCvId = cvId || null;
        this.agendarLeadNombre = leadNombre || '';
        this.agendarLeadTelefono = leadTelefono || '';
        this.agendarNeedsCvUpload = Boolean(needsUpload);

        if (this.agendarCvLabel) {
            this.agendarCvLabel.textContent = label || 'Agendar reunión';
        }

        if (lockMatchedCv && cvId) {
            // CV del mismo número al que se envió el mensaje: no pedir elegir
            const cv =
                this.getReusableCvs().find((c) => c.cvId === cvId) || {
                    cvId,
                    nombre: leadNombre,
                    telefono: leadTelefono,
                    archivoOriginal: ''
                };
            if (this.agendarCvSelectWrap) {
                this.agendarCvSelectWrap.style.display = 'block';
            }
            if (this.agendarCvSelect) {
                const shown = `${cv.nombre || 'Lead'} · ${cv.telefono || leadTelefono || ''} · ${cv.archivoOriginal || cv.cvId}`;
                this.agendarCvSelect.innerHTML = `<option value="${this.escapeHtml(cv.cvId)}" selected>${this.escapeHtml(shown)}</option>`;
                this.agendarCvSelect.disabled = true;
            }
            if (this.agendarCvUploadWrap) this.agendarCvUploadWrap.style.display = 'none';
            this.agendarNeedsCvUpload = false;
            const via =
                matchSource === 'historial'
                    ? 'ligado al envío de WhatsApp'
                    : 'coincidente con el teléfono del chat';
            this.setAgendarStatus(
                `CV asignado automáticamente (${via}). Es el mismo lead del mensaje.`,
                'info'
            );
        } else if (showCvPicker) {
            if (this.agendarCvSelect) this.agendarCvSelect.disabled = false;
            const reusable = this.populateAgendarCvSelect({
                selectedCvId: cvId || '',
                preferredPhone: preferredPhone || leadTelefono || ''
            });
            if (reusable.length > 0) {
                if (this.agendarCvSelect && this.agendarCvSelect.value) {
                    this.onAgendarCvSelectChange();
                    this.agendarNeedsCvUpload = false;
                }
                if (this.agendarCvUploadWrap) this.agendarCvUploadWrap.style.display = 'block';
                if (this.agendarCvUploadHint) {
                    this.agendarCvUploadHint.textContent =
                        'Opcional: solo si el lead no está en la lista de CVs cargados.';
                }
            } else {
                if (this.agendarCvSelectWrap) this.agendarCvSelectWrap.style.display = 'none';
                if (this.agendarCvUploadWrap) this.agendarCvUploadWrap.style.display = 'block';
                if (this.agendarCvUploadHint) {
                    this.agendarCvUploadHint.textContent =
                        'No hay CVs en la sesión. Sube el PDF o carga leads en “Cargar CVs”.';
                }
                this.agendarNeedsCvUpload = true;
            }
        } else {
            if (this.agendarCvSelect) this.agendarCvSelect.disabled = false;
            if (this.agendarCvSelectWrap) this.agendarCvSelectWrap.style.display = 'none';
            if (this.agendarCvUploadWrap) {
                this.agendarCvUploadWrap.style.display = needsUpload ? 'block' : 'none';
            }
        }

        if (this.agendarCvFile) this.agendarCvFile.value = '';

        if (this.agendarGerenteEmail) {
            this.agendarGerenteEmail.value =
                (this.currentUser && this.currentUser.gerenteEmail) ||
                this.panelConfig.gerenteEmail ||
                '';
        }
        if (this.agendarUrlReunion) this.agendarUrlReunion.value = '';
        if (this.agendarLeadCorreo) this.agendarLeadCorreo.value = '';
        if (!lockMatchedCv && !this.agendarCvId) this.setAgendarStatus('');
        if (this.agendarVendedor) {
            this.agendarVendedor.innerHTML = '<option value="">Cargando disponibilidad…</option>';
            this.agendarVendedor.disabled = true;
        }
        if (this.agendarSlot) {
            this.agendarSlot.innerHTML = '<option value="">Elige un vendedor primero</option>';
            this.agendarSlot.disabled = true;
        }

        if (this.agendarModal) {
            this.agendarModal.style.display = 'flex';
            this.agendarModal.setAttribute('aria-hidden', 'false');
        }

        try {
            const data = await this.fetchDisponibilidad(this.agendarGerenteEmail?.value);
            this.disponibilidadData = data;
            this.populateAgendarVendedores(data);
            if (presetSlot && presetSlot.vendedorId) {
                this.applyPresetAgendarSlot(presetSlot);
            }
        } catch (error) {
            this.setAgendarStatus(error.message || 'No se pudo cargar disponibilidad', 'error');
            if (this.agendarVendedor) {
                this.agendarVendedor.innerHTML = '<option value="">Sin disponibilidad</option>';
            }
        }
    }

    applyPresetAgendarSlot(preset) {
        if (!preset || !this.agendarVendedor) return;
        const vendedorId = String(preset.vendedorId);
        this.agendarVendedor.value = vendedorId;
        this.renderAgendarSlots();
        if (!this.agendarSlot) return;

        const target = JSON.stringify({
            fecha: preset.fecha,
            horaInicio: preset.horaInicio,
            horaFin: preset.horaFin
        });
        const encoded = encodeURIComponent(target);
        let found = false;
        Array.from(this.agendarSlot.options).forEach((opt) => {
            if (opt.value === encoded) {
                opt.selected = true;
                found = true;
            }
        });
        if (!found && preset.fecha && preset.horaInicio) {
            // Añadir el slot clickeado aunque el cache haya cambiado
            const label = `${preset.fecha} ${preset.horaInicio}–${preset.horaFin}`;
            const opt = document.createElement('option');
            opt.value = encoded;
            opt.textContent = label;
            opt.selected = true;
            this.agendarSlot.appendChild(opt);
            this.agendarSlot.disabled = false;
        }
        if (preset.vendedorNombre) {
            this.setAgendarStatus(
                `Horario preseleccionado: ${preset.vendedorNombre} · ${preset.fecha} ${preset.horaInicio}. Elige el lead (CV) a agendar.`,
                'info'
            );
        }
    }

    async openAgendarModal(index) {
        const cv = this.cvsData[index];
        if (!cv || !cv.cvId) {
            this.showStatus('Este CV no tiene archivo guardado. Vuelve a subirlo.', 'error');
            return;
        }
        if (!this.canOpenAgendarModal()) return;

        this.agendarCvIndex = index;
        await this.prepareAgendarModalShell({
            label: `CV: ${cv.nombre || cv.archivoOriginal} (${cv.archivoOriginal})`,
            leadNombre: cv.nombre || '',
            leadTelefono: cv.telefono || '',
            cvId: cv.cvId,
            needsUpload: false,
            showCvPicker: false
        });
    }

    async openAgendarFromConversation() {
        const active = this.activeConversation;
        if (!active || active.isGroup) {
            this.showStatus('Abre un chat individual para agendar.', 'error');
            return;
        }
        if (!this.canControlSession(active.sessionId)) {
            this.showStatus('No tienes permiso de control en esta sesión.', 'error');
            return;
        }
        if (!this.canOpenAgendarModal()) return;

        await this.refreshCvsFromServer({ silent: true });

        const phone = this.phoneFromChatId(active.chatId);
        const name = String(active.name || '').trim() || 'Candidato';

        // Resolver en servidor: CV ligado al número del mensaje / historial
        let matched = null;
        let matchSource = '';
        if (phone) {
            try {
                const response = await fetch(
                    `/api/panel/cv-by-phone?phone=${encodeURIComponent(phone)}`
                );
                const data = await response.json();
                if (data.success && data.found && data.cv && data.cv.cvId) {
                    matched =
                        this.getReusableCvs().find((c) => c.cvId === data.cv.cvId) ||
                        data.cv;
                    matchSource = data.matchSource || 'telefono';
                }
            } catch (err) {
                console.warn('cv-by-phone:', err.message);
            }
        }
        if (!matched) {
            matched = this.findCvByPhone(phone);
            if (matched) matchSource = 'telefono';
        }

        const reusable = this.getReusableCvs();
        this.agendarCvIndex = matched
            ? (this.cvsData || []).findIndex((c) => c.cvId === matched.cvId)
            : null;

        const label = matched
            ? `Chat: ${name} · CV automático: ${matched.nombre || matched.archivoOriginal}`
            : reusable.length > 0
              ? `Chat: ${name}${phone ? ` · +${phone}` : ''} — elige el CV del lead`
              : `Chat: ${name}${phone ? ` · +${phone}` : ''} — no hay CVs cargados`;

        await this.prepareAgendarModalShell({
            label,
            leadNombre: (matched && matched.nombre) || name,
            leadTelefono: phone ? `+${phone}` : (matched && matched.telefono) || '',
            cvId: matched ? matched.cvId : null,
            needsUpload: !matched && reusable.length === 0,
            showCvPicker: !matched,
            preferredPhone: phone,
            lockMatchedCv: Boolean(matched),
            matchSource
        });
    }

    async ensureAgendarCvId() {
        if (this.agendarCvSelect && this.agendarCvSelect.value) {
            this.agendarCvId = this.agendarCvSelect.value;
            this.agendarNeedsCvUpload = false;
        }

        if (this.agendarCvId) return this.agendarCvId;

        const file = this.agendarCvFile && this.agendarCvFile.files && this.agendarCvFile.files[0];
        if (!file) {
            if (this.getReusableCvs().length > 0) {
                throw new Error('Selecciona un CV de la lista de leads cargados.');
            }
            throw new Error('Selecciona el PDF del CV del candidato.');
        }

        const formData = new FormData();
        formData.append('cv', file);
        if (this.agendarLeadTelefono) formData.append('telefono', this.agendarLeadTelefono);
        if (this.agendarLeadNombre) formData.append('nombre', this.agendarLeadNombre);

        this.setAgendarStatus('Subiendo CV…', 'info');
        const response = await fetch('/api/panel/cv-upload', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'No se pudo subir el CV');
        }

        this.agendarCvId = data.cvId;
        this.agendarNeedsCvUpload = false;
        await this.refreshCvsFromServer({ silent: true });
        return this.agendarCvId;
    }

    async fetchDisponibilidad(gerenteEmail, force = false, range = null) {
        const cacheTtlMs = 90 * 1000;
        const fechaInicio = range && range.fechaInicio ? range.fechaInicio : '';
        const fechaFin = range && range.fechaFin ? range.fechaFin : '';
        const cacheKey = `${gerenteEmail || ''}|${fechaInicio}|${fechaFin}`;
        const sameKey =
            this.disponibilidadCache &&
            String(this.disponibilidadCache._cacheKey || '') === cacheKey;
        if (
            !force &&
            sameKey &&
            this.disponibilidadCacheAt &&
            Date.now() - this.disponibilidadCacheAt < cacheTtlMs
        ) {
            return this.disponibilidadCache;
        }

        const params = new URLSearchParams();
        if (gerenteEmail) params.set('gerenteEmail', gerenteEmail);
        if (fechaInicio) params.set('fechaInicio', fechaInicio);
        if (fechaFin) params.set('fechaFin', fechaFin);
        const response = await fetch(`/api/panel/disponibilidad?${params.toString()}`);
        const data = await response.json();
        if (!response.ok || data.success === false) {
            throw new Error(data.error || data.message || `Error ${response.status}`);
        }
        data._gerenteEmail = gerenteEmail || '';
        data._cacheKey = cacheKey;
        this.disponibilidadCache = data;
        this.disponibilidadCacheAt = Date.now();
        return data;
    }

    initDisponibilidadCalendar() {
        this.disponibilidadPanel = document.getElementById('disponibilidadPanel');
        this.disponibilidadCalendar = document.getElementById('disponibilidadCalendar');
        this.disponibilidadStatus = document.getElementById('disponibilidadStatus');
        this.disponibilidadRangeLabel = document.getElementById('disponibilidadRangeLabel');
        this.dispWeekOffset = 0;
        this.calendarDisponibilidad = null;

        const prev = document.getElementById('dispPrevWeekBtn');
        const next = document.getElementById('dispNextWeekBtn');
        const refresh = document.getElementById('dispRefreshBtn');
        if (prev) {
            prev.addEventListener('click', () => {
                this.dispWeekOffset -= 1;
                this.loadDisponibilidadCalendar({ force: true });
            });
        }
        if (next) {
            next.addEventListener('click', () => {
                this.dispWeekOffset += 1;
                this.loadDisponibilidadCalendar({ force: true });
            });
        }
        if (refresh) {
            refresh.addEventListener('click', () => this.loadDisponibilidadCalendar({ force: true }));
        }
        if (this.disponibilidadCalendar) {
            this.disponibilidadCalendar.addEventListener('click', (e) => {
                const btn = e.target.closest('.disp-slot');
                if (!btn) return;
                this.openAgendarFromCalendarSlot({
                    vendedorId: btn.dataset.vendedorId,
                    vendedorNombre: btn.dataset.vendedorNombre,
                    fecha: btn.dataset.fecha,
                    horaInicio: btn.dataset.horaInicio,
                    horaFin: btn.dataset.horaFin
                });
            });
        }
    }

    initAgendaPendingPanel() {
        this.agendaPendingPanel = document.getElementById('agendaPendingPanel');
        this.agendaPendingList = document.getElementById('agendaPendingList');
        this.agendaPendingStatus = document.getElementById('agendaPendingStatus');
        this.agendaPendingCount = document.getElementById('agendaPendingCount');
        this.agendaPendingItems = [];
        const refresh = document.getElementById('agendaPendingRefreshBtn');
        if (refresh) {
            refresh.addEventListener('click', () => this.loadAgendaPending());
        }
        if (this.agendaPendingList) {
            this.agendaPendingList.addEventListener('click', (e) => {
                const confirmBtn = e.target.closest('[data-agenda-confirm]');
                const cancelBtn = e.target.closest('[data-agenda-cancel]');
                if (confirmBtn) {
                    this.confirmAgendaPending(confirmBtn.getAttribute('data-agenda-confirm'));
                } else if (cancelBtn) {
                    this.cancelAgendaPending(cancelBtn.getAttribute('data-agenda-cancel'));
                }
            });
        }
    }

    setAgendaPendingStatus(msg) {
        if (this.agendaPendingStatus) this.agendaPendingStatus.textContent = msg || '';
    }

    async loadAgendaPending() {
        if (!this.agendaPendingList) return;
        if (!(this.isSuperUser() || this.getControllableSessions().length > 0)) return;
        this.setAgendaPendingStatus('Cargando…');
        try {
            const response = await fetch('/api/agenda/pending');
            const data = await response.json();
            if (!response.ok || data.success === false) {
                throw new Error(data.error || `Error ${response.status}`);
            }
            this.agendaPendingItems = Array.isArray(data.items) ? data.items : [];
            this.renderAgendaPending();
            this.setAgendaPendingStatus(
                this.agendaPendingItems.length
                    ? `${this.agendaPendingItems.length} pendiente(s)`
                    : 'Sin pendientes'
            );
        } catch (error) {
            this.setAgendaPendingStatus(error.message);
            if (this.agendaPendingList) {
                this.agendaPendingList.innerHTML = `<p class="auto-reply-empty">Error: ${this.escapeHtml(error.message)}</p>`;
            }
        }
    }

    renderAgendaPending() {
        if (!this.agendaPendingList) return;
        if (this.agendaPendingCount) {
            this.agendaPendingCount.textContent = String(this.agendaPendingItems.length);
        }
        if (!this.agendaPendingItems.length) {
            this.agendaPendingList.innerHTML =
                '<p class="auto-reply-empty">No hay citas pendientes.</p>';
            return;
        }

        this.agendaPendingList.innerHTML = this.agendaPendingItems
            .map((item) => {
                const vendors = Array.isArray(item.candidateVendors) ? item.candidateVendors : [];
                const options =
                    vendors.length > 0
                        ? vendors
                              .map((v) => {
                                  const label = v.nombre
                                      ? `${v.nombre} (${v.gerenteEmail || ''})`
                                      : `${v.vendedorId} · ${v.gerenteEmail || ''}`;
                                  return `<option value="${this.escapeHtml(v.vendedorId)}" data-gerente="${this.escapeHtml(v.gerenteEmail || '')}">${this.escapeHtml(label)}</option>`;
                              })
                              .join('')
                        : '<option value="">(sin candidatos — escribe id abajo)</option>';
                const when =
                    item.label ||
                    `${item.fecha || ''} ${item.horaInicio || ''}–${item.horaFin || ''}`;
                const sessionLabel = item.logicalSessionId
                    ? this.getSessionLabel(item.logicalSessionId) || item.logicalSessionId
                    : '—';
                return `
                <div class="agenda-pending-card" data-pending-id="${this.escapeHtml(item.id)}">
                    <div class="agenda-pending-card-top">
                        <div class="agenda-pending-meta">
                            <strong>${this.escapeHtml(item.contactName || item.telefono || 'Lead')}</strong>
                            · ${this.escapeHtml(item.telefono || '')}<br>
                            ${this.escapeHtml(when)} · línea ${this.escapeHtml(sessionLabel)}
                            ${item.cvId ? ` · CV ${this.escapeHtml(String(item.cvId).slice(0, 8))}…` : ''}
                        </div>
                    </div>
                    <div class="agenda-pending-form">
                        <select class="form-select agenda-pending-vendor" data-id="${this.escapeHtml(item.id)}">
                            <option value="">Vendedor…</option>
                            ${options}
                        </select>
                        <input type="url" class="form-select agenda-pending-url" data-id="${this.escapeHtml(item.id)}" placeholder="https://zoom.us/… o Meet">
                        <button type="button" class="btn btn-primary btn-sm" data-agenda-confirm="${this.escapeHtml(item.id)}">Confirmar</button>
                        <button type="button" class="btn btn-danger btn-sm" data-agenda-cancel="${this.escapeHtml(item.id)}">Cancelar</button>
                    </div>
                </div>`;
            })
            .join('');
    }

    async confirmAgendaPending(id) {
        const card = this.agendaPendingList?.querySelector(`[data-pending-id="${id}"]`);
        if (!card) return;
        const select = card.querySelector('.agenda-pending-vendor');
        const urlInput = card.querySelector('.agenda-pending-url');
        const vendedorId = select ? select.value.trim() : '';
        const urlReunion = urlInput ? urlInput.value.trim() : '';
        const gerenteEmail =
            select && select.selectedOptions[0]
                ? select.selectedOptions[0].getAttribute('data-gerente') || ''
                : '';
        if (!vendedorId || !urlReunion) {
            this.setAgendaPendingStatus('Elige vendedor y pega la liga');
            return;
        }
        this.setAgendaPendingStatus('Confirmando…');
        try {
            const response = await fetch(`/api/agenda/pending/${encodeURIComponent(id)}/confirm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ vendedorId, urlReunion, gerenteEmail: gerenteEmail || undefined })
            });
            const data = await response.json();
            if (!response.ok || data.success === false) {
                throw new Error(data.error || `Error ${response.status}`);
            }
            const wa = data.whatsapp && data.whatsapp.sent ? 'WhatsApp enviado' : 'reunión OK (revisa WhatsApp)';
            this.setAgendaPendingStatus(`Confirmada · ${wa}`);
            await this.loadAgendaPending();
        } catch (error) {
            this.setAgendaPendingStatus(error.message);
        }
    }

    async cancelAgendaPending(id) {
        if (!confirm('¿Cancelar esta cita pendiente?')) return;
        try {
            const response = await fetch(`/api/agenda/pending/${encodeURIComponent(id)}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            if (!response.ok || data.success === false) {
                throw new Error(data.error || `Error ${response.status}`);
            }
            await this.loadAgendaPending();
        } catch (error) {
            this.setAgendaPendingStatus(error.message);
        }
    }

    formatYmd(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    addDaysYmd(ymd, days) {
        const [y, m, d] = String(ymd).split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        dt.setDate(dt.getDate() + days);
        return this.formatYmd(dt);
    }

    getCalendarWeekRange() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const start = new Date(today);
        start.setDate(start.getDate() + this.dispWeekOffset * 7);
        const fechaInicio = this.formatYmd(start);
        const fechaFin = this.addDaysYmd(fechaInicio, 6);
        return { fechaInicio, fechaFin };
    }

    setDisponibilidadStatus(msg) {
        if (this.disponibilidadStatus) this.disponibilidadStatus.textContent = msg || '';
    }

    async loadDisponibilidadCalendar({ force = false, silent = false } = {}) {
        if (!this.disponibilidadCalendar) return;

        const gerenteEmail =
            (this.currentUser && this.currentUser.gerenteEmail) ||
            this.panelConfig.gerenteEmail ||
            '';

        if (!this.panelConfig.configured) {
            this.disponibilidadCalendar.innerHTML =
                '<p class="auto-reply-empty">Configura MSG_INTEGRATION_API_KEY para ver disponibilidad.</p>';
            this.setDisponibilidadStatus('');
            return;
        }
        if (!gerenteEmail) {
            this.disponibilidadCalendar.innerHTML =
                '<p class="auto-reply-empty">Guarda tu correo de gerente arriba para cargar horarios del equipo.</p>';
            this.setDisponibilidadStatus('');
            return;
        }

        const range = this.getCalendarWeekRange();
        if (this.disponibilidadRangeLabel) {
            this.disponibilidadRangeLabel.textContent = `${range.fechaInicio} → ${range.fechaFin}`;
        }
        if (!silent) this.setDisponibilidadStatus('Cargando horarios…');

        try {
            const data = await this.fetchDisponibilidad(gerenteEmail, force, range);
            this.calendarDisponibilidad = data;
            this.renderDisponibilidadCalendar(data, range);
            const totalSlots = (data.vendedores || []).reduce(
                (acc, v) => acc + (Array.isArray(v.disponibilidad) ? v.disponibilidad.length : 0),
                0
            );
            this.setDisponibilidadStatus(
                `${data.vendedores?.length || 0} vendedor(es) · ${totalSlots} slot(s) libres · ${data.gerente?.nombre || gerenteEmail}`
            );
        } catch (error) {
            this.disponibilidadCalendar.innerHTML = `<p class="auto-reply-empty">Error: ${this.escapeHtml(error.message)}</p>`;
            this.setDisponibilidadStatus(error.message);
        }
    }

    renderDisponibilidadCalendar(data, range) {
        if (!this.disponibilidadCalendar) return;
        const days = [];
        for (let i = 0; i < 7; i += 1) {
            days.push(this.addDaysYmd(range.fechaInicio, i));
        }
        const today = this.formatYmd(new Date());
        const weekdayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

        // Agrupar slots por fecha
        const byDate = {};
        days.forEach((d) => {
            byDate[d] = [];
        });
        (data.vendedores || []).forEach((v) => {
            (v.disponibilidad || []).forEach((s) => {
                if (!byDate[s.fecha]) return;
                byDate[s.fecha].push({
                    ...s,
                    vendedorId: v.id,
                    vendedorNombre: v.nombre || v.correo || 'Vendedor'
                });
            });
        });
        Object.keys(byDate).forEach((d) => {
            byDate[d].sort((a, b) => String(a.horaInicio).localeCompare(String(b.horaInicio)));
        });

        this.disponibilidadCalendar.innerHTML = days
            .map((fecha) => {
                const [y, m, dayNum] = fecha.split('-').map(Number);
                const dt = new Date(y, m - 1, dayNum);
                const wd = weekdayNames[dt.getDay()];
                const slots = byDate[fecha] || [];
                const todayClass = fecha === today ? ' disp-day-today' : '';
                const slotsHtml =
                    slots.length === 0
                        ? '<p class="disp-day-empty">Sin horarios</p>'
                        : `<div class="disp-slots">${slots
                              .map(
                                  (s) => `
                            <button type="button" class="disp-slot"
                                data-vendedor-id="${this.escapeHtml(s.vendedorId)}"
                                data-vendedor-nombre="${this.escapeHtml(s.vendedorNombre)}"
                                data-fecha="${this.escapeHtml(s.fecha)}"
                                data-hora-inicio="${this.escapeHtml(s.horaInicio)}"
                                data-hora-fin="${this.escapeHtml(s.horaFin)}"
                                title="Agendar con ${this.escapeHtml(s.vendedorNombre)}">
                                <span class="disp-slot-time">${this.escapeHtml(s.horaInicio)}–${this.escapeHtml(s.horaFin)}</span>
                                <span class="disp-slot-vendor">${this.escapeHtml(s.vendedorNombre)}</span>
                            </button>`
                              )
                              .join('')}</div>`;

                return `
                    <div class="disp-day${todayClass}">
                        <div class="disp-day-header">
                            ${wd} ${dayNum}/${m}
                            <span class="disp-day-sub">${slots.length} libre${slots.length === 1 ? '' : 's'}</span>
                        </div>
                        ${slotsHtml}
                    </div>`;
            })
            .join('');
    }

    async openAgendarFromCalendarSlot(slot) {
        if (!slot || !slot.vendedorId || !slot.fecha) return;
        if (!this.canOpenAgendarModal()) return;

        await this.refreshCvsFromServer({ silent: true });

        // Si hay chat activo individual, intentar ligar ese lead
        let matched = null;
        let lockMatched = false;
        let leadNombre = '';
        let leadTelefono = '';
        let preferredPhone = '';

        const active = this.activeConversation;
        if (active && !active.isGroup) {
            preferredPhone = this.phoneFromChatId(active.chatId);
            leadNombre = String(active.name || '').trim();
            leadTelefono = preferredPhone ? `+${preferredPhone}` : '';
            try {
                const response = await fetch(
                    `/api/panel/cv-by-phone?phone=${encodeURIComponent(preferredPhone)}`
                );
                const data = await response.json();
                if (data.success && data.found && data.cv?.cvId) {
                    matched =
                        this.getReusableCvs().find((c) => c.cvId === data.cv.cvId) || data.cv;
                    lockMatched = true;
                }
            } catch {
                matched = this.findCvByPhone(preferredPhone);
                lockMatched = Boolean(matched);
            }
            if (!matched) matched = this.findCvByPhone(preferredPhone);
        }

        const reusable = this.getReusableCvs();
        const label = matched
            ? `Calendario · ${slot.vendedorNombre} ${slot.fecha} ${slot.horaInicio} · Lead: ${matched.nombre || matched.archivoOriginal}`
            : `Calendario · ${slot.vendedorNombre} · ${slot.fecha} ${slot.horaInicio} — ¿a quién agendar?`;

        await this.prepareAgendarModalShell({
            label,
            leadNombre: (matched && matched.nombre) || leadNombre || '',
            leadTelefono: leadTelefono || (matched && matched.telefono) || '',
            cvId: matched ? matched.cvId : null,
            needsUpload: !matched && reusable.length === 0,
            showCvPicker: !lockMatched,
            preferredPhone,
            lockMatchedCv: lockMatched,
            matchSource: lockMatched ? 'telefono' : '',
            presetSlot: {
                vendedorId: slot.vendedorId,
                vendedorNombre: slot.vendedorNombre,
                fecha: slot.fecha,
                horaInicio: slot.horaInicio,
                horaFin: slot.horaFin
            }
        });
    }

    populateAgendarVendedores(data) {
        const vendedores = Array.isArray(data.vendedores) ? data.vendedores : [];
        if (!this.agendarVendedor) return;

        if (vendedores.length === 0) {
            this.agendarVendedor.innerHTML = '<option value="">No hay vendedores con slots libres</option>';
            this.agendarVendedor.disabled = true;
            this.setAgendarStatus('No hay horarios libres en el rango consultado.', 'info');
            return;
        }

        const withSlots = vendedores.filter(
            (v) => Array.isArray(v.disponibilidad) && v.disponibilidad.length > 0
        );
        if (withSlots.length === 0) {
            this.agendarVendedor.innerHTML = '<option value="">Sin slots libres</option>';
            this.agendarVendedor.disabled = true;
            this.setAgendarStatus('Los vendedores del equipo no tienen slots libres.', 'info');
            return;
        }

        this.agendarVendedor.innerHTML =
            '<option value="">Selecciona vendedor…</option>' +
            withSlots
                .map((v) => {
                    const n = (v.disponibilidad || []).length;
                    const label = `${v.nombre || v.correo} (${n} slots)`;
                    return `<option value="${String(v.id).replace(/"/g, '')}">${label.replace(/</g, '&lt;')}</option>`;
                })
                .join('');
        this.agendarVendedor.disabled = false;
        this.setAgendarStatus('');
        this.renderAgendarSlots();
    }

    renderAgendarSlots() {
        if (!this.agendarSlot || !this.agendarVendedor) return;
        const vendedorId = this.agendarVendedor.value;
        const vendedores = Array.isArray(this.disponibilidadData?.vendedores)
            ? this.disponibilidadData.vendedores
            : [];
        const vendedor = vendedores.find((v) => String(v.id) === String(vendedorId));
        const slots = Array.isArray(vendedor?.disponibilidad) ? vendedor.disponibilidad : [];

        if (!vendedorId || slots.length === 0) {
            this.agendarSlot.innerHTML = '<option value="">Elige un vendedor primero</option>';
            this.agendarSlot.disabled = true;
            return;
        }

        this.agendarSlot.innerHTML = slots
            .map((s) => {
                const label = `${s.fecha} ${s.horaInicio}–${s.horaFin}`;
                const value = JSON.stringify({
                    fecha: s.fecha,
                    horaInicio: s.horaInicio,
                    horaFin: s.horaFin
                });
                return `<option value="${encodeURIComponent(value)}">${label}</option>`;
            })
            .join('');
        this.agendarSlot.disabled = false;
    }

    async confirmAgendarReunion() {
        const vendedorId = this.agendarVendedor?.value;
        const slotRaw = this.agendarSlot?.value;
        const urlReunion = (this.agendarUrlReunion?.value || '').trim();
        const gerenteEmail = (this.agendarGerenteEmail?.value || '').trim();
        const leadCorreo = (this.agendarLeadCorreo?.value || '').trim();

        if (!vendedorId) {
            this.setAgendarStatus('Selecciona un vendedor', 'error');
            return;
        }
        if (!slotRaw) {
            this.setAgendarStatus('Selecciona un horario', 'error');
            return;
        }
        if (!urlReunion) {
            this.setAgendarStatus('La liga de videollamada es obligatoria', 'error');
            return;
        }

        let slot;
        try {
            slot = JSON.parse(decodeURIComponent(slotRaw));
        } catch {
            this.setAgendarStatus('Slot inválido', 'error');
            return;
        }

        if (this.agendarConfirmBtn) this.agendarConfirmBtn.disabled = true;

        try {
            const cvId = await this.ensureAgendarCvId();
            this.setAgendarStatus('Creando reunión (el panel analiza el CV con DeepSeek)…', 'info');
            this.disponibilidadCacheAt = 0;

            const response = await fetch('/api/panel/reuniones', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cvId,
                    vendedorId,
                    fecha: slot.fecha,
                    horaInicio: slot.horaInicio,
                    horaFin: slot.horaFin,
                    urlReunion,
                    gerenteEmail: gerenteEmail || undefined,
                    leadCorreo: leadCorreo || undefined,
                    leadNombre: this.agendarLeadNombre || undefined,
                    leadTelefono: this.agendarLeadTelefono || undefined
                })
            });
            const data = await response.json();

            if (!response.ok || data.success === false) {
                const hint = data.hint ? ` ${data.hint}` : '';
                this.setAgendarStatus((data.error || data.message || 'Error al agendar') + hint, 'error');
                if (response.status === 409) {
                    try {
                        const fresh = await this.fetchDisponibilidad(gerenteEmail, true);
                        this.disponibilidadData = fresh;
                        this.populateAgendarVendedores(fresh);
                    } catch {
                        /* ignore refresh errors */
                    }
                }
                if (this.agendarConfirmBtn) this.agendarConfirmBtn.disabled = false;
                return;
            }

            const lead = data.leadExtraido || data.reunion || {};
            const reunionId = data.reunion?.id || '';
            const msg = [
                'Reunión creada.',
                lead.leadNombre ? ` Lead: ${lead.leadNombre}` : '',
                lead.leadCorreo ? ` <${lead.leadCorreo}>` : '',
                reunionId ? ` (#${reunionId})` : ''
            ].join('');
            this.setAgendarStatus(msg, 'success');
            this.showStatus(msg, 'success');
            this.disponibilidadCacheAt = 0;
            this.loadDisponibilidadCalendar({ force: true, silent: true });
            if (this.agendarConfirmBtn) this.agendarConfirmBtn.disabled = false;
            setTimeout(() => this.closeAgendarModal(), 1800);
        } catch (error) {
            this.setAgendarStatus(error.message || 'Error de conexión', 'error');
            if (this.agendarConfirmBtn) this.agendarConfirmBtn.disabled = false;
        }
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
            await this.refreshSendQueue();
            this.maybeReseedSessionCounts();
            this.updateSessionWeightUI();
            this.progressSection.style.display = 'none';
            return;
        }
    }

    async refreshSendQueue() {
        try {
            const response = await fetch('/api/send-queue');
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'No se pudo consultar la cola');
            }
            this.queueState = data;
            this.applyQueueUi(data);
            return data;
        } catch (error) {
            console.warn('No se pudo refrescar la cola de envío:', error.message);
            return null;
        }
    }

    applyQueueUi(data = {}) {
        if (!this.sendQueuePanel || !this.enqueueBtn || !this.sendWhatsAppBtn) return;

        const batch = data.batch;
        const terminal = batch && ['sent', 'cancelled'].includes(batch.status);
        const active = batch && ['queued', 'scheduled', 'sending'].includes(batch.status);

        if (!batch) {
            this.sendQueuePanel.style.display = 'none';
        } else {
            this.sendQueuePanel.style.display = 'block';
            this.sendQueueStatus.textContent = batch.status;

            if (terminal) {
                this.sendQueueMeta.textContent =
                    batch.status === 'sent'
                        ? `Lote ${batch.id.slice(0, 8)}… enviado (${batch.total} mensajes)`
                        : 'Lote cancelado';
            } else {
                const scheduled = batch.scheduledAt
                    ? ` · programado ${new Date(batch.scheduledAt).toLocaleString()}`
                    : '';
                this.sendQueueMeta.textContent = `${batch.total} mensajes${scheduled}`;
            }

            const showActions = Boolean(data.canDispatch && !terminal);
            this.dispatchQueueBtn.style.display = showActions ? '' : 'none';
            this.cancelQueueBtn.style.display = showActions ? '' : 'none';
        }

        const hasReady = this.getReadyMessagesCount() > 0;
        this.enqueueBtn.disabled = !hasReady || !data.canEnqueue;

        if (data.buttonBurned || active) {
            this.sendWhatsAppBtn.disabled = true;
            if (batch?.status === 'sending') {
                this.sendWhatsAppBtn.textContent = 'Enviando…';
            } else if (batch?.status === 'sent') {
                this.sendWhatsAppBtn.textContent = 'Enviado';
            } else {
                this.sendWhatsAppBtn.textContent = 'En cola…';
            }
        } else {
            this.sendWhatsAppBtn.disabled = !hasReady;
            this.sendWhatsAppBtn.textContent = 'Enviar por WhatsApp';
        }
    }

    async enqueueBatch() {
        const selectedSessions = this.getSelectedSessionIds();
        if (selectedSessions.length === 0) {
            this.showStatus('Marca al menos una sesión para encolar mensajes', 'error');
            return;
        }

        const weightValidation = this.validateSessionWeights();
        if (!weightValidation.ok) {
            this.showStatus(weightValidation.message, 'error');
            return;
        }

        const scheduledLocal = this.scheduleAtInput.value;
        const scheduledAt = scheduledLocal ? new Date(scheduledLocal).toISOString() : null;
        this.enqueueBtn.disabled = true;

        try {
            const response = await fetch('/api/send-queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cvs: this.cvsData,
                    selectedSessions,
                    sessionWeights:
                        selectedSessions.length > 1 ? this.getSelectedSessionWeights() : undefined,
                    scheduledAt
                })
            });
            const data = await response.json();
            if (!response.ok) {
                this.showStatus(data.error || 'Error al encolar', 'error');
                await this.refreshSendQueue();
                return;
            }

            this.queueState = data;
            this.applyQueueUi(data);
            this.showStatus(
                scheduledAt ? 'Lote programado' : 'Lote encolado (sin enviar)',
                'success'
            );
        } catch (error) {
            console.error('Error encolando lote:', error);
            this.showStatus(`Error de conexión: ${error.message}`, 'error');
            await this.refreshSendQueue();
        }
    }

    trackSendProgress(total) {
        if (!this.sendProgressTrackingPromise) {
            this.sendProgressTrackingPromise = this.waitForSendComplete(total).finally(async () => {
                this.sendProgressTrackingPromise = null;
                await this.refreshSendQueue();
            });
        }
        return this.sendProgressTrackingPromise;
    }

    startQueuedSendProgress(batch) {
        if (!batch) return Promise.resolve();
        if (this.sendProgressTrackingPromise) return this.sendProgressTrackingPromise;

        const selectedSessions = Array.isArray(batch.selectedSessions)
            ? batch.selectedSessions
            : [];
        this.sendWhatsAppBtn.disabled = true;
        this.generateMessagesBtn.disabled = true;
        this.showSendingControls();
        this.activeSendingSessionIds = [...selectedSessions];
        this.activeControlSessionId =
            selectedSessions.length > 1 ? '__roundrobin__' : selectedSessions[0];
        this.initSessionSendingPanel(selectedSessions);
        this.showProgress(batch.total || this.getReadyMessagesCount());
        return this.trackSendProgress(batch.total || this.getReadyMessagesCount());
    }

    async dispatchQueue() {
        this.dispatchQueueBtn.disabled = true;
        this.cancelQueueBtn.disabled = true;
        this.sendJobCompleted = null;

        try {
            const response = await fetch('/api/send-queue/dispatch', { method: 'POST' });
            const data = await response.json();
            if (!response.ok) {
                this.showStatus(data.error || 'No se pudo enviar', 'error');
                await this.refreshSendQueue();
                return;
            }

            this.queueState = data;
            this.applyQueueUi(data);
            this.showStatus('Iniciando envío de la cola...', 'info');
            await this.startQueuedSendProgress(data.batch);
        } catch (error) {
            console.error('Error despachando cola:', error);
            this.showStatus(`Error de conexión: ${error.message}`, 'error');
            await this.refreshSendQueue();
        } finally {
            this.dispatchQueueBtn.disabled = false;
            this.cancelQueueBtn.disabled = false;
        }
    }

    async cancelQueue() {
        this.dispatchQueueBtn.disabled = true;
        this.cancelQueueBtn.disabled = true;

        try {
            const response = await fetch('/api/send-queue/cancel', { method: 'POST' });
            const data = await response.json();
            if (!response.ok) {
                this.showStatus(data.error || 'No se pudo cancelar', 'error');
                await this.refreshSendQueue();
                return;
            }

            this.queueState = data;
            this.applyQueueUi(data);
            this.showStatus('Cola cancelada', 'success');
        } catch (error) {
            console.error('Error cancelando cola:', error);
            this.showStatus(`Error de conexión: ${error.message}`, 'error');
            await this.refreshSendQueue();
        } finally {
            this.dispatchQueueBtn.disabled = false;
            this.cancelQueueBtn.disabled = false;
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

        const weightValidation = this.validateSessionWeights();
        if (!weightValidation.ok) {
            this.showStatus(weightValidation.message, 'error');
            return;
        }

        const sessionLabels = selectedSessions.map((s) => this.getSessionLabel(s)).join(', ');
        let confirmMessage = `¿Estás seguro de enviar ${cvsToSend.length} mensajes por WhatsApp?\n\n`;
        if (this.testMode) {
            confirmMessage += '🧪 MODO PRUEBA: Los mensajes se simularán (no se abrirá WhatsApp Web).';
        } else {
            if (selectedSessions.length > 1) {
                confirmMessage += `📱 Envío paralelo entre ${selectedSessions.length} sesiones: ${sessionLabels}\n`;
                const preview = this.computeWeightDistributionPreview(
                    cvsToSend.length,
                    weightValidation.weights
                );
                confirmMessage += `Reparto: ${preview.map((row) => `${this.getSessionLabel(row.id)} ${row.count} (${row.pct}%)`).join(', ')}\n`;
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
        this.sendJobCompleted = null;

        try {
            const response = await fetch('/send-whatsapp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    cvs: this.cvsData,
                    selectedSessions,
                    sessionWeights:
                        selectedSessions.length > 1 ? weightValidation.weights : undefined
                })
            });

            const result = await response.json();

            if (response.status === 409) {
                if (!result.sendJob) {
                    this.generateMessagesBtn.disabled = false;
                    this.hideSendingControls();
                    this.hideSessionSendingPanel();
                    this.progressSection.style.display = 'none';
                    await this.refreshSendQueue();
                    this.showStatus(result.error || 'Hay un lote activo en la cola', 'info');
                    return;
                }

                this.showStatus('Ya hay un envío en curso. Mostrando progreso...', 'info');
                await this.trackSendProgress(result.sendJob.total || cvsToSend.length);
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
                await this.trackSendProgress(result.total);
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
                this.connectToEvents();
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
        this.connectToEvents();
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
                this.showMessagePreview(result.mensajeIA, result.sessionId, result.saludo);
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
                this.disconnectFromEvents();
                this.connectToEvents(); // Desconectar eventos cuando termine el envío
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
                this.showMessagePreview(result.mensajeIA, result.sessionId, result.saludo);
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
                const queueResponse = await fetch('/api/send-queue/clear', {
                    method: 'POST'
                });
                const queueResult = await queueResponse.json();
                if (!queueResponse.ok) {
                    throw new Error(queueResult.error || 'No se pudo limpiar la cola');
                }

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
                    this.sendWhatsAppBtn.textContent = 'Enviar por WhatsApp';
                    this.queueState = queueResult;
                    this.applyQueueUi(queueResult);
                    this.fileInput.value = '';
                    this.hideSendingControls();
                    this.hideMessagePreview();
                    this.disconnectFromEvents();
                this.connectToEvents(); // Desconectar eventos al limpiar
                    this.showStatus('Datos limpiados correctamente', 'success');
                }
            } catch (error) {
                console.error('Error clearing data:', error);
                this.showStatus(`Error limpiando datos: ${error.message}`, 'error');
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
                this.connectToEvents();
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
    showMessagePreview(mensaje, sessionId = null, saludo = null) {
        if (this.messagePreview && this.messageContent) {
            const completo = saludo ? `${saludo}\n\n${mensaje}` : mensaje;
            this.messageContent.textContent = this.resolveMessageForDisplay(completo, sessionId);
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
                if (data.mensajeIA) {
                    this.showMessagePreview(data.mensajeIA, data.sessionId, data.saludo);
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

        this.eventSource.addEventListener('sendQueueUpdated', async () => {
            await this.refreshSendQueue();
        });

        this.eventSource.addEventListener('sendQueueStarted', async () => {
            const data = await this.refreshSendQueue();
            if (data?.batch?.status === 'sending') {
                this.startQueuedSendProgress(data.batch).catch((error) => {
                    console.warn('Error siguiendo progreso de cola:', error);
                });
            }
        });

        this.eventSource.addEventListener('sendQueueFinished', async () => {
            await this.refreshSendQueue();
        });

        this.eventSource.addEventListener('sendError', (event) => {
            const data = JSON.parse(event.data);
            this.showStatus(`Error en envío: ${data.error}`, 'error');
            this.sendWhatsAppBtn.disabled = false;
            this.generateMessagesBtn.disabled = false;
            this.hideSendingControls();
            this.hideSessionSendingPanel();
            this.disconnectFromEvents();
            this.connectToEvents();
        });

        this.eventSource.addEventListener('incomingReply', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.appendAutoReplyConversation(data);
                this.playNotificationSound();
            } catch (error) {
                console.warn('incomingReply SSE:', error);
            }
        });

        this.eventSource.addEventListener('agendaPending', () => {
            this.loadAgendaPending();
            this.playNotificationSound();
        });
        this.eventSource.addEventListener('agendaPendingConfirmed', () => {
            this.loadAgendaPending();
        });
        this.eventSource.addEventListener('agendaPendingCancelled', () => {
            this.loadAgendaPending();
        });

        this.eventSource.addEventListener('incomingMessage', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.appendIncomingMessage(data, { prepend: true, highlight: true, playSound: true });
                this.handleConversationIncomingMessage(data);
            } catch (error) {
                console.warn('incomingMessage SSE:', error);
            }
        });

        this.eventSource.addEventListener('aiControlChanged', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (
                    this.activeConversation &&
                    this.activeConversation.sessionId === data.sessionId &&
                    this.activeConversation.chatId === data.chatId
                ) {
                    this.activeConversationAiPaused = Boolean(data.aiPaused);
                    this.activeConversationKnownContact = true;
                    this.updateConversationThreadActions();
                    this.updateActiveConversationHeaderBadges();
                }
            } catch (error) {
                console.warn('aiControlChanged SSE:', error);
            }
        });

        // Manejar errores de conexión (nginx/timeouts son normales; se reconecta solo)
        this.eventSource.onerror = () => {
            if (this.eventSource && this.eventSource.readyState === EventSource.CLOSED) {
                console.warn('SSE desconectado; reconectando…');
                setTimeout(() => this.connectToEvents(), 5000);
            }
        };
    }

    // Desconectar de eventos
    disconnectFromEvents() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        this.stopConversationsPolling();
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
