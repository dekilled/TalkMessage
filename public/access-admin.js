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

    const ago = (iso) => {
        if (!iso) return 'nunca';
        const m = Math.round((Date.now() - new Date(iso)) / 60000);
        return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : fmt(iso);
    };

    let maxRenewals = 3;
    function renderDevices(devices, you, serverIps) {
        const el = document.getElementById('devices-container');
        const approved = devices.filter(d => d.status === 'approved');
        const pending = devices.filter(d => d.status === 'pending').length;
        document.getElementById('devices-count').innerHTML =
            `${approved.filter(d => d.online).length} online · ${approved.length} autorizados${pending ? ` · <b class="pending-count">${pending} aguardando</b>` : ''}`;

        const central = `
            <div class="device-row device-approved device-central">
                <span class="dot online" title="Online"></span>
                <div class="device-icon">🖥️</div>
                <div class="device-info">
                    <strong>Computador central (servidor)</strong>
                    <span class="device-ip">${esc(serverIps.join(', ') || 'localhost')}</span>
                    <span class="device-meta">Sempre autorizado</span>
                </div>
                <div class="device-actions"><span class="device-badge badge-approved">Servidor</span></div>
            </div>`;

        el.innerHTML = central + devices.map(d => {
            const ipChanged = d.status === 'approved' && d.approved_ip && d.approved_ip !== d.ip && !d.preauthorized;
            const ipInfo = d.preauthorized ? `IP ${esc(d.approved_ip)} · aguardando o aparelho conectar`
                : ipChanged ? `<span class="ip-warn">autorizado em ${esc(d.approved_ip)}, agora em ${esc(d.ip)}</span>`
                : `IP ${esc(d.approved_ip || d.ip || '—')}`;
            return `
            <div class="device-row device-${d.status}" data-id="${esc(d.device_id)}" data-ip="${esc(d.ip || '')}">
                <span class="dot ${d.online ? 'online' : ''}" title="${d.online ? 'Online' : 'Offline'}"></span>
                <div class="device-icon">${d.type === 'mobile' ? '📱' : '💻'}</div>
                <div class="device-info">
                    <input class="device-name-input" value="${esc(d.name || '')}" placeholder="Dar um nome (ex: Recepção 1)">
                    <span class="device-ip">${ipInfo}${d.preauthorized ? '' : ` · código <strong>${esc(d.device_id.slice(-6).toUpperCase())}</strong>`}${d.device_id === you.deviceId ? ' · <em>este aparelho</em>' : ''}</span>
                    <span class="device-meta">${d.online ? '🟢 online agora' : 'visto ' + ago(d.last_seen)}${d.last_user ? ' · ' + esc(d.last_user) : ''}${d.status === 'approved' && !d.preauthorized ? ` · renovações automáticas: ${d.auto_renewals || 0}/${maxRenewals}` : ''}</span>
                    ${d.last_renewal_at ? `<span class="device-meta renewed">↻ IP renovado ${ago(d.last_renewal_at)} (${esc(d.last_renewal_from)} → ${esc(d.approved_ip)})</span>` : ''}
                </div>
                <div class="device-actions">
                    <span class="device-badge badge-${d.status}">${STATUS[d.status]}</span>
                    ${d.status !== 'approved' ? '<button type="button" data-act="approved" class="ok">Autorizar</button>' : ''}
                    ${ipChanged ? '<button type="button" data-act="rebind" class="ok">Autorizar novo IP</button>' : ''}
                    ${d.status !== 'blocked' && !d.preauthorized ? '<button type="button" data-act="blocked" class="danger">Bloquear</button>' : ''}
                    <button type="button" data-act="remove" title="Remover da lista">🗑</button>
                </div>
            </div>`;
        }).join('');
    }

    function fillForm(cfg) {
        const f = document.getElementById('access-form');
        for (const k of ['disabled', 'enforceSchedule', 'adminBypassSchedule', 'enforceNetwork', 'enforceDevices', 'bindDeviceIp', 'autoRenewIp']) f.elements[k].checked = !!cfg[k];
        f.elements.maxAutoRenewals.value = cfg.maxAutoRenewals;
        maxRenewals = cfg.maxAutoRenewals;
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
            fillForm(data.config); // garante maxRenewals antes de desenhar a lista
            renderDevices(data.devices, data.you, data.serverIps);
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
                    bindDeviceIp: f.bindDeviceIp.checked,
                    autoRenewIp: f.autoRenewIp.checked,
                    maxAutoRenewals: f.maxAutoRenewals.value,
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
            const row = btn.closest('.device-row');
            const id = row.dataset.id;
            try {
                if (btn.dataset.act === 'remove') {
                    if (!confirm('Remover este aparelho da lista? Se ele voltar, aparecerá como pendente.')) return;
                    await json('/devices/' + encodeURIComponent(id), { method: 'DELETE' });
                } else if (btn.dataset.act === 'rebind') {
                    await json('/devices/' + encodeURIComponent(id), send('PUT', { ip: row.dataset.ip }));
                } else {
                    const name = row.querySelector('.device-name-input').value.trim();
                    if (btn.dataset.act === 'approved' && !name) {
                        const typed = prompt('Dê um nome para este aparelho (ex: Recepção 1, Celular da Ana):');
                        if (typed === null) return;
                        await json('/devices/' + encodeURIComponent(id), send('PUT', { status: 'approved', name: typed.trim() || undefined }));
                    } else {
                        await json('/devices/' + encodeURIComponent(id), send('PUT', { status: btn.dataset.act }));
                    }
                }
                load();
            } catch (err) { alert(err.message); }
        });

        document.getElementById('devices-container').addEventListener('change', async (e) => {
            if (!e.target.classList.contains('device-name-input')) return;
            const id = e.target.closest('.device-row').dataset.id;
            try { await json('/devices/' + encodeURIComponent(id), send('PUT', { name: e.target.value.trim() })); } catch (err) { alert(err.message); }
        });

        document.getElementById('device-add-btn').addEventListener('click', async () => {
            const name = document.getElementById('device-add-name');
            const ip = document.getElementById('device-add-ip');
            try {
                await json('/devices', send('POST', { name: name.value.trim(), ip: ip.value.trim(), type: document.getElementById('device-add-type').value }));
                name.value = ''; ip.value = '';
                load();
            } catch (err) { alert(err.message); }
        });
    }

    // Tempo real: atualiza a lista e avisa quando chega aparelho novo
    let reloadTimer = null;
    function bindSocket(socket) {
        socket.on('devices_changed', (e) => {
            const open = document.getElementById('devices-container')?.offsetParent;
            if (e.type === 'auto_renewed' && e.device && window.Schedule && Schedule.toast) {
                Schedule.toast(`↻ <strong>${esc(e.device.name || 'Aparelho')}</strong> mudou de IP (${esc(e.from)} → ${esc(e.device.approved_ip)}) e foi renovado automaticamente (${e.device.auto_renewals}/${maxRenewals}).`, { timeout: 20000 });
            }
            if (open) { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 300); }
            if (e.type === 'new' && e.device && window.Schedule && Schedule.toast) {
                Schedule.toast(`📱 Novo aparelho aguardando autorização (IP ${esc(e.device.ip)})`, {
                    action: { label: 'Ver', run: () => { switchSection('config'); showConfigPage(2); } }, timeout: 30000
                });
            }
        });
    }

    window.AccessAdmin = { load, bindSocket };
})();
