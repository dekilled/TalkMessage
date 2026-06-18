// Socket.IO — conexão em tempo real
const socket = io();

// Eventos recebidos do servidor
socket.on('new_appointment', (data) => {
    addAppointmentCard(data);
    updateCounters();
});

socket.on('appointment_completed', (data) => {
    const activeCard = document.querySelector(`#atendimento .card[data-phone="${data.phone}"]`);
    if (activeCard) activeCard.remove();
    addCompletedCard(data);
    updateCounters();
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

// Atualiza UI de acordo com o status da conexão WhatsApp
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

// Escapa strings para evitar XSS ao inserir no HTML
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Renderiza card de atendimento pendente
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
            </div>
        </div>`;

    container.insertAdjacentHTML('afterbegin', cardHTML);
}

// Renderiza card de atendimento concluído
function addCompletedCard(data) {
    const container = document.querySelector('#concluidos .cards-container');
    if (!container) return;

    const completedAt = data.completionDate
        ? new Date(data.completionDate).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '';

    const cardHTML = `
        <div class="card completed-card" data-phone="${escapeHtml(data.phone)}">
            <div class="card-header">
                <h3>${escapeHtml(data.name)}</h3>
                <span class="phone">${escapeHtml(data.phone)}</span>
            </div>
            <div class="card-body">
                <div class="service-info">
                    <span class="service-type">${escapeHtml(data.service)}</span>
                </div>
                <div class="completion-info">
                    <span class="timestamp">Atendido: ${completedAt}</span>
                    <span class="resolution">${escapeHtml(data.resolution)}</span>
                </div>
            </div>
        </div>`;

    container.insertAdjacentHTML('afterbegin', cardHTML);
}

// Finaliza atendimento e move para concluídos
function finishCall(phone, name, service) {
    fetch('/complete-appointment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            phone,
            name,
            service,
            resolution: 'Atendido',
            completedAt: new Date().toISOString()
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            const card = document.querySelector(`#atendimento .card[data-phone="${phone}"]`);
            if (card) card.remove();
            updateCounters();
        }
    })
    .catch(err => console.error('Erro ao finalizar atendimento:', err));
}

// Desconecta WhatsApp
function disconnectWhatsApp() {
    fetch('/disconnect-whatsapp', { method: 'POST' })
        .then(res => res.json())
        .then(() => updateConnectionUI('disconnected'))
        .catch(err => console.error('Erro ao desconectar:', err));
}

// Adiciona dispositivo na lista de autorizados
function addDevice() {
    const name = document.getElementById('device-name').value.trim();
    const ip = document.getElementById('device-ip').value.trim();
    const type = document.getElementById('device-type').value;

    if (!name || !ip) {
        alert('Preencha o nome e o endereço IP do dispositivo.');
        return;
    }

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
                <button class="remove-device" onclick="removeDevice(this)">×</button>
            </div>
            <div class="device-status offline"></div>
        </div>`;

    container.insertAdjacentHTML('beforeend', cardHTML);
    document.getElementById('device-name').value = '';
    document.getElementById('device-ip').value = '';
}

// Remove dispositivo da lista
function removeDevice(el) {
    const card = el.closest('.device-card');
    if (card) card.remove();
}

// Filtra histórico por intervalo de datas
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
                    return `<tr>
                        <td>${formatted}</td>
                        <td>${items.length}</td>
                        <td>${items.length}</td>
                        <td>-</td>
                        <td>-</td>
                    </tr>`;
                })
                .join('') || '<tr><td colspan="5">Nenhum registro encontrado.</td></tr>';
        })
        .catch(err => console.error('Erro ao filtrar histórico:', err));
}

// Inicializa o gráfico de atendimentos no histórico
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
                    datasets: [{
                        label: 'Atendimentos Concluídos',
                        data: data.map(d => d.count),
                        backgroundColor: '#075e54',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
                }
            });
        })
        .catch(err => console.error('Erro ao carregar gráfico:', err));
}

// Navegação entre sub-páginas de configuração
// Mapeamento: botão 0=Conexão→pág 1, 1=Almoço→pág 0, 2=Dispositivos→pág 2, 3=Histórico→pág 3
const CONFIG_PAGE_MAP = [1, 0, 2, 3];

function showConfigPage(pageIndex) {
    const pages = document.querySelectorAll('#config .page');
    const buttons = document.querySelectorAll('#config .config-card .button');

    pages.forEach((page, i) => { page.hidden = i !== pageIndex; });
    buttons.forEach((btn, i) => { btn.classList.toggle('active', CONFIG_PAGE_MAP[i] === pageIndex); });

    if (pageIndex === 3) initChart();
}

// Inicialização ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
    // Remove cards de demonstração hardcoded do HTML
    ['#pendentes .cards-container', '#atendimento .cards-container', '#concluidos .cards-container'].forEach(sel => {
        const el = document.querySelector(sel);
        if (el) el.innerHTML = '';
    });
    updateCounters();

    // Carrega atendimentos pendentes persistidos
    fetch('/appointments')
        .then(res => res.json())
        .then(data => {
            data.forEach(a => addAppointmentCard(a));
            updateCounters();
        })
        .catch(err => console.error('Erro ao carregar atendimentos:', err));

    // Carrega atendimentos concluídos persistidos
    fetch('/completed-appointments')
        .then(res => res.json())
        .then(data => {
            data.forEach(a => addCompletedCard(a));
            updateCounters();
        })
        .catch(err => console.error('Erro ao carregar concluídos:', err));

    // Wiring dos botões de navegação da config
    document.querySelectorAll('#config .config-card .button').forEach((btn, i) => {
        btn.addEventListener('click', () => showConfigPage(CONFIG_PAGE_MAP[i]));
    });

    // Status inicial do WhatsApp
    fetch('/connection-status')
        .then(res => res.json())
        .then(data => updateConnectionUI(data.status))
        .catch(() => {});

    // Poll de status a cada 30 segundos
    setInterval(() => {
        fetch('/connection-status')
            .then(res => res.json())
            .then(data => updateConnectionUI(data.status))
            .catch(() => {});
    }, 30000);
});
