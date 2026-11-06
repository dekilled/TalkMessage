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
const { EventEmitter } = require('events');
// 'devices' → a lista de aparelhos mudou (novo pendente, online/offline, aprovação)
const events = new EventEmitter();

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
// Minutos com o app aberto durante o expediente, por aparelho e dia
db.sql.exec(`CREATE TABLE IF NOT EXISTS device_presence (
    device_id TEXT NOT NULL, date TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, date))`);
const crypto = require('crypto');
// Colunas novas (bancos criados antes desta versão)
for (const col of ['approved_ip TEXT', 'approved_by TEXT', 'approved_at TEXT',
    'device_key TEXT', 'auto_renewals INTEGER NOT NULL DEFAULT 0', 'last_renewal_at TEXT', 'last_renewal_from TEXT']) {
    try { db.sql.exec(`ALTER TABLE devices ADD COLUMN ${col}`); } catch { /* já existe */ }
}

const DEFAULTS = {
    disabled: false,                 // chave geral: true = nenhum bloqueio (só o admin muda)
    enforceNetwork: true,
    allowedNetworks: ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12'],
    enforceDevices: true,            // só aparelhos autorizados pelo servidor
    bindDeviceIp: true,              // o aparelho só vale no IP em que foi autorizado
    autoRenewIp: true,               // renova sozinho o IP de aparelho de uso diário (ver canAutoRenew)
    maxAutoRenewals: 3,              // depois disso, só o admin reautoriza
    renewPresenceRatio: 0.7,         // % do último expediente com o app aberto
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
    for (const k of ['disabled', 'enforceNetwork', 'enforceDevices', 'bindDeviceIp', 'autoRenewIp', 'enforceSchedule', 'adminBypassSchedule']) next[k] = !!next[k];
    next.maxAutoRenewals = Math.max(0, Math.min(10, parseInt(next.maxAutoRenewals, 10) || 0));
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
// Cada aparelho (PC ou celular) tem um código fixo (X-Device-Id, gerado pelo app).
// O admin autoriza o aparelho, que fica vinculado ao IP em que foi autorizado.
// Também dá para pré-autorizar um IP ("ip:192.168.0.20") antes do aparelho conectar.
const deviceIdOf = (req) => String(req.headers['x-device-id'] || '').slice(0, 64) || null;
const now = () => new Date().toISOString();
const getDevice = (id) => db.sql.prepare('SELECT * FROM devices WHERE device_id = ?').get(id);

function touchDevice(deviceId, ip, ua, user) {
    if (!deviceId) return null;
    const isNew = !getDevice(deviceId);
    const t = now();
    db.sql.prepare(`INSERT INTO devices (device_id, ip, user_agent, last_user, last_seen, created_at, type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET ip = excluded.ip, user_agent = excluded.user_agent,
            last_user = COALESCE(excluded.last_user, devices.last_user), last_seen = excluded.last_seen`)
        .run(deviceId, ip, (ua || '').slice(0, 300), user || null, t, t, /Mobi|Android|iPhone/i.test(ua || '') ? 'mobile' : 'computer');

    // IP pré-autorizado pelo admin → o aparelho que chega nesse IP herda a autorização
    const pre = getDevice('ip:' + ip);
    const dev = getDevice(deviceId);
    if (pre && pre.status === 'approved' && dev.status === 'pending') {
        db.sql.prepare(`UPDATE devices SET status = 'approved', name = COALESCE(name, ?), type = COALESCE(?, type),
            approved_ip = ?, approved_by = ?, approved_at = ? WHERE device_id = ?`)
            .run(pre.name, pre.type, ip, pre.approved_by, now(), deviceId);
        db.sql.prepare('DELETE FROM devices WHERE device_id = ?').run(pre.device_id);
    }
    if (isNew) events.emit('devices', { type: 'new', device: getDevice(deviceId) });
    return getDevice(deviceId);
}

// Evita gravar no banco a cada requisição: atualiza o "visto por último" no máximo 1x/min por aparelho
const lastTouch = new Map();
function seenDevice(deviceId, ip, ua, user) {
    const prev = lastTouch.get(deviceId);
    if (prev && Date.now() - prev.at < 60000 && prev.ip === ip && (!user || prev.user === user)) return getDevice(deviceId);
    const row = touchDevice(deviceId, ip, ua, user);
    if (row) lastTouch.set(deviceId, { at: Date.now(), ip, user: row.last_user });
    return row;
}

// Online = com o app aberto (Socket.IO conectado)
const onlineSockets = new Map(); // deviceId -> nº de conexões
function socketOnline(deviceId, delta) {
    if (!deviceId) return;
    const n = (onlineSockets.get(deviceId) || 0) + delta;
    n > 0 ? onlineSockets.set(deviceId, n) : onlineSockets.delete(deviceId);
    events.emit('devices', { type: delta > 0 ? 'online' : 'offline', deviceId });
}

function listDevices() {
    return db.sql.prepare("SELECT * FROM devices ORDER BY status = 'pending' DESC, status = 'approved' DESC, COALESCE(name, device_id)").all()
        .map(d => ({ ...d, online: onlineSockets.has(d.device_id), preauthorized: d.device_id.startsWith('ip:') }));
}

function updateDevice(deviceId, { name, status, ip }, by) {
    if (status && !['pending', 'approved', 'blocked'].includes(status)) throw new Error('Status inválido.');
    if (ip !== undefined && ipToInt(ip) === null) throw new Error('IP inválido.');
    const dev = getDevice(deviceId);
    if (!dev) return false;
    const approving = status === 'approved' && dev.status !== 'approved';
    // Autorização manual (ou novo IP pelo admin) zera as renovações e gera chave nova
    if (approving || ip !== undefined) {
        db.sql.prepare('UPDATE devices SET auto_renewals = 0, device_key = NULL WHERE device_id = ?').run(deviceId);
        pendingKeys.delete(deviceId);
    }
    db.sql.prepare(`UPDATE devices SET name = COALESCE(?, name), status = COALESCE(?, status),
            approved_ip = CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN ip ELSE approved_ip END,
            approved_by = CASE WHEN ? THEN ? ELSE approved_by END,
            approved_at = CASE WHEN ? THEN ? ELSE approved_at END
        WHERE device_id = ?`)
        .run(name ?? null, status ?? null, ip ?? null, ip ?? null, approving ? 1 : 0,
            approving ? 1 : 0, by || null, approving ? 1 : 0, now(), deviceId);
    lastTouch.delete(deviceId);
    events.emit('devices', { type: 'updated', deviceId });
    return true;
}

// Pré-autoriza um IP fixo (ex: computador da recepção com IP reservado)
function addDeviceByIp({ name, ip, type }, by) {
    if (ipToInt(ip || '') === null) throw new Error('IP inválido (ex: 192.168.0.20).');
    if (!name) throw new Error('Informe um nome para o aparelho.');
    const taken = db.sql.prepare("SELECT name FROM devices WHERE approved_ip = ? AND status = 'approved'").get(ip);
    if (taken) throw new Error(`O IP ${ip} já está autorizado para "${taken.name || 'outro aparelho'}".`);
    db.sql.prepare(`INSERT OR REPLACE INTO devices (device_id, name, type, ip, status, approved_ip, approved_by, approved_at, created_at)
        VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)`)
        .run('ip:' + ip, name, type === 'mobile' ? 'mobile' : 'computer', ip, ip, by || null, now(), now());
    events.emit('devices', { type: 'updated' });
    return getDevice('ip:' + ip);
}

// ─── Chave secreta do aparelho ───────────────────────────────────────────────
// O servidor entrega uma chave ao aparelho autorizado; o app a envia em toda
// requisição (X-Device-Key). Se alguém copiar só o código, não tem a chave.
// A cada renovação automática de IP a chave é trocada e a antiga deixa de valer.
// deviceId -> { key: nova, prev: anterior (ou null na 1ª entrega) }. Fica no banco:
// se o servidor reiniciar no meio de uma troca, ninguém fica trancado para fora.
const pendingKeys = {
    _all: () => db.getSetting('pending_device_keys', {}),
    get(id) { return this._all()[id]; },
    has(id) { return !!this._all()[id]; },
    set(id, v) { const a = this._all(); a[id] = v; db.setSetting('pending_device_keys', a); },
    delete(id) { const a = this._all(); if (a[id]) { delete a[id]; db.setSetting('pending_device_keys', a); } }
};
const newKey = () => crypto.randomBytes(24).toString('hex');

function issueKey(deviceId) {
    const key = newKey();
    const prev = (getDevice(deviceId) || {}).device_key || null;
    db.sql.prepare('UPDATE devices SET device_key = ? WHERE device_id = ?').run(key, deviceId);
    pendingKeys.set(deviceId, { key, prev });
    return key;
}

// A chave apresentada vale? Na troca, aceita a anterior até o aparelho confirmar a nova.
function keyValid(dev, presented) {
    if (presented && presented === dev.device_key) return true;
    const p = pendingKeys.get(dev.device_id);
    if (!p) return false;
    return p.prev ? presented === p.prev : !presented; // 1ª entrega: o aparelho ainda não tem chave
}

// Chave a ser entregue ao aparelho (cabeçalho X-Device-Key / evento 'device_key')
function keyToDeliver(deviceId, presented) {
    const p = pendingKeys.get(deviceId);
    if (!p) return null;
    if (presented === p.key) { pendingKeys.delete(deviceId); return null; } // aparelho já guardou
    return p.key;
}

// ─── Presença (app aberto durante o expediente) ──────────────────────────────
function tickPresence() {
    const cfg = getConfig();
    const st = scheduleStatus(cfg);
    if (cfg.enforceSchedule && !st.open) return;
    const today = dateKey();
    const up = db.sql.prepare(`INSERT INTO device_presence (device_id, date, minutes) VALUES (?, ?, 1)
        ON CONFLICT(device_id, date) DO UPDATE SET minutes = minutes + 1`);
    for (const id of onlineSockets.keys()) up.run(id, today);
    db.sql.prepare('DELETE FROM device_presence WHERE date < ?').run(dateKey(new Date(Date.now() - 60 * 86400000)));
}

const dayMinutes = (periods) => periods.reduce((s, p) => s + toMin(p.end) - toMin(p.start), 0);

// Último dia trabalhado (antes de hoje) com expediente: o app ficou aberto o suficiente?
function presenceCheck(deviceId, cfg = getConfig()) {
    const rows = db.sql.prepare('SELECT date, minutes FROM device_presence WHERE device_id = ? AND date < ? ORDER BY date DESC LIMIT 7')
        .all(deviceId, dateKey());
    for (const r of rows) {
        const { periods } = periodsFor(new Date(r.date + 'T12:00:00'), cfg);
        const need = dayMinutes(periods);
        if (!need) continue; // dia sem expediente: olha o anterior
        return { ok: r.minutes >= need * cfg.renewPresenceRatio, date: r.date, minutes: r.minutes, need };
    }
    return { ok: false, date: null, minutes: 0, need: 0 };
}

const sameSubnet24 = (a, b) => a && b && a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');

// Aparelho autorizado mudou de IP: pode renovar sozinho?
function canAutoRenew(dev, ip, presentedKey, cfg = getConfig()) {
    const reasons = [];
    if (!cfg.autoRenewIp) reasons.push('renovação automática desativada');
    if (dev.status !== 'approved' || !dev.approved_ip) reasons.push('aparelho não autorizado');
    if (!dev.device_key || presentedKey !== dev.device_key) reasons.push('chave do aparelho não confere');
    if (pendingKeys.has(dev.device_id)) reasons.push('troca de chave anterior ainda não confirmada');
    if ((dev.auto_renewals || 0) >= cfg.maxAutoRenewals) reasons.push(`limite de ${cfg.maxAutoRenewals} renovações automáticas atingido`);
    if (!sameSubnet24(dev.approved_ip, ip) || !ipAllowed(ip, cfg)) reasons.push('IP novo fora da mesma rede');
    const pres = presenceCheck(dev.device_id, cfg);
    if (!pres.ok) reasons.push(pres.date ? `app aberto só ${pres.minutes} de ${pres.need} min no expediente de ${pres.date}` : 'sem histórico de uso no expediente');
    return { ok: !reasons.length, reasons, presence: pres };
}

function autoRenew(dev, ip) {
    db.sql.prepare(`UPDATE devices SET approved_ip = ?, auto_renewals = auto_renewals + 1,
        last_renewal_at = ?, last_renewal_from = ? WHERE device_id = ?`).run(ip, now(), dev.approved_ip, dev.device_id);
    issueKey(dev.device_id);
    lastTouch.delete(dev.device_id);
    const updated = getDevice(dev.device_id);
    console.log(`[aparelhos] ${dev.name || dev.device_id}: IP renovado automaticamente ${dev.approved_ip} → ${ip} (${updated.auto_renewals}/${getConfig().maxAutoRenewals})`);
    events.emit('devices', { type: 'auto_renewed', device: updated, from: dev.approved_ip });
    return updated;
}

function removeDevice(deviceId) {
    lastTouch.delete(deviceId);
    const ok = db.sql.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId).changes > 0;
    if (ok) events.emit('devices', { type: 'removed', deviceId });
    return ok;
}

// ─── Verificação central ──────────────────────────────────────────────────────
// Retorna null se liberado, ou { status, code, message }.
// Rotas que a atendente pode usar mesmo fora do horário (para corrigir o horário de hoje)
const SCHEDULE_PATHS = /^\/(schedule(\/today|\/special\/\d{4}-\d{2}-\d{2})?|auth\/me)$/;

function check({ ip, deviceId, deviceKey, userAgent, user, stage, path }) {
    const cfg = getConfig();
    if (cfg.disabled || isLocalhost(ip)) return null;

    if (cfg.enforceNetwork && !ipAllowed(ip, cfg)) {
        return { status: 403, code: 'NETWORK_BLOCKED', message: `Acesso permitido apenas pela rede da secretaria (seu IP: ${ip}).` };
    }

    // Dispositivo e horário só valem para a API (arquivos estáticos e /api/ping passam)
    if (stage === 'network') return null;

    // Aparelhos: vale para todos, inclusive o admin (que sempre entra pelo computador central)
    if (cfg.enforceDevices) {
        if (!deviceId) return { status: 403, code: 'DEVICE_UNKNOWN', message: 'Dispositivo não identificado. Atualize o aplicativo.' };
        const dev = seenDevice(deviceId, ip, userAgent, user && user.username);
        if (dev.status === 'blocked') return { status: 403, code: 'DEVICE_BLOCKED', message: 'Este dispositivo foi bloqueado pelo administrador.', deviceId, ip };
        if (dev.status !== 'approved') {
            return { status: 403, code: 'DEVICE_PENDING', message: `Este dispositivo (IP ${ip}) ainda não foi autorizado. Peça ao administrador para autorizá-lo no computador central.`, deviceId, ip };
        }
        // Primeira vez depois de autorizado: entrega a chave do aparelho
        if (!dev.device_key) { issueKey(deviceId); }
        else if (!keyValid(dev, deviceKey)) {
            // Chave errada ou ausente: pode ser uma cópia do código do aparelho
            return { status: 403, code: 'DEVICE_KEY_INVALID', message: 'A chave de segurança deste aparelho não confere. Peça ao administrador para autorizá-lo novamente.', deviceId, ip };
        }
        if (cfg.bindDeviceIp && dev.approved_ip && dev.approved_ip !== ip) {
            const renew = canAutoRenew(dev, ip, deviceKey, cfg);
            if (renew.ok) { autoRenew(dev, ip); return null; }
            if (cfg.autoRenewIp) console.log(`[aparelhos] ${dev.name || deviceId}: IP mudou ${dev.approved_ip} → ${ip}, sem renovação automática: ${renew.reasons.join('; ')}`);
            return { status: 403, code: 'DEVICE_IP_CHANGED', message: `Este dispositivo foi autorizado no IP ${dev.approved_ip}, mas agora está no IP ${ip}. Peça ao administrador para reautorizá-lo.`, deviceId, ip };
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
    const deviceId = deviceIdOf(req), deviceKey = String(req.headers['x-device-key'] || '') || null;
    const denied = check({ ip: clientIp(req), deviceId, deviceKey, userAgent: req.headers['user-agent'], user, path: req.path });
    const k = deviceId && keyToDeliver(deviceId, deviceKey);
    if (k) res.setHeader('X-Device-Key', k);
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
    listDevices, updateDevice, removeDevice, addDeviceByIp, socketOnline, events,
    keyToDeliver, tickPresence, presenceCheck, canAutoRenew, deviceKeyOf: (req) => String(req.headers['x-device-key'] || '') || null
};
