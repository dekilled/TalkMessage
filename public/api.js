// api.js — camada única de comunicação com o servidor central.
// No navegador (página servida pelo próprio servidor) usa caminhos relativos.
// No cliente empacotado (APK/EXE: file://, capacitor://, localhost) usa o
// endereço do servidor salvo no aparelho e autentica por token.
(function () {
    const KEY_SERVER = 'tm_server';
    const KEY_TOKEN = 'tm_token';
    const KEY_DEVICE = 'tm_device';

    // Identificador fixo deste aparelho (usado na aprovação de dispositivos pelo admin)
    function deviceId() {
        let id = localStorage.getItem(KEY_DEVICE);
        if (!id) {
            const rnd = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
                : Date.now().toString(36) + Math.random().toString(36).slice(2);
            id = 'dev-' + rnd;
            localStorage.setItem(KEY_DEVICE, id);
        }
        return id;
    }

    const ACCESS_CODES = ['NETWORK_BLOCKED', 'DEVICE_PENDING', 'DEVICE_BLOCKED', 'DEVICE_UNKNOWN', 'OUT_OF_HOURS'];
    const ACCESS_TITLES = {
        NETWORK_BLOCKED: 'Fora da rede da secretaria',
        DEVICE_PENDING: 'Aguardando aprovação',
        DEVICE_BLOCKED: 'Dispositivo bloqueado',
        DEVICE_UNKNOWN: 'Dispositivo não identificado',
        OUT_OF_HOURS: 'Fora do horário de expediente'
    };

    function showBlocked(info) {
        let el = document.getElementById('tm-access-blocked');
        if (!el) {
            el = document.createElement('div');
            el.id = 'tm-access-blocked';
            el.className = 'tm-access-blocked';
            document.body.appendChild(el);
        }
        const code = info.deviceId ? `<p class="tm-device-code">Código do aparelho: <strong>${String(info.deviceId).slice(-6).toUpperCase()}</strong></p>` : '';
        el.innerHTML = `<div class="tm-access-card">
            <div class="tm-access-icon">🔒</div>
            <h2>${ACCESS_TITLES[info.code] || 'Acesso bloqueado'}</h2>
            <p>${String(info.message || '').replace(/</g, '&lt;')}</p>${code}
            ${info.canAdjust ? '<button type="button" id="tm-access-adjust">🕒 Ajustar horário de hoje</button>' : ''}
            <button type="button" id="tm-access-retry" class="${info.canAdjust ? 'secondary' : ''}">Tentar novamente</button>
        </div>`;
        el.style.display = 'flex';
        el.querySelector('#tm-access-retry').onclick = () => location.reload();
        const adj = el.querySelector('#tm-access-adjust');
        if (adj) adj.onclick = () => window.dispatchEvent(new CustomEvent('tm:adjust-schedule', { detail: { blocked: true } }));
    }

    const servedByServer = /^https?:$/.test(location.protocol) &&
        !['localhost', '127.0.0.1'].includes(location.hostname) ||
        window.TM_SERVED_BY_SERVER === true;

    function normalize(url) {
        url = (url || '').trim().replace(/\/+$/, '');
        if (url && !/^https?:\/\//.test(url)) url = 'http://' + url;
        if (url && !/:\d+$/.test(url)) url += ':3001';
        return url;
    }

    const API = {
        isClient: !servedByServer,
        get base() { return servedByServer ? '' : (localStorage.getItem(KEY_SERVER) || ''); },
        setServer(url) { localStorage.setItem(KEY_SERVER, normalize(url)); },
        get token() { return localStorage.getItem(KEY_TOKEN); },
        setToken(t) { t ? localStorage.setItem(KEY_TOKEN, t) : localStorage.removeItem(KEY_TOKEN); },

        url(path) { return this.base + path; },

        fetch(path, opts = {}) {
            const headers = new Headers(opts.headers || {});
            if (this.token) headers.set('Authorization', 'Bearer ' + this.token);
            headers.set('X-Device-Id', this.deviceId);
            return window.fetch(this.url(path), { ...opts, headers, credentials: 'include' })
                .then(res => {
                    if (res.status === 401 && this.isClient) this.setToken(null);
                    if (res.status === 403) {
                        res.clone().json().then(d => {
                            // Login fora do horário com permissão de ajuste: guarda o token limitado
                            if (d.token) this.setToken(d.token);
                            if (ACCESS_CODES.includes(d.code)) this.blocked(d);
                        }).catch(() => {});
                    }
                    return res;
                });
        },

        get deviceId() { return deviceId(); },

        // Mostra a tela de bloqueio e avisa o app (ex.: para desconectar o socket)
        blocked(info) {
            showBlocked(info);
            window.dispatchEvent(new CustomEvent('tm:access-denied', { detail: info }));
        },

        socket() {
            const s = io(this.base || undefined, {
                withCredentials: true,
                auth: { deviceId: this.deviceId, ...(this.token ? { token: this.token } : {}) }
            });
            s.on('connect_error', (err) => {
                if (ACCESS_CODES.includes(err.message)) {
                    s.disconnect();
                    // Busca a mensagem completa (com horários) pela API
                    this.fetch('/auth/me').catch(() => {});
                    if (err.message === 'NETWORK_BLOCKED') this.blocked({ code: err.message, message: 'Conecte-se à rede da secretaria.' });
                }
            });
            s.on('access_blocked', (info) => this.blocked(info));
            return s;
        },

        // Testa se há um servidor TalkMessage no endereço informado
        async ping(url) {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 3000);
            try {
                const r = await window.fetch(normalize(url) + '/api/ping', { signal: ctrl.signal });
                const j = await r.json();
                return j && j.app === 'talkmessage';
            } catch { return false; } finally { clearTimeout(t); }
        },

        // Garante um servidor configurado (só no modo cliente)
        async ensureServer() {
            if (!this.isClient) return true;
            while (!this.base || !(await this.ping(this.base))) {
                const msg = this.base
                    ? `Não encontrei o servidor em ${this.base}.\nInforme o IP do computador central:`
                    : 'Informe o IP do computador central (ex: 192.168.0.10):';
                const typed = prompt(msg, this.base.replace(/^https?:\/\//, ''));
                if (!typed) return false;
                if (await this.ping(typed)) { this.setServer(typed); return true; }
                localStorage.setItem(KEY_SERVER, normalize(typed));
            }
            return true;
        }
    };

    window.API = API;
})();
