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

    // ─── Pop-up ao iniciar (uma vez por dia em cada aparelho) ───────────────
    async function promptToday() {
        let data;
        try { data = await json('/schedule'); } catch { return; }
        if (!data.enforceSchedule) return;
        const t = data.today;
        if (localStorage.getItem(KEY_ACK) === t.date) return;

        const el = document.createElement('div');
        el.className = 'modal-overlay sched-modal';
        el.innerHTML = `
            <div class="modal-card">
                <div class="modal-header"><h3>🕒 Horário de hoje</h3></div>
                <div class="modal-body">
                    <p class="sched-big">${esc(txt(t.periods))}</p>
                    ${t.special ? `<p class="input-hint">Horário especial${t.note ? ': ' + esc(t.note) : ''}.</p>` : '<p class="input-hint">Expediente normal.</p>'}
                    <p>O horário de hoje está certo?</p>
                    <div class="sched-choices">
                        <button type="button" data-c="ok" class="btn-primary">Sim, está certo</button>
                        ${!t.special ? `<button type="button" data-c="extra">Hoje é extraordinário (${esc(txt(data.extraPeriods))})</button>` : '<button type="button" data-c="normal">Voltar ao horário normal</button>'}
                        <button type="button" data-c="other">Outro horário…</button>
                    </div>
                    <p class="sched-error" hidden></p>
                </div>
            </div>`;
        el.style.display = 'flex';
        document.body.appendChild(el);

        const close = () => { localStorage.setItem(KEY_ACK, t.date); el.remove(); };
        const fail = (m) => { const p = el.querySelector('.sched-error'); p.textContent = m; p.hidden = false; };
        el.addEventListener('click', async (e) => {
            const c = e.target.closest('button[data-c]');
            if (!c) return;
            try {
                if (c.dataset.c === 'extra') await put(t.date, { periods: data.extraPeriods, note: 'Horário extraordinário' });
                if (c.dataset.c === 'normal') await json('/schedule/special/' + t.date, { method: 'DELETE' });
                if (c.dataset.c === 'other') {
                    close();
                    if (typeof switchSection === 'function') { switchSection('config'); showConfigPage(5); }
                    return;
                }
                close();
            } catch (err) { fail(err.message); }
        });
    }

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
            } catch (err) { alert(err.message); }
        });
        document.getElementById('sched-list').addEventListener('click', async (e) => {
            const btn = e.target.closest('.sched-remove');
            if (!btn) return;
            try { await json('/schedule/special/' + btn.closest('li').dataset.date, { method: 'DELETE' }); loadPanel(); }
            catch (err) { alert(err.message); }
        });
    }

    window.Schedule = { promptToday, loadPanel };
})();
