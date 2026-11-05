// api.js — camada única de comunicação com o servidor central.
// No navegador (página servida pelo próprio servidor) usa caminhos relativos.
// No cliente empacotado (APK/EXE: file://, capacitor://, localhost) usa o
// endereço do servidor salvo no aparelho e autentica por token.
(function () {
    const KEY_SERVER = 'tm_server';
    const KEY_TOKEN = 'tm_token';

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
            return window.fetch(this.url(path), { ...opts, headers, credentials: 'include' })
                .then(res => {
                    if (res.status === 401 && this.isClient) this.setToken(null);
                    return res;
                });
        },

        socket() {
            return io(this.base || undefined, {
                withCredentials: true,
                auth: this.token ? { token: this.token } : {}
            });
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
