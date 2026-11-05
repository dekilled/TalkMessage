// patients.js — seção "Pacientes": busca, ficha, histórico, exames/pedidos e avaliações.
(function () {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';
    const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    const stars = (n) => n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '';

    const RECORD_TYPES = { exame: 'Exame', pedido: 'Pedido', passagem: 'Passagem', cirurgia: 'Cirurgia', consulta: 'Consulta', outro: 'Outro' };
    const RECORD_STATUS = { solicitado: 'Solicitado', agendado: 'Agendado', em_andamento: 'Em andamento', concluido: 'Concluído', cancelado: 'Cancelado' };
    const ATT_STATUS = { pending: 'Na fila', active: 'Em atendimento', completed: 'Concluído' };

    let currentPhone = null;
    let searchTimer = null;

    async function json(path, opts) {
        const res = await API.fetch(path, opts);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `Erro ${res.status}`);
        return data;
    }
    const send = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // ─── Lista / busca ──────────────────────────────────────────────────────
    async function search(q = '') {
        const list = document.getElementById('patients-list');
        if (!list) return;
        try {
            const patients = await json('/patients?q=' + encodeURIComponent(q));
            list.innerHTML = patients.length ? patients.map(p => `
                <li class="patient-item ${p.phone === currentPhone ? 'active' : ''}" data-phone="${esc(p.phone)}">
                    <div class="patient-item-name">${esc(p.name || 'Sem nome')}</div>
                    <div class="patient-item-meta">
                        <span>${esc(p.phone)}</span>
                        <span>${p.attendance_count} atend.</span>
                        ${p.avg_rating ? `<span class="stars">★ ${p.avg_rating}</span>` : ''}
                    </div>
                </li>`).join('') : '<li class="patient-empty">Nenhum paciente encontrado.</li>';
            list.querySelectorAll('.patient-item').forEach(li => li.addEventListener('click', () => open(li.dataset.phone)));
        } catch (e) {
            list.innerHTML = `<li class="patient-empty">${esc(e.message)}</li>`;
        }
    }

    // ─── Ficha ──────────────────────────────────────────────────────────────
    async function open(phone) {
        currentPhone = phone;
        const panel = document.getElementById('patient-detail');
        if (typeof switchSection === 'function' && !document.getElementById('pacientes').offsetParent) switchSection('pacientes');
        document.querySelectorAll('.patient-item').forEach(li => li.classList.toggle('active', li.dataset.phone === phone));
        document.getElementById('pacientes').classList.add('showing-detail');
        panel.innerHTML = '<p class="patient-empty">Carregando…</p>';
        try {
            render(await json('/patients/' + encodeURIComponent(phone)));
        } catch (e) {
            panel.innerHTML = `<p class="patient-empty">${esc(e.message)}</p>`;
        }
    }

    function render({ patient: p, attendances, records, summary }) {
        const panel = document.getElementById('patient-detail');
        panel.innerHTML = `
            <button class="patient-back" type="button">← Voltar</button>
            <div class="patient-head">
                <div>
                    <h2>${esc(p.name || 'Sem nome')}</h2>
                    <span class="phone">${esc(p.phone)}</span>
                </div>
                <div class="patient-kpis">
                    <div><strong>${summary.totalAttendances}</strong><span>atendimentos</span></div>
                    <div><strong>${summary.openRecords}</strong><span>pendências</span></div>
                    <div><strong>${summary.avgRating ?? '—'}</strong><span>nota média</span></div>
                    <div><strong>${fmtDate(summary.lastContact)}</strong><span>último contato</span></div>
                </div>
            </div>

            <form class="patient-form" id="patient-form">
                <h3>Cadastro</h3>
                <div class="patient-grid">
                    <label>Nome<input name="name" value="${esc(p.name)}"></label>
                    <label>CPF<input name="cpf" value="${esc(p.cpf)}" inputmode="numeric"></label>
                    <label>Nascimento<input name="birth_date" type="date" value="${esc(p.birth_date)}"></label>
                    <label>Cartão SUS<input name="sus_card" value="${esc(p.sus_card)}" inputmode="numeric"></label>
                    <label class="span-2">Endereço<input name="address" value="${esc(p.address)}"></label>
                    <label class="span-2">Observações de saúde<textarea name="notes" rows="2">${esc(p.notes)}</textarea></label>
                </div>
                <button class="btn-primary" type="submit">Salvar cadastro</button>
                <span class="patient-saved" hidden>Salvo ✓</span>
            </form>

            <div class="patient-block">
                <h3>Exames, pedidos e passagens</h3>
                <form class="record-form" id="record-form">
                    <select name="type">${Object.entries(RECORD_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
                    <input name="title" placeholder="Descrição (ex: Hemograma, Passagem BH)" required>
                    <input name="date" type="date">
                    <button class="btn-primary" type="submit">Adicionar</button>
                </form>
                <ul class="records-list">
                    ${records.length ? records.map(r => `
                        <li class="record-item status-${esc(r.status)}" data-id="${r.id}">
                            <span class="type-tag">${RECORD_TYPES[r.type] || esc(r.type)}</span>
                            <div class="record-main">
                                <strong>${esc(r.title)}</strong>
                                <small>${r.date ? fmtDate(r.date + 'T12:00:00') : 'sem data'} · por ${esc(r.created_by || '—')}</small>
                            </div>
                            <select class="record-status">
                                ${Object.entries(RECORD_STATUS).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}
                            </select>
                        </li>`).join('') : '<li class="patient-empty">Nenhum registro ainda.</li>'}
                </ul>
            </div>

            <div class="patient-block">
                <h3>Histórico de atendimentos</h3>
                <ul class="timeline">
                    ${attendances.length ? attendances.map(a => `
                        <li>
                            <div class="timeline-date">${fmtDateTime(a.timestamp || a.startedAt || a.completedAt)}</div>
                            <div class="timeline-body">
                                <strong>${esc(a.service || 'Atendimento')}</strong>
                                <span class="att-status att-${a.status}">${ATT_STATUS[a.status] || a.status}</span>
                                ${a.rating ? `<span class="stars" title="Nota ${a.rating}">${stars(a.rating)}</span>` : ''}
                                ${a.description ? `<p>${esc(a.description)}</p>` : ''}
                                ${a.attendantNotes ? `<p class="att-notes">📝 ${esc(a.attendantNotes)}</p>` : ''}
                                <small>${a.attendant ? 'Atendente: ' + esc(a.completedBy || a.attendant) : ''}</small>
                            </div>
                        </li>`).join('') : '<li class="patient-empty">Sem atendimentos.</li>'}
                </ul>
            </div>`;

        panel.querySelector('.patient-back').addEventListener('click', () => {
            document.getElementById('pacientes').classList.remove('showing-detail');
        });

        panel.querySelector('#patient-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const body = Object.fromEntries(new FormData(e.target));
            try {
                await json('/patients/' + encodeURIComponent(p.phone), send('PUT', body));
                const ok = e.target.querySelector('.patient-saved');
                ok.hidden = false; setTimeout(() => ok.hidden = true, 2000);
                search(document.getElementById('patients-search').value);
            } catch (err) { alert(err.message); }
        });

        panel.querySelector('#record-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const body = Object.fromEntries(new FormData(e.target));
            try {
                await json('/patients/' + encodeURIComponent(p.phone) + '/records', send('POST', body));
                open(p.phone);
            } catch (err) { alert(err.message); }
        });

        panel.querySelectorAll('.record-status').forEach(sel => sel.addEventListener('change', async () => {
            const id = sel.closest('.record-item').dataset.id;
            try {
                await json('/records/' + id, send('PUT', { status: sel.value }));
                sel.closest('.record-item').className = `record-item status-${sel.value}`;
            } catch (err) { alert(err.message); }
        }));
    }

    // ─── Inicialização ──────────────────────────────────────────────────────
    function init() {
        const input = document.getElementById('patients-search');
        if (!input || input.dataset.ready) return;
        input.dataset.ready = '1';
        input.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => search(input.value), 250);
        });
    }

    window.Patients = {
        init, search, open,
        // chamado pelo script.js quando o socket conecta
        bindSocket(socket) {
            const refresh = (data) => {
                if (document.getElementById('pacientes')?.offsetParent) search(document.getElementById('patients-search').value);
                const phone = String((data && data.phone) || '').replace(/\D/g, '');
                if (currentPhone && phone === currentPhone) open(currentPhone);
            };
            ['appointment_completed', 'new_appointment', 'rating_received'].forEach(ev => socket.on(ev, refresh));
        }
    };
    window.openPatient = (phone) => Patients.open(phone);
})();
