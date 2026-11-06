// access-admin.js — painel do admin: horário, rede, dispositivos e liberação temporária.
(function () {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const STATUS = { pending: 'Pendente', approved: 'Aprovado', blocked: 'Bloqueado' };
    const fmt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

    async function json(path, opts) {
        const res = await API.fetch(path, opts);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `Erro ${res.status}`);
        return data;
    }
    const send = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    let bound = false;

    function renderStatus(status, you) {
        const box = document.getElementById('access-status-box');
        let cls = 'ok', text;
        if (status.disabled) { cls = 'warn'; text = '⚠️ Bloqueios desativados: qualquer aparelho da rede pode entrar a qualquer hora.'; }
        else if (status.override) text = `🔓 Liberação temporária ativa até ${fmt(status.overrideUntil)}.`;
        else if (status.open) text = `✅ Dentro do expediente. ${esc(status.todayText)}`;
        else { cls = 'closed'; text = `🔒 Fora do expediente: só o administrador entra. ${esc(status.todayText)}`; }
        box.className = `config-block access-status access-${cls}`;
        box.innerHTML = `<div>${text}</div><small>Este aparelho: IP ${esc(you.ip)} · código ${esc((you.deviceId || '').slice(-6).toUpperCase())}</small>`;
    }

    function renderDevices(devices, you) {
        const el = document.getElementById('devices-container');
        if (!devices.length) { el.innerHTML = '<p class="input-hint">Nenhum aparelho registrado ainda.</p>'; return; }
        el.innerHTML = devices.map(d => `
            <div class="device-card device-${d.status}" data-id="${esc(d.device_id)}">
                <div class="device-icon">${d.type === 'mobile' ? '📱' : '💻'}</div>
                <div class="device-info">
                    <input class="device-name-input" value="${esc(d.name || '')}" placeholder="Dar um nome (ex: Recepção 1)">
                    <span class="device-ip">${esc(d.ip)} · código <strong>${esc(d.device_id.slice(-6).toUpperCase())}</strong>${d.device_id === you.deviceId ? ' · <em>este aparelho</em>' : ''}</span>
                    <span class="device-meta">${esc(d.last_user || 'sem login')} · visto ${fmt(d.last_seen)}</span>
                </div>
                <div class="device-actions">
                    <span class="device-badge badge-${d.status}">${STATUS[d.status]}</span>
                    ${d.status !== 'approved' ? '<button type="button" data-act="approved" class="ok">Aprovar</button>' : ''}
                    ${d.status !== 'blocked' ? '<button type="button" data-act="blocked" class="danger">Bloquear</button>' : ''}
                    <button type="button" data-act="remove" title="Remover da lista">🗑</button>
                </div>
            </div>`).join('');
    }

    function fillForm(cfg) {
        const f = document.getElementById('access-form');
        for (const k of ['disabled', 'enforceSchedule', 'adminBypassSchedule', 'enforceNetwork', 'enforceDevices']) f.elements[k].checked = !!cfg[k];
        const txt = (ps) => ps.map(p => `${p.start}-${p.end}`).join(', ');
        f.elements.periods.value = txt(cfg.schedule.periods);
        f.elements.extraPeriods.value = txt(cfg.extraPeriods);
        f.elements.attendantLimit.value = txt([cfg.attendantLimit]);
        f.elements.allowedNetworks.value = cfg.allowedNetworks.join('\n');
        document.getElementById('access-days').innerHTML = DAYS.map((d, i) =>
            `<label class="day-chip"><input type="checkbox" value="${i}" ${cfg.schedule.days.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('');
    }

    async function load() {
        bind();
        try {
            const data = await json('/access');
            fillForm(data.config);
            renderStatus(data.status, data.you);
            renderDevices(data.devices, data.you);
            document.getElementById('access-net-hint').textContent =
                `Endereço do servidor: ${data.serverIps.map(ip => ip + ':' + (location.port || '3001')).join(', ') || '—'}. O computador central sempre tem acesso.`;
        } catch (e) {
            document.getElementById('access-status-box').textContent = e.message;
        }
    }

    function bind() {
        if (bound) return;
        bound = true;
        const form = document.getElementById('access-form');

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = form.elements;
            const days = [...document.querySelectorAll('#access-days input:checked')].map(i => Number(i.value));
            if (f.disabled.checked && !confirm('Desativar TODOS os bloqueios? Qualquer aparelho poderá entrar a qualquer hora.')) return;
            try {
                await json('/access', send('PUT', {
                    disabled: f.disabled.checked,
                    enforceSchedule: f.enforceSchedule.checked,
                    adminBypassSchedule: f.adminBypassSchedule.checked,
                    enforceNetwork: f.enforceNetwork.checked,
                    enforceDevices: f.enforceDevices.checked,
                    allowedNetworks: f.allowedNetworks.value,
                    schedule: { days, periods: f.periods.value },
                    extraPeriods: f.extraPeriods.value,
                    attendantLimit: f.attendantLimit.value
                }));
                const ok = form.querySelector('.access-saved');
                ok.hidden = false; setTimeout(() => ok.hidden = true, 2000);
                load();
            } catch (err) { alert(err.message); }
        });

        form.querySelectorAll('[data-override]').forEach(btn => btn.addEventListener('click', async () => {
            const v = btn.dataset.override;
            const body = v === 'cancel' ? { cancel: true } : v === 'eod' ? { endOfDay: true } : { minutes: Number(v) };
            try { await json('/access/override', send('POST', body)); load(); } catch (err) { alert(err.message); }
        }));

        document.getElementById('devices-container').addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const id = btn.closest('.device-card').dataset.id;
            try {
                if (btn.dataset.act === 'remove') {
                    if (!confirm('Remover este aparelho da lista? Se ele voltar, aparecerá como pendente.')) return;
                    await json('/devices/' + encodeURIComponent(id), { method: 'DELETE' });
                } else {
                    await json('/devices/' + encodeURIComponent(id), send('PUT', { status: btn.dataset.act }));
                }
                load();
            } catch (err) { alert(err.message); }
        });

        document.getElementById('devices-container').addEventListener('change', async (e) => {
            if (!e.target.classList.contains('device-name-input')) return;
            const id = e.target.closest('.device-card').dataset.id;
            try { await json('/devices/' + encodeURIComponent(id), send('PUT', { name: e.target.value.trim() })); } catch (err) { alert(err.message); }
        });
    }

    window.AccessAdmin = { load };
})();
