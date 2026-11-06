// schedule.js — "Horário do dia": confirmação ao abrir o app e dias especiais.
(function () {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const txt = (ps) => ps && ps.length ? ps.map(p => `${p.start} às ${p.end}`).join(' e ') : 'sem expediente';
    const short = (ps) => ps.map(p => `${p.start}-${p.end}`).join(', ');
    const fmtDate = (key) => new Date(key + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const KEY_ACK = 'tm_schedule_ack';

    async function json(path, opts) {
        const res = await API.fetch(path, opts);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `Erro ${res.status}`);
        return data;
    }
    const put = (date, body) => json('/schedule/special/' + date, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const nowHHMM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    const plusHour = () => { const d = new Date(Date.now() + 3600000); return String(d.getHours()).padStart(2, '0') + ':00'; };

    // ─── Avisos rápidos (toast) ─────────────────────────────────────────────
    function toast(html, { action, timeout = 8000 } = {}) {
        let box = document.getElementById('tm-toasts');
        if (!box) { box = document.createElement('div'); box.id = 'tm-toasts'; document.body.appendChild(box); }
        const t = document.createElement('div');
        t.className = 'tm-toast';
        t.innerHTML = `<div>${html}</div>${action ? `<button type="button">${esc(action.label)}</button>` : ''}<button type="button" class="tm-toast-x">×</button>`;
        if (action) t.querySelector('button').onclick = () => { t.remove(); action.run(); };
        t.querySelector('.tm-toast-x').onclick = () => t.remove();
        box.appendChild(t);
        if (timeout) setTimeout(() => t.remove(), timeout);
    }

    // ─── Atalho fixo "Hoje: …" (visível para todos, PC e celular) ───────────
    async function refreshPill() {
        let pill = document.getElementById('sched-pill');
        let data;
        try { data = await json('/schedule'); } catch { return; }
        if (!data.enforceSchedule) { if (pill) pill.remove(); return; }
        if (!pill) {
            pill = document.createElement('button');
            pill.id = 'sched-pill'; pill.type = 'button';
            pill.onclick = () => openQuick();
            document.body.appendChild(pill);
        }
        const t = data.today;
        pill.className = t.special ? 'special' : '';
        pill.innerHTML = `🕒 <span>Hoje: ${esc(short(t.periods) || 'sem expediente')}</span>`;
        pill.title = 'Mudar o horário de hoje';
    }

    // ─── Painel rápido: mudanças no meio do expediente ──────────────────────
    // opts.ask   → pergunta "está certo?" (abertura do dia)
    // opts.blocked → aberto da tela de bloqueio (recarrega ao concluir)
    async function openQuick(opts = {}) {
        let data;
        try { data = await json('/schedule'); } catch (e) { alert(e.message); return; }
        const t = data.today;
        document.querySelector('.sched-modal')?.remove();
        const el = document.createElement('div');
        el.className = 'modal-overlay sched-modal';
        el.innerHTML = `
            <div class="modal-card">
                <div class="modal-header"><h3>🕒 Horário de hoje</h3>${opts.ask ? '' : '<button class="modal-close" data-c="x">×</button>'}</div>
                <div class="modal-body">
                    <p class="sched-big">${esc(txt(t.periods))}</p>
                    <p class="input-hint">${t.special ? 'Horário especial' + (t.note ? ': ' + esc(t.note) : '') : 'Expediente normal'} · agora são ${nowHHMM()}</p>
                    ${opts.ask ? '<p>O horário de hoje está certo?</p>' : '<p>Aconteceu algum imprevisto? Ajuste o horário de hoje:</p>'}
                    <div class="sched-choices">
                        ${opts.ask ? '<button type="button" data-c="ok" class="btn-primary">Sim, está certo</button>' : ''}
                        <button type="button" data-c="extra">⏩ Horário corrido (${esc(txt(data.extraPeriods))})</button>
                        <div class="sched-until">
                            <button type="button" data-c="until">➕ Trabalhar de agora até</button>
                            <input type="time" value="${plusHour()}" aria-label="Até que horas">
                        </div>
                        ${opts.blocked ? '' : '<button type="button" data-c="close" class="danger">⏹ Encerrar o expediente agora</button>'}
                        ${t.special ? '<button type="button" data-c="normal">↩ Voltar ao horário normal</button>' : ''}
                        ${opts.blocked ? '' : '<button type="button" data-c="other" class="link">Programar outro dia…</button>'}
                    </div>
                    <label class="access-field sched-note">Motivo (opcional)
                        <input maxlength="120" placeholder="Ex: falecimento, falta de energia, reunião">
                    </label>
                    <p class="sched-error" hidden></p>
                </div>
            </div>`;
        el.style.display = 'flex';
        document.body.appendChild(el);

        const note = () => el.querySelector('.sched-note input').value.trim();
        const done = () => {
            if (opts.ask) localStorage.setItem(KEY_ACK, t.date);
            el.remove();
            if (opts.blocked) { location.reload(); return; }
            refreshPill();
            if (document.getElementById('sched-today')?.offsetParent) loadPanel();
        };
        const fail = (m) => { const p = el.querySelector('.sched-error'); p.textContent = m; p.hidden = false; };
        const action = (body) => json('/schedule/today', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, note: note() || undefined }) });

        el.addEventListener('click', async (e) => {
            const c = e.target.closest('button[data-c]');
            if (!c) return;
            try {
                switch (c.dataset.c) {
                    case 'x': el.remove(); return;
                    case 'ok': break;
                    case 'extra': await action({ action: 'extra' }); break;
                    case 'until': await action({ action: 'work_until', until: el.querySelector('.sched-until input').value }); break;
                    case 'close':
                        if (!confirm('Encerrar o expediente de hoje agora? As atendentes serão desconectadas (o admin continua com acesso).')) return;
                        await action({ action: 'close_now' }); break;
                    case 'normal': await json('/schedule/special/' + t.date, { method: 'DELETE' }); break;
                    case 'other':
                        el.remove();
                        if (typeof switchSection === 'function') { switchSection('config'); showConfigPage(5); }
                        return;
                }
                done();
            } catch (err) { fail(err.message); }
        });
    }

    // Abertura do dia: pergunta uma vez por dia em cada aparelho
    async function promptToday() {
        refreshPill();
        let data;
        try { data = await json('/schedule'); } catch { return; }
        if (!data.enforceSchedule || localStorage.getItem(KEY_ACK) === data.today.date) return;
        openQuick({ ask: true });
    }

    function bindSocket(socket) {
        socket.on('schedule_changed', (d) => {
            refreshPill();
            if (!d.today) return;
            toast(`🕒 <strong>${esc(d.by)}</strong> mudou o horário de hoje: <strong>${esc(d.text)}</strong>${d.note ? ` — ${esc(d.note)}` : ''}`);
        });
        socket.on('shift_ending', (d) => {
            toast(`⏰ O expediente termina às <strong>${esc(d.endsAt)}</strong> (em ${d.minutesLeft} min).`,
                { action: { label: 'Ajustar horário', run: () => openQuick() }, timeout: 60000 });
        });
    }

    window.addEventListener('tm:adjust-schedule', (e) => openQuick({ blocked: e.detail && e.detail.blocked }));

    // ─── Painel em Configurações ────────────────────────────────────────────
    let bound = false;
    async function loadPanel() {
        bind();
        let data;
        try { data = await json('/schedule'); } catch (e) { document.getElementById('sched-today').textContent = e.message; return; }
        const t = data.today;
        document.getElementById('sched-today').innerHTML = `
            <h4>Hoje, ${esc(fmtDate(t.date))}</h4>
            <p class="sched-big">${esc(txt(t.periods))}</p>
            <p class="input-hint">${t.special ? 'Horário especial' + (t.note ? ': ' + esc(t.note) : '') : 'Expediente normal'} ·
               normal: ${esc(txt(data.normal.periods))}</p>`;
        document.getElementById('sched-extra-label').textContent = `Extraordinário (${txt(data.extraPeriods)})`;
        document.getElementById('sched-limit').textContent =
            `Atendentes podem definir horários entre ${data.attendantLimit.start} e ${data.attendantLimit.end}. Para retirar o bloqueio, fale com o administrador.`;
        const form = document.getElementById('sched-form');
        form.dataset.extra = JSON.stringify(data.extraPeriods);
        if (!form.elements.date.value) form.elements.date.value = t.date;
        form.elements.date.min = t.date;
        const list = document.getElementById('sched-list');
        list.innerHTML = data.specialDays.length ? data.specialDays.map(d => `
            <li data-date="${esc(d.date)}">
                <div><strong>${esc(fmtDate(d.date))}</strong> — ${esc(txt(d.periods))}
                    <small>${d.note ? esc(d.note) + ' · ' : ''}por ${esc(d.by || '—')}</small></div>
                <button type="button" class="sched-remove">Voltar ao normal</button>
            </li>`).join('') : '<li class="patient-empty">Nenhum dia especial programado.</li>';
    }

    function bind() {
        if (bound) return;
        bound = true;
        const form = document.getElementById('sched-form');
        form.addEventListener('change', () => {
            form.querySelector('.sched-custom').hidden = form.elements.kind.value !== 'custom';
        });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = form.elements;
            const periods = f.kind.value === 'extra' ? JSON.parse(form.dataset.extra || '[]')
                : f.kind.value === 'closed' ? [] : f.periods.value;
            if (f.kind.value === 'closed' && !confirm('Marcar esse dia como SEM expediente? Ninguém (exceto o admin) conseguirá entrar.')) return;
            try {
                await put(f.date.value, { periods, note: f.note.value });
                f.note.value = '';
                localStorage.removeItem(KEY_ACK);
                loadPanel();
                refreshPill();
            } catch (err) { alert(err.message); }
        });
        document.getElementById('sched-list').addEventListener('click', async (e) => {
            const btn = e.target.closest('.sched-remove');
            if (!btn) return;
            try { await json('/schedule/special/' + btn.closest('li').dataset.date, { method: 'DELETE' }); loadPanel(); }
            catch (err) { alert(err.message); }
        });
    }

    window.Schedule = { promptToday, loadPanel, openQuick, bindSocket, refreshPill, toast };
})();
