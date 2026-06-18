// Estado global de autenticação
let currentUser = null;
let socket = null;

const ROLE_LEVEL = { atendente: 1, supervisor: 2, admin: 3 };
const ROLE_LABEL = { atendente: 'Atendente', supervisor: 'Supervisor', admin: 'Admin' };

// ─── AUTENTICAÇÃO ────────────────────────────────────────────────────────────

async function initAuth() {
    try {
        const res = await fetch('/auth/me');
        if (!res.ok) { showLoginOverlay(); return; }
        currentUser = await res.json();
        hideLoginOverlay();
        initApp();
    } catch {
        showLoginOverlay();
    }
}

function showLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function hideLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.style.display = 'none';
}

function applyPermissions(role) {
    const level = ROLE_LEVEL[role] || 0;
    document.querySelectorAll('[data-min-role]').forEach(el => {
        const required = el.getAttribute('data-min-role');
        el.hidden = level < (ROLE_LEVEL[required] || 0);
    });

    // Exibe badges de usuário
    const nameEls = document.querySelectorAll('.user-name-display');
    nameEls.forEach(el => { el.textContent = currentUser.name; });

    const roleEls = document.querySelectorAll('.user-role-badge');
    roleEls.forEach(el => {
        el.textContent = ROLE_LABEL[role] || role;
        el.className = `user-role-badge role-${role}`;
    });

    const badges = document.querySelectorAll('.user-badge-area');
    badges.forEach(el => { el.style.display = 'flex'; });
}

function logout() {
    fetch('/auth/logout', { method: 'POST' })
        .then(() => {
            if (socket) { socket.disconnect(); socket = null; }
            currentUser = null;
            // Limpa dados da tela
            ['#pendentes .cards-container', '#atendimento .cards-container', '#concluidos .cards-container'].forEach(sel => {
                const el = document.querySelector(sel);
                if (el) el.innerHTML = '';
            });
            const badges = document.querySelectorAll('.user-badge-area');
            badges.forEach(el => { el.style.display = 'none'; });
            showLoginOverlay();
        })
        .catch(err => console.error('Erro ao sair:', err));
}

// ─── INICIALIZAÇÃO DO APP ─────────────────────────────────────────────────────

function initApp() {
    applyPermissions(currentUser.role);

    // Limpa cards hardcoded de demonstração
    ['#pendentes .cards-container', '#atendimento .cards-container', '#concluidos .cards-container'].forEach(sel => {
        const el = document.querySelector(sel);
        if (el) el.innerHTML = '';
    });
    updateCounters();

    // Conecta Socket.IO
    socket = io();

    socket.on('connect_error', (err) => {
        if (err.message === 'Não autorizado') {
            currentUser = null;
            showLoginOverlay();
        }
    });

    socket.on('new_appointment', (data) => {
        addAppointmentCard(data);
        updateCounters();
    });

    socket.on('appointment_started', (data) => {
        const pendingCard = document.querySelector(`#pendentes .card[data-phone="${data.phone}"]`);
        if (pendingCard) pendingCard.remove();
        addActiveCard(data);
        updateCounters();
    });

    socket.on('appointment_completed', (data) => {
        const activeCard = document.querySelector(`#atendimento .card[data-phone="${data.phone}"]`);
        if (activeCard) activeCard.remove();
        addCompletedCard(data);
        updateCounters();
        if (chatCurrentPhone === data.phone) closeChatModal();
    });

    socket.on('chat_message', (data) => {
        if (chatCurrentPhone === data.phone) appendChatMessage(data);
    });

    socket.on('qr_code', (data) => {
        const qrImg = document.getElementById('qr-code');
        const qrContainer = document.getElementById('qr-container');
        const connectedMessage = document.getElementById('connected-message');
        const indicator = document.getElementById('status-indicator');
        if (qrImg) qrImg.src = data.qr;
        if (qrContainer) qrContainer.style.display = 'flex';
        if (connectedMessage) connectedMessage.style.display = 'none';
        if (indicator) indicator.textContent = 'Aguardando conexão';
    });

    socket.on('connection_status', (data) => {
        updateConnectionUI(data.status);
    });

    // Carrega dados persistidos
    fetch('/appointments')
        .then(res => res.json())
        .then(data => { data.forEach(a => addAppointmentCard(a)); updateCounters(); })
        .catch(err => console.error('Erro ao carregar atendimentos:', err));

    fetch('/active-appointments')
        .then(res => res.json())
        .then(data => { data.forEach(a => addActiveCard(a)); updateCounters(); })
        .catch(err => console.error('Erro ao carregar ativos:', err));

    fetch('/completed-appointments')
        .then(res => res.json())
        .then(data => { data.forEach(a => addCompletedCard(a)); updateCounters(); })
        .catch(err => console.error('Erro ao carregar concluídos:', err));

    // Status inicial do WhatsApp
    fetch('/connection-status')
        .then(res => res.json())
        .then(data => updateConnectionUI(data.status))
        .catch(() => {});

    setInterval(() => {
        fetch('/connection-status')
            .then(res => res.json())
            .then(data => updateConnectionUI(data.status))
            .catch(() => {});
    }, 30000);
}

// ─── CONEXÃO WHATSAPP ─────────────────────────────────────────────────────────

function updateConnectionUI(status) {
    const connectedStatuses = ['isLogged', 'qrReadSuccess', 'chatsAvailable', 'connected'];
    const indicator = document.getElementById('status-indicator');
    const qrContainer = document.getElementById('qr-container');
    const connectedMessage = document.getElementById('connected-message');

    if (connectedStatuses.includes(status)) {
        if (indicator) indicator.textContent = 'Conectado';
        if (qrContainer) qrContainer.style.display = 'none';
        if (connectedMessage) connectedMessage.style.display = 'flex';
    } else if (['notLogged', 'browserClose', 'disconnected', 'qr_waiting'].includes(status)) {
        if (indicator) indicator.textContent = 'Desconectado';
        if (qrContainer) qrContainer.style.display = 'flex';
        if (connectedMessage) connectedMessage.style.display = 'none';
    } else {
        if (indicator) indicator.textContent = 'Verificando...';
    }
}

function disconnectWhatsApp() {
    fetch('/disconnect-whatsapp', { method: 'POST' })
        .then(res => res.json())
        .then(() => updateConnectionUI('disconnected'))
        .catch(err => console.error('Erro ao desconectar:', err));
}

// ─── CARDS DE ATENDIMENTO ─────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function addAppointmentCard(data) {
    const container = document.querySelector('#pendentes .cards-container');
    if (!container) return;

    const cardHTML = `
        <div class="card pendente" data-phone="${escapeHtml(data.phone)}">
            <div class="card-header">
                <h3>${escapeHtml(data.name)}</h3>
                <span class="phone">${escapeHtml(data.phone)}</span>
            </div>
            <div class="card-body">
                <div class="service-info">
                    <span class="service-type">${escapeHtml(data.service)}</span>
                    <span class="service-date">${escapeHtml(data.date)}</span>
                </div>
                <div class="service-info">
                    <span class="description">${escapeHtml(data.description)}</span>
                    <span class="timestamp">Contato: ${escapeHtml(data.time)}</span>
                </div>
                <button class="card-action-btn btn-start"
                    onclick="openChannelModal('${escapeHtml(data.phone)}','${escapeHtml(data.name)}','${escapeHtml(data.service)}')">
                    Iniciar Atendimento
                </button>
            </div>
        </div>`;

    container.insertAdjacentHTML('afterbegin', cardHTML);
}

function addActiveCard(data) {
    const container = document.querySelector('#atendimento .cards-container');
    if (!container) return;

    const since = data.startedAt
        ? new Date(data.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '';
    const channelLabel = data.channel === 'chat' ? 'Chat interno' : 'WhatsApp';
    const channelIcon = data.channel === 'chat' ? '💬' : '📱';

    const chatBtn = data.channel === 'chat'
        ? `<button class="card-action-btn btn-chat" onclick="openChatModal('${escapeHtml(data.phone)}','${escapeHtml(data.name)}')">
               ${channelIcon} Abrir Chat
           </button>`
        : `<a class="card-action-btn btn-chat" href="https://wa.me/${escapeHtml(data.phone.replace(/\D/g,''))}" target="_blank">
               ${channelIcon} Abrir WhatsApp
           </a>`;

    const cardHTML = `
        <div class="card active-card" data-phone="${escapeHtml(data.phone)}">
            <div class="card-header">
                <h3>${escapeHtml(data.name)}</h3>
                <span class="phone">${escapeHtml(data.phone)}</span>
            </div>
            <div class="card-body">
                <div class="service-info">
                    <span class="service-type">${escapeHtml(data.service)}</span>
                    <span class="timestamp">Desde: ${since}</span>
                </div>
                <div class="service-info" style="margin-top:4px">
                    <span class="channel-tag">${channelIcon} ${channelLabel}</span>
                    <span class="attendant-tag">👤 ${escapeHtml(data.attendant || '')}</span>
                </div>
                <div class="card-actions">
                    ${chatBtn}
                    <button class="card-action-btn btn-finish"
                        onclick="openFinishModal('${escapeHtml(data.phone)}','${escapeHtml(data.name)}')">
                        ✓ Finalizar
                    </button>
                </div>
            </div>
        </div>`;

    container.insertAdjacentHTML('afterbegin', cardHTML);
}

function addCompletedCard(data) {
    const container = document.querySelector('#concluidos .cards-container');
    if (!container) return;

    const completedAt = data.completedAt || data.completionDate
        ? new Date(data.completedAt || data.completionDate).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '';

    const recurrenceBadge = (data.recurrenceCount && data.recurrenceCount > 1)
        ? `<span class="recurrence-badge">↩ Reincidente (${data.recurrenceCount}x)</span>`
        : '';

    const statusLabel = { finalizada: 'Finalizada', em_andamento: 'Em Andamento', iniciada: 'Iniciada' };
    const statusClass = { finalizada: 'status-done', em_andamento: 'status-ongoing', iniciada: 'status-started' };
    const st = data.completionStatus || 'finalizada';

    const typesMap = { exame: 'Exame', passagem: 'Passagem', resultado: 'Resultado', cirurgia: 'Cirurgia', outro: 'Outro' };
    const typesTags = (data.completionTypes || []).map(t => `<span class="type-tag">${typesMap[t] || t}</span>`).join('');

    const cardHTML = `
        <div class="card completed-card" data-phone="${escapeHtml(data.phone)}">
            <div class="card-header">
                <h3>${escapeHtml(data.name)} ${recurrenceBadge}</h3>
                <span class="phone">${escapeHtml(data.phone)}</span>
            </div>
            <div class="card-body">
                <div class="service-info">
                    <span class="service-type">${escapeHtml(data.service)}</span>
                    <span class="timestamp">Finalizado: ${completedAt}</span>
                </div>
                ${typesTags ? `<div class="types-row" style="margin:4px 0">${typesTags}</div>` : ''}
                <div class="completion-info">
                    <span class="${statusClass[st] || ''}">${statusLabel[st] || st}</span>
                    ${data.attendantNotes ? `<span class="resolution">${escapeHtml(data.attendantNotes)}</span>` : ''}
                </div>
            </div>
        </div>`;

    container.insertAdjacentHTML('afterbegin', cardHTML);
}

// ─── MODAL: ESCOLHA DE CANAL ──────────────────────────────────────────────────

let pendingAppointment = null;

function openChannelModal(phone, name, service) {
    pendingAppointment = { phone, name, service };
    document.getElementById('channel-modal-patient').textContent = `Paciente: ${name}`;
    document.getElementById('channel-modal').style.display = 'flex';
}

function closeChannelModal() {
    document.getElementById('channel-modal').style.display = 'none';
    pendingAppointment = null;
}

function confirmStartAppointment(channel) {
    if (!pendingAppointment) return;
    closeChannelModal();

    fetch('/start-appointment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: pendingAppointment.phone, channel })
    })
    .then(res => res.json())
    .then(data => {
        if (!data.success) alert(data.message || 'Erro ao iniciar atendimento.');
        if (data.success && channel === 'chat') openChatModal(data.appointment.phone, data.appointment.name);
    })
    .catch(err => console.error('Erro ao iniciar atendimento:', err));
}

// ─── MODAL: CHAT INTERNO ──────────────────────────────────────────────────────

let chatCurrentPhone = null;

function openChatModal(phone, name) {
    chatCurrentPhone = phone;
    document.getElementById('chat-modal-title').textContent = `Chat — ${name}`;
    document.getElementById('chat-modal-phone').textContent = phone;
    document.getElementById('chat-messages').innerHTML = '';
    document.getElementById('chat-modal').style.display = 'flex';

    fetch(`/chat/${phone}`)
        .then(res => res.json())
        .then(msgs => { msgs.forEach(appendChatMessage); })
        .catch(() => {});
}

function closeChatModal() {
    document.getElementById('chat-modal').style.display = 'none';
    chatCurrentPhone = null;
}

function appendChatMessage(msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const isAttendant = msg.from === 'attendant';
    const time = new Date(msg.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const el = document.createElement('div');
    el.className = `chat-bubble ${isAttendant ? 'bubble-out' : 'bubble-in'}`;
    el.innerHTML = `
        <div class="bubble-sender">${escapeHtml(msg.sender || '')}</div>
        <div class="bubble-text">${escapeHtml(msg.text)}</div>
        <div class="bubble-time">${time}</div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !chatCurrentPhone) return;
    input.value = '';

    fetch(`/chat/${chatCurrentPhone}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    }).catch(err => console.error('Erro ao enviar mensagem:', err));
}

function handleChatKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
}

// ─── MODAL: FINALIZAR ATENDIMENTO ─────────────────────────────────────────────

let finishCurrentPhone = null;

function openFinishModal(phone, name) {
    finishCurrentPhone = phone;
    document.getElementById('finish-modal-patient').textContent = `Paciente: ${name}`;
    document.getElementById('finish-notes').value = '';
    document.querySelector('input[name="finish-status"][value="finalizada"]').checked = true;
    document.querySelectorAll('input[name="finish-type"]').forEach(cb => { cb.checked = false; });
    const errEl = document.getElementById('finish-error');
    if (errEl) errEl.hidden = true;
    document.getElementById('finish-modal').style.display = 'flex';
}

function closeFinishModal() {
    document.getElementById('finish-modal').style.display = 'none';
    finishCurrentPhone = null;
}

function submitFinishAppointment() {
    if (!finishCurrentPhone) return;

    const attendantNotes = document.getElementById('finish-notes').value.trim();
    const completionStatus = document.querySelector('input[name="finish-status"]:checked')?.value || 'finalizada';
    const completionTypes = [...document.querySelectorAll('input[name="finish-type"]:checked')].map(cb => cb.value);
    const errEl = document.getElementById('finish-error');

    if (!attendantNotes) {
        errEl.textContent = 'Por favor, preencha a descrição do atendimento.';
        errEl.hidden = false;
        return;
    }

    fetch('/complete-appointment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: finishCurrentPhone, attendantNotes, completionStatus, completionTypes })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            closeFinishModal();
        } else {
            errEl.textContent = data.message || 'Erro ao finalizar atendimento.';
            errEl.hidden = false;
        }
    })
    .catch(err => console.error('Erro ao finalizar:', err));
}

// ─── DISPOSITIVOS ─────────────────────────────────────────────────────────────

function addDevice() {
    const name = document.getElementById('device-name').value.trim();
    const ip = document.getElementById('device-ip').value.trim();
    const type = document.getElementById('device-type').value;

    if (!name || !ip) { alert('Preencha o nome e o endereço IP do dispositivo.'); return; }

    const icon = type === 'mobile' ? '📱' : '💻';
    const container = document.getElementById('devices-container');
    const cardHTML = `
        <div class="device-card">
            <div class="device-icon">${icon}</div>
            <div class="device-info">
                <h5>${escapeHtml(name)}</h5>
                <span class="device-ip">http://${escapeHtml(ip)}:3000</span>
            </div>
            <div class="device-actions">
                <button class="remove-device" onclick="removeDevice(this)" data-min-role="admin">×</button>
            </div>
            <div class="device-status offline"></div>
        </div>`;
    container.insertAdjacentHTML('beforeend', cardHTML);
    document.getElementById('device-name').value = '';
    document.getElementById('device-ip').value = '';
}

function removeDevice(el) {
    const card = el.closest('.device-card');
    if (card) card.remove();
}

// ─── HISTÓRICO ────────────────────────────────────────────────────────────────

function filterHistory() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;

    fetch('/completed-appointments')
        .then(res => res.json())
        .then(data => {
            let filtered = data;
            if (startDate) filtered = filtered.filter(a => (a.completionDate || '').slice(0, 10) >= startDate);
            if (endDate) filtered = filtered.filter(a => (a.completionDate || '').slice(0, 10) <= endDate);

            const byDate = {};
            filtered.forEach(a => {
                const date = (a.completionDate || '').slice(0, 10) || 'desconhecido';
                if (!byDate[date]) byDate[date] = [];
                byDate[date].push(a);
            });

            const tbody = document.getElementById('history-data');
            if (!tbody) return;
            tbody.innerHTML = Object.entries(byDate)
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([date, items]) => {
                    const formatted = date !== 'desconhecido'
                        ? new Date(date + 'T12:00:00').toLocaleDateString('pt-BR')
                        : '-';
                    return `<tr><td>${formatted}</td><td>${items.length}</td><td>${items.length}</td><td>-</td><td>-</td></tr>`;
                })
                .join('') || '<tr><td colspan="5">Nenhum registro encontrado.</td></tr>';
        })
        .catch(err => console.error('Erro ao filtrar histórico:', err));
}

function initChart() {
    fetch('/appointments/stats')
        .then(res => res.json())
        .then(data => {
            const canvas = document.getElementById('attendanceChart');
            if (!canvas) return;
            if (canvas._chartInstance) canvas._chartInstance.destroy();
            canvas._chartInstance = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: data.map(d => new Date(d.date + 'T12:00:00').toLocaleDateString('pt-BR')),
                    datasets: [{ label: 'Atendimentos Concluídos', data: data.map(d => d.count), backgroundColor: '#075e54', borderRadius: 4 }]
                },
                options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
            });
        })
        .catch(err => console.error('Erro ao carregar gráfico:', err));
}

// ─── NAVEGAÇÃO DE CONFIGURAÇÕES ───────────────────────────────────────────────

function showConfigPage(pageIndex) {
    document.querySelectorAll('.config-panel').forEach(p => {
        p.classList.toggle('active', parseInt(p.dataset.panel) === pageIndex);
    });
    document.querySelectorAll('.config-nav-item').forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.page) === pageIndex);
    });

    if (window.innerWidth <= 768) {
        const nav = document.getElementById('config-nav');
        const content = document.getElementById('config-content');
        if (nav) nav.classList.add('slide-out');
        if (content) content.classList.add('visible-mobile');

        const activeItem = document.querySelector(`.config-nav-item[data-page="${pageIndex}"]`);
        if (activeItem) {
            const titleEl = activeItem.querySelector('.config-nav-title-text');
            const backLabel = document.getElementById('config-back-label');
            if (titleEl && backLabel) backLabel.textContent = titleEl.textContent;
        }
    }

    if (pageIndex === 3) initChart();
    if (pageIndex === 4) loadUsersPanel();
}

function showConfigNav() {
    const nav = document.getElementById('config-nav');
    const content = document.getElementById('config-content');
    if (nav) nav.classList.remove('slide-out');
    if (content) content.classList.remove('visible-mobile');
}

// ─── PAINEL DE USUÁRIOS (ADMIN) ───────────────────────────────────────────────

function loadUsersPanel() {
    fetch('/users')
        .then(res => res.json())
        .then(users => {
            const tbody = document.getElementById('users-table-body');
            if (!tbody) return;
            tbody.innerHTML = users.map(u => `
                <tr>
                    <td>${escapeHtml(u.name)}</td>
                    <td>${escapeHtml(u.username)}</td>
                    <td><span class="role-badge role-${u.role}">${ROLE_LABEL[u.role] || u.role}</span></td>
                    <td><span class="${u.active ? 'status-active' : 'status-inactive'}">${u.active ? 'Ativo' : 'Inativo'}</span></td>
                    <td>
                        ${u.id !== currentUser.id && u.active
                            ? `<button class="config-btn btn-danger btn-small" onclick="deactivateUser('${u.id}')">Desativar</button>`
                            : ''}
                    </td>
                </tr>`).join('') || '<tr><td colspan="5">Nenhum usuário encontrado.</td></tr>';
        })
        .catch(err => console.error('Erro ao carregar usuários:', err));
}

function saveNewUser() {
    const name = document.getElementById('new-user-name').value.trim();
    const username = document.getElementById('new-user-username').value.trim();
    const password = document.getElementById('new-user-password').value;
    const role = document.getElementById('new-user-role').value;
    const errorEl = document.getElementById('new-user-error');

    if (!name || !username || !password || !role) {
        errorEl.textContent = 'Preencha todos os campos.';
        errorEl.hidden = false;
        return;
    }

    fetch('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, password, role })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            errorEl.hidden = true;
            document.getElementById('new-user-name').value = '';
            document.getElementById('new-user-username').value = '';
            document.getElementById('new-user-password').value = '';
            loadUsersPanel();
        } else {
            errorEl.textContent = data.message;
            errorEl.hidden = false;
        }
    })
    .catch(err => console.error('Erro ao criar usuário:', err));
}

function deactivateUser(id) {
    if (!confirm('Desativar este funcionário?')) return;
    fetch(`/users/${id}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => { if (data.success) loadUsersPanel(); })
        .catch(err => console.error('Erro ao desativar usuário:', err));
}

// ─── DOM CONTENT LOADED ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Login form
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('login-username').value.trim();
            const password = document.getElementById('login-password').value;
            const errorEl = document.getElementById('login-error');
            const submitBtn = loginForm.querySelector('button[type="submit"]');

            submitBtn.disabled = true;
            submitBtn.textContent = 'Entrando...';

            try {
                const res = await fetch('/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (data.success) {
                    currentUser = data.user;
                    errorEl.hidden = true;
                    hideLoginOverlay();
                    initApp();
                } else {
                    errorEl.textContent = data.message;
                    errorEl.hidden = false;
                }
            } catch {
                errorEl.textContent = 'Erro de conexão. Verifique a rede.';
                errorEl.hidden = false;
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Entrar';
            }
        });
    }

    // Inicia verificação de autenticação
    initAuth();
});
