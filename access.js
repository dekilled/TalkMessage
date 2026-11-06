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
    // Expediente normal: dias da semana (0 = domingo) e períodos do dia
    schedule: { days: [1, 2, 3, 4, 5], periods: [{ start: '07:00', end: '11:00' }, { start: '13:00', end: '17:00' }] },
    // Atalho "horário extraordinário" oferecido às atendentes
    extraPeriods: [{ start: '07:00', end: '12:00' }],
    // Limite para dias especiais definidos por atendentes (admin não tem limite)
    attendantLimit: { start: '06:00', end: '19:00' },
    adminBypassSchedule: true,
    overrideUntil: null              // liberação temporária do horário (ISO)
};

function getConfig() {
    const saved = db.getSetting('access', {});
    const schedule = { ...DEFAULTS.schedule, ...(saved.schedule || {}) };
    // Formato antigo (start/end único) → períodos
    if (schedule.start && schedule.end && !(saved.schedule && saved.schedule.periods)) {
        schedule.periods = [{ start: schedule.start, end: schedule.end }];
    }
    delete schedule.start; delete schedule.end;
    return { ...DEFAULTS, ...saved, schedule };
}

// ─── Períodos ("07:00-11:00, 13:00-17:00") ───────────────────────────────────
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function parsePeriods(input) {
    if (Array.isArray(input)) return input.map(p => ({ start: String(p.start || '').trim(), end: String(p.end || '').trim() }));
    return String(input || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean).map(x => {
        const [start = '', end = ''] = x.split(/\s*(?:-|–|às|a)\s*/);
        return { start: start.replace(/h$/, ''), end: end.replace(/h$/, '') };
    });
}

function validatePeriods(periods, { allowEmpty = false, limit = null } = {}) {
    if (!Array.isArray(periods) || (!allowEmpty && !periods.length)) return 'Informe ao menos um período (ex: 07:00-11:00).';
    if (periods.length > 6) return 'Máximo de 6 períodos por dia.';
    const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        if (!TIME_RE.test(p.start) || !TIME_RE.test(p.end)) return 'Horário inválido (use HH:MM, ex: 07:00-11:00).';
        if (toMin(p.start) >= toMin(p.end)) return `O período ${p.start}-${p.end} termina antes de começar.`;
        if (i && toMin(p.start) < toMin(sorted[i - 1].end)) return 'Os períodos não podem se sobrepor.';
        if (limit && (toMin(p.start) < toMin(limit.start) || toMin(p.end) > toMin(limit.end))) {
            return `Atendentes só podem definir horários entre ${limit.start} e ${limit.end}.`;
        }
    }
    return null;
}

const periodsText = (periods) => periods.length ? periods.map(p => `${p.start}–${p.end}`).join(' e ') : 'sem expediente';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function validate(cfg) {
    if (!Array.isArray(cfg.allowedNetworks) || cfg.allowedNetworks.some(n => !parseCidr(n))) return 'Faixa de rede inválida (use o formato 192.168.0.0/24).';
    const s = cfg.schedule;
    const perr = validatePeriods(s.periods) || validatePeriods(cfg.extraPeriods) || validatePeriods([cfg.attendantLimit]);
    if (perr) return perr;
    if (!Array.isArray(s.days) || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return 'Dias da semana inválidos.';
    return null;
}

function saveConfig(patch) {
    const cur = getConfig();
    const next = { ...cur };
    for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) next[k] = patch[k];
    if (patch.schedule) next.schedule = { ...cur.schedule, ...patch.schedule };
    if (patch.schedule && patch.schedule.periods !== undefined) next.schedule.periods = parsePeriods(patch.schedule.periods);
    if (patch.extraPeriods !== undefined) next.extraPeriods = parsePeriods(patch.extraPeriods);
    if (patch.attendantLimit !== undefined) next.attendantLimit = parsePeriods(patch.attendantLimit)[0] || cur.attendantLimit;
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

// Agora está dentro da janela em que atendentes podem ajustar o horário?
function withinAttendantWindow(cfg = getConfig(), now = new Date()) {
    const m = now.getHours() * 60 + now.getMinutes();
    return m >= toMin(cfg.attendantLimit.start) && m < toMin(cfg.attendantLimit.end);
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Junta períodos sobrepostos/encostados
function mergePeriods(list) {
    const sorted = list.filter(p => toMin(p.start) < toMin(p.end)).sort((a, b) => toMin(a.start) - toMin(b.start));
    const out = [];
    for (const p of sorted) {
        const last = out[out.length - 1];
        if (last && toMin(p.start) <= toMin(last.end)) { if (toMin(p.end) > toMin(last.end)) last.end = p.end; }
        else out.push({ ...p });
    }
    return out;
}

// Mudanças rápidas no meio do expediente (imprevistos)
//  extra      → horário corrido/extraordinário (ex: 07:00–12:00)
//  close_now  → encerra o expediente de hoje agora
//  work_until → trabalha de agora até HH:MM (estende ou cobre o intervalo)
function todayAction(action, { until, note } = {}, user) {
    const cfg = getConfig();
    const now = new Date();
    const nowStr = hhmm(now);
    const { periods } = periodsFor(now, cfg);
    let next;
    if (action === 'extra') {
        next = cfg.extraPeriods;
    } else if (action === 'close_now') {
        next = periods.filter(p => p.start < nowStr).map(p => ({ start: p.start, end: p.end < nowStr ? p.end : nowStr }));
    } else if (action === 'work_until') {
        if (!TIME_RE.test(until || '') || until <= nowStr) throw new Error('Informe um horário de término depois de agora.');
        next = mergePeriods([...periods, { start: nowStr, end: until }]);
    } else {
        throw new Error('Ação inválida.');
    }
    const defaults = { extra: 'Horário corrido', close_now: `Expediente encerrado às ${nowStr}`, work_until: `Expediente até ${until}` };
    return setSpecialDay(dateKey(now), { periods: next, note: note || defaults[action] }, user);
}

// ─── Horário ──────────────────────────────────────────────────────────────────
// ─── Dias especiais (horário extraordinário, feriado…) ───────────────────────
// Guardados por data local: { 'AAAA-MM-DD': { periods, note, by, at } }
const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getSpecialDays() { return db.getSetting('access_special_days', {}); }

function listSpecialDays() {
    const today = dateKey();
    const all = getSpecialDays();
    // limpa datas antigas (guarda 30 dias de histórico)
    const cutoff = dateKey(new Date(Date.now() - 30 * 86400000));
    let changed = false;
    for (const k of Object.keys(all)) if (k < cutoff) { delete all[k]; changed = true; }
    if (changed) db.setSetting('access_special_days', all);
    return Object.entries(all).filter(([k]) => k >= today).sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v }));
}

function setSpecialDay(date, { periods, note }, user) {
    if (!DATE_RE.test(date)) throw new Error('Data inválida.');
    const today = dateKey();
    if (date < today) throw new Error('Não é possível alterar dias que já passaram.');
    if (date > dateKey(new Date(Date.now() + 90 * 86400000))) throw new Error('Só é possível programar até 90 dias à frente.');
    const cfg = getConfig();
    const list = parsePeriods(periods);
    const err = validatePeriods(list, { allowEmpty: true, limit: user.role === 'admin' ? null : cfg.attendantLimit });
    if (err) throw new Error(err);
    const all = getSpecialDays();
    all[date] = {
        periods: list.sort((a, b) => a.start.localeCompare(b.start)),
        note: String(note || '').slice(0, 120),
        by: user.name || user.username, at: new Date().toISOString()
    };
    db.setSetting('access_special_days', all);
    return { date, ...all[date] };
}

function removeSpecialDay(date) {
    const all = getSpecialDays();
    if (!all[date]) return false;
    delete all[date];
    db.setSetting('access_special_days', all);
    return true;
}

// Períodos que valem num dia (especial tem prioridade sobre o normal)
function periodsFor(date = new Date(), cfg = getConfig()) {
    const special = getSpecialDays()[dateKey(date)];
    if (special) return { periods: special.periods, special };
    return { periods: cfg.schedule.days.includes(date.getDay()) ? cfg.schedule.periods : [], special: null };
}

// ─── Horário ──────────────────────────────────────────────────────────────────
function scheduleStatus(cfg = getConfig(), now = new Date()) {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const { periods, special } = periodsFor(now, cfg);
    const inWindow = periods.some(p => minutes >= toMin(p.start) && minutes < toMin(p.end));
    const override = cfg.overrideUntil && new Date(cfg.overrideUntil) > now;
    return {
        open: !cfg.enforceSchedule || override || inWindow,
        override: !!override,
        overrideUntil: override ? cfg.overrideUntil : null,
        today: { date: dateKey(now), periods, special: !!special, note: special ? special.note : '' },
        schedule: cfg.schedule
    };
}

const DAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function scheduleText(cfg = getConfig()) {
    const { days, periods } = cfg.schedule;
    return `${days.slice().sort().map(d => DAY_NAMES[d]).join(', ')}: ${periodsText(periods)}`;
}

// Mensagem de bloqueio: diz o horário de hoje
function todayText(cfg = getConfig()) {
    const { periods, special } = periodsFor(new Date(), cfg);
    return `Hoje${special ? ' (horário especial)' : ''}: ${periodsText(periods)}.`;
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
// Rotas que a atendente pode usar mesmo fora do horário (para corrigir o horário de hoje)
const SCHEDULE_PATHS = /^\/(schedule(\/today|\/special\/\d{4}-\d{2}-\d{2})?|auth\/me)$/;

function check({ ip, deviceId, userAgent, user, stage, path }) {
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
            const canAdjust = withinAttendantWindow(cfg);
            if (canAdjust && path && SCHEDULE_PATHS.test(path)) return null;
            return { status: 403, code: 'OUT_OF_HOURS', message: `Fora do horário de expediente. ${todayText(cfg)}`, canAdjust };
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
    const denied = check({ ip: clientIp(req), deviceId: deviceIdOf(req), userAgent: req.headers['user-agent'], user, path: req.path });
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
        todayText: todayText(cfg),
        today: st.today,
        extraPeriods: cfg.extraPeriods,
        attendantLimit: cfg.attendantLimit,
        serverTime: new Date().toISOString()
    };
}

module.exports = {
    getConfig, saveConfig, scheduleStatus, scheduleText, todayText, publicStatus,
    listSpecialDays, setSpecialDay, todayAction, withinAttendantWindow, mergePeriods, hhmm, removeSpecialDay, periodsFor, dateKey, periodsText,
    check, clientIp, deviceIdOf, ipAllowed, parseCidr,
    networkMiddleware, requestMiddleware,
    listDevices, updateDevice, removeDevice
};
