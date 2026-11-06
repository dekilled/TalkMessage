// access.js — controle de acesso por rede, dispositivo e horário de trabalho.
//
// Regras (nessa ordem):
//  1. O próprio computador central (localhost) sempre tem acesso.
//  2. Rede: só IPs das faixas permitidas (padrão: redes locais privadas).
//  3. Dispositivo (opcional): só aparelhos aprovados pelo admin. Aparelhos
//     novos ficam "pendentes" até o admin aprovar.
//  4. Horário: fora do expediente só o admin entra (se "admin ignora horário").
//  Só o admin pode mudar as regras, liberar temporariamente ou desativar o bloqueio.
const db = require('./db');

db.sql.exec(`
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT,
    ip TEXT,
    user_agent TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','blocked')),
    last_user TEXT,
    last_seen TEXT,
    created_at TEXT NOT NULL
);`);

const DEFAULTS = {
    disabled: false,                 // chave geral: true = nenhum bloqueio (só o admin muda)
    enforceNetwork: true,
    allowedNetworks: ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12'],
    enforceDevices: false,
    enforceSchedule: true,
    schedule: { days: [1, 2, 3, 4, 5], start: '07:00', end: '18:00' }, // 0 = domingo
    adminBypassSchedule: true,
    overrideUntil: null              // liberação temporária do horário (ISO)
};

function getConfig() {
    const saved = db.getSetting('access', {});
    return { ...DEFAULTS, ...saved, schedule: { ...DEFAULTS.schedule, ...(saved.schedule || {}) } };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function validate(cfg) {
    if (!Array.isArray(cfg.allowedNetworks) || cfg.allowedNetworks.some(n => !parseCidr(n))) return 'Faixa de rede inválida (use o formato 192.168.0.0/24).';
    const s = cfg.schedule;
    if (!TIME_RE.test(s.start) || !TIME_RE.test(s.end)) return 'Horário inválido (use HH:MM).';
    if (!Array.isArray(s.days) || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return 'Dias da semana inválidos.';
    return null;
}

function saveConfig(patch) {
    const cur = getConfig();
    const next = { ...cur };
    for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) next[k] = patch[k];
    if (patch.schedule) next.schedule = { ...cur.schedule, ...patch.schedule };
    if (typeof next.allowedNetworks === 'string') next.allowedNetworks = next.allowedNetworks.split(/[\s,]+/).filter(Boolean);
    for (const k of ['disabled', 'enforceNetwork', 'enforceDevices', 'enforceSchedule', 'adminBypassSchedule']) next[k] = !!next[k];
    const err = validate(next);
    if (err) throw new Error(err);
    db.setSetting('access', next);
    return next;
}

// ─── Rede ─────────────────────────────────────────────────────────────────────
function ipToInt(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function parseCidr(cidr) {
    const [ip, bitsStr = '32'] = String(cidr).trim().split('/');
    const base = ipToInt(ip), bits = Number(bitsStr);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return { base: (base & mask) >>> 0, mask };
}

// IP real da conexão (não confia em X-Forwarded-For: não há proxy na rede local)
function clientIp(reqOrSocket) {
    const raw = (reqOrSocket.socket || reqOrSocket.conn || reqOrSocket).remoteAddress
        || reqOrSocket.address || '';
    return raw.replace(/^::ffff:/, '');
}

const isLocalhost = (ip) => ip === '127.0.0.1' || ip === '::1';

function ipAllowed(ip, cfg) {
    if (isLocalhost(ip)) return true;
    const n = ipToInt(ip);
    if (n === null) return false; // IPv6 externo etc.
    return cfg.allowedNetworks.some(c => { const r = parseCidr(c); return r && ((n & r.mask) >>> 0) === r.base; });
}

// ─── Horário ──────────────────────────────────────────────────────────────────
function scheduleStatus(cfg = getConfig(), now = new Date()) {
    const { days, start, end } = cfg.schedule;
    const minutes = now.getHours() * 60 + now.getMinutes();
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const s = toMin(start), e = toMin(end);
    // Suporta expediente que vira a noite (ex: 22:00–06:00)
    const inWindow = s <= e ? (minutes >= s && minutes < e) : (minutes >= s || minutes < e);
    const day = (s > e && minutes < e) ? (now.getDay() + 6) % 7 : now.getDay();
    const override = cfg.overrideUntil && new Date(cfg.overrideUntil) > now;
    return {
        open: !cfg.enforceSchedule || override || (days.includes(day) && inWindow),
        override: !!override,
        overrideUntil: override ? cfg.overrideUntil : null,
        schedule: cfg.schedule
    };
}

const DAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function scheduleText(cfg) {
    const { days, start, end } = cfg.schedule;
    return `${days.slice().sort().map(d => DAY_NAMES[d]).join(', ')} das ${start} às ${end}`;
}

// ─── Dispositivos ─────────────────────────────────────────────────────────────
const deviceIdOf = (req) => String(req.headers['x-device-id'] || '').slice(0, 64) || null;

function touchDevice(deviceId, ip, ua, user) {
    if (!deviceId) return null;
    const t = new Date().toISOString();
    db.sql.prepare(`INSERT INTO devices (device_id, ip, user_agent, last_user, last_seen, created_at, type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET ip = excluded.ip, user_agent = excluded.user_agent,
            last_user = COALESCE(excluded.last_user, devices.last_user), last_seen = excluded.last_seen`)
        .run(deviceId, ip, (ua || '').slice(0, 300), user || null, t, t, /Mobi|Android|iPhone/i.test(ua || '') ? 'mobile' : 'computer');
    return db.sql.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
}

// Evita gravar no banco a cada requisição: atualiza o "visto por último" no máximo 1x/min por aparelho
const lastTouch = new Map();
function seenDevice(deviceId, ip, ua, user) {
    const prev = lastTouch.get(deviceId);
    if (prev && Date.now() - prev.at < 60000 && prev.row.ip === ip && (!user || prev.row.last_user === user)) {
        return db.sql.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
    }
    const row = touchDevice(deviceId, ip, ua, user);
    if (row) lastTouch.set(deviceId, { at: Date.now(), row });
    return row;
}

const listDevices = () => db.sql.prepare("SELECT * FROM devices ORDER BY status = 'pending' DESC, last_seen DESC").all();

function updateDevice(deviceId, { name, status }) {
    if (status && !['pending', 'approved', 'blocked'].includes(status)) throw new Error('Status inválido.');
    const r = db.sql.prepare('UPDATE devices SET name = COALESCE(?, name), status = COALESCE(?, status) WHERE device_id = ?')
        .run(name ?? null, status ?? null, deviceId);
    lastTouch.delete(deviceId);
    return r.changes > 0;
}

function removeDevice(deviceId) {
    lastTouch.delete(deviceId);
    return db.sql.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId).changes > 0;
}

// ─── Verificação central ──────────────────────────────────────────────────────
// Retorna null se liberado, ou { status, code, message }.
function check({ ip, deviceId, userAgent, user, stage }) {
    const cfg = getConfig();
    if (cfg.disabled || isLocalhost(ip)) return null;

    if (cfg.enforceNetwork && !ipAllowed(ip, cfg)) {
        return { status: 403, code: 'NETWORK_BLOCKED', message: `Acesso permitido apenas pela rede da secretaria (seu IP: ${ip}).` };
    }

    // Dispositivo e horário só valem para a API (arquivos estáticos e /api/ping passam)
    if (stage === 'network') return null;

    if (cfg.enforceDevices) {
        const isAdmin = user && user.role === 'admin';
        if (!deviceId) {
            if (!isAdmin) return { status: 403, code: 'DEVICE_UNKNOWN', message: 'Dispositivo não identificado.' };
        } else {
            const dev = seenDevice(deviceId, ip, userAgent, user && user.username);
            // O admin sempre consegue entrar (para poder aprovar os outros aparelhos)
            if (!isAdmin && dev.status !== 'approved') {
                return dev.status === 'blocked'
                    ? { status: 403, code: 'DEVICE_BLOCKED', message: 'Este dispositivo foi bloqueado pelo administrador.' }
                    : { status: 403, code: 'DEVICE_PENDING', message: 'Este dispositivo aguarda aprovação do administrador.', deviceId };
            }
        }
    } else if (deviceId) {
        seenDevice(deviceId, ip, userAgent, user && user.username);
    }

    if (user && !(cfg.adminBypassSchedule && user.role === 'admin')) {
        const st = scheduleStatus(cfg);
        if (!st.open) {
            return { status: 403, code: 'OUT_OF_HOURS', message: `Fora do horário de expediente. Acesso liberado ${scheduleText(cfg)}.` };
        }
    }
    return null;
}

// Rotas sempre liberadas (após a checagem de rede) para o app conseguir mostrar o motivo do bloqueio
const OPEN_PATHS = new Set(['/api/ping', '/access/status', '/auth/logout']);

// Middleware 1 (antes de tudo): rede
function networkMiddleware(req, res, next) {
    const denied = check({ ip: clientIp(req), stage: 'network' });
    if (!denied) return next();
    if ((req.headers.accept || '').includes('text/html')) {
        return res.status(403).send(blockedPage(denied.message));
    }
    res.status(403).json({ success: false, ...denied });
}

// Middleware 2 (depois da sessão): dispositivo + horário para usuários logados
function requestMiddleware(req, res, next) {
    if (OPEN_PATHS.has(req.path) || req.method === 'OPTIONS') return next();
    const isApi = req.path !== '/' && !/\.\w+$/.test(req.path); // arquivos estáticos passam
    if (!isApi) return next();
    const user = req.session && req.session.user;
    // /auth/login é verificado na própria rota (depois de saber quem é o usuário)
    if (!user && req.path !== '/auth/login') return next();
    if (req.path === '/auth/login') return next();
    const denied = check({ ip: clientIp(req), deviceId: deviceIdOf(req), userAgent: req.headers['user-agent'], user });
    if (!denied) return next();
    res.status(denied.status).json({ success: false, ...denied });
}

function blockedPage(message) {
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acesso bloqueado</title><style>body{font-family:system-ui,sans-serif;background:#f4f6f8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.b{background:#fff;padding:32px;border-radius:14px;max-width:420px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}h1{color:#075e54;font-size:1.3rem}</style></head>
<body><div class="b"><h1>🔒 Acesso bloqueado</h1><p>${String(message).replace(/</g, '&lt;')}</p></div></body></html>`;
}

function publicStatus() {
    const cfg = getConfig();
    const st = scheduleStatus(cfg);
    return {
        disabled: cfg.disabled,
        enforceSchedule: cfg.enforceSchedule,
        open: cfg.disabled || st.open,
        override: st.override,
        overrideUntil: st.overrideUntil,
        scheduleText: scheduleText(cfg),
        serverTime: new Date().toISOString()
    };
}

module.exports = {
    getConfig, saveConfig, scheduleStatus, scheduleText, publicStatus,
    check, clientIp, deviceIdOf, ipAllowed, parseCidr,
    networkMiddleware, requestMiddleware,
    listDevices, updateDevice, removeDevice
};
