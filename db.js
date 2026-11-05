// db.js — persistência em SQLite (node:sqlite, embutido no Node 22+, sem dependência nativa).
// Mantém a mesma API de antes (load*/save* de arrays) para o restante do código,
// e acrescenta pacientes, histórico (exames/pedidos/passagens), chat, avaliações e tokens.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const sql = new DatabaseSync(path.join(DATA_DIR, 'talkmessage.db'));
sql.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('atendente','supervisor','admin')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
    phone TEXT PRIMARY KEY,           -- só dígitos, ex: 5538999999999
    name TEXT,
    cpf TEXT,
    birth_date TEXT,
    sus_card TEXT,
    address TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Atendimentos (pendente → ativo → concluído). "data" guarda o objeto completo.
CREATE TABLE IF NOT EXISTS attendances (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL REFERENCES patients(phone),
    status TEXT NOT NULL CHECK (status IN ('pending','active','completed')),
    service TEXT,
    attendant TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    rated_at TEXT,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_phone ON attendances(phone);
CREATE INDEX IF NOT EXISTS idx_att_status ON attendances(status);

-- Exames, pedidos, passagens, cirurgias, consultas… da ficha do paciente
CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL REFERENCES patients(phone),
    type TEXT NOT NULL CHECK (type IN ('exame','pedido','passagem','cirurgia','consulta','outro')),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'solicitado',
    date TEXT,
    notes TEXT,
    attendance_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_phone ON records(phone);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    from_role TEXT NOT NULL,
    sender TEXT,
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_phone ON chat_messages(phone);

CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();
const phoneKey = (phone) => String(phone || '').replace(/@.*$/, '').replace(/\D/g, '');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function tx(fn) {
    sql.exec('BEGIN');
    try { const r = fn(); sql.exec('COMMIT'); return r; } catch (e) { sql.exec('ROLLBACK'); throw e; }
}

// ─── Pacientes ────────────────────────────────────────────────────────────────
const stmt = {
    patientGet: sql.prepare('SELECT * FROM patients WHERE phone = ?'),
    patientInsert: sql.prepare('INSERT OR IGNORE INTO patients (phone, name, created_at, updated_at) VALUES (?, ?, ?, ?)'),
    patientFillName: sql.prepare("UPDATE patients SET name = ?, updated_at = ? WHERE phone = ? AND (name IS NULL OR name = '')"),
};

function ensurePatient(phone, name) {
    const key = phoneKey(phone);
    if (!key) return null;
    const t = now();
    stmt.patientInsert.run(key, name || null, t, t);
    if (name) stmt.patientFillName.run(name, t, key);
    return key;
}

function getPatient(phone) {
    return stmt.patientGet.get(phoneKey(phone)) || null;
}

const PATIENT_FIELDS = ['name', 'cpf', 'birth_date', 'sus_card', 'address', 'notes'];
function updatePatient(phone, fields) {
    const key = ensurePatient(phone);
    const sets = [], vals = [];
    for (const f of PATIENT_FIELDS) {
        if (fields[f] !== undefined) { sets.push(`${f} = ?`); vals.push(fields[f] === '' ? null : String(fields[f])); }
    }
    if (sets.length) {
        sets.push('updated_at = ?'); vals.push(now(), key);
        sql.prepare(`UPDATE patients SET ${sets.join(', ')} WHERE phone = ?`).run(...vals);
    }
    return getPatient(key);
}

function searchPatients(q, limit = 50) {
    const term = `%${(q || '').trim()}%`;
    const digits = phoneKey(q);
    return sql.prepare(`
        SELECT p.*,
            (SELECT COUNT(*) FROM attendances a WHERE a.phone = p.phone) AS attendance_count,
            (SELECT MAX(a.created_at) FROM attendances a WHERE a.phone = p.phone) AS last_contact,
            (SELECT ROUND(AVG(a.rating), 1) FROM attendances a WHERE a.phone = p.phone AND a.rating IS NOT NULL) AS avg_rating
        FROM patients p
        WHERE ? = '%%' OR p.name LIKE ? OR p.cpf LIKE ? OR p.sus_card LIKE ? ${digits ? 'OR p.phone LIKE ?' : ''}
        ORDER BY last_contact DESC NULLS LAST
        LIMIT ?`).all(term, term, term, term, ...(digits ? [`%${digits}%`] : []), limit);
}

// Ficha completa: cadastro + atendimentos + registros + resumo
function getPatientProfile(phone) {
    const key = phoneKey(phone);
    const patient = getPatient(key);
    if (!patient) return null;
    const attendances = sql.prepare('SELECT * FROM attendances WHERE phone = ? ORDER BY created_at DESC').all(key)
        .map(rowToAttendance);
    const records = sql.prepare('SELECT * FROM records WHERE phone = ? ORDER BY COALESCE(date, created_at) DESC').all(key);
    const rated = attendances.filter(a => a.rating);
    return {
        patient,
        attendances,
        records,
        summary: {
            totalAttendances: attendances.length,
            completed: attendances.filter(a => a.status === 'completed').length,
            openRecords: records.filter(r => !['concluido', 'cancelado'].includes(r.status)).length,
            avgRating: rated.length ? +(rated.reduce((s, a) => s + a.rating, 0) / rated.length).toFixed(1) : null,
            lastContact: attendances[0] ? (attendances[0].timestamp || attendances[0].startedAt || attendances[0].completedAt || null) : null
        }
    };
}

// ─── Registros (exames, pedidos, passagens…) ─────────────────────────────────
const RECORD_TYPES = ['exame', 'pedido', 'passagem', 'cirurgia', 'consulta', 'outro'];
function addRecord(phone, { type, title, status, date, notes, attendanceId }, createdBy) {
    const key = ensurePatient(phone);
    const t = now();
    const r = sql.prepare(`INSERT INTO records (phone, type, title, status, date, notes, attendance_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, type, title, status || 'solicitado', date || null, notes || null, attendanceId || null, createdBy || null, t, t);
    return sql.prepare('SELECT * FROM records WHERE id = ?').get(r.lastInsertRowid);
}

function updateRecord(id, fields) {
    const allowed = ['type', 'title', 'status', 'date', 'notes'];
    const sets = [], vals = [];
    for (const f of allowed) if (fields[f] !== undefined) { sets.push(`${f} = ?`); vals.push(fields[f]); }
    if (!sets.length) return sql.prepare('SELECT * FROM records WHERE id = ?').get(id) || null;
    sets.push('updated_at = ?'); vals.push(now(), id);
    sql.prepare(`UPDATE records SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return sql.prepare('SELECT * FROM records WHERE id = ?').get(id) || null;
}

function deleteRecord(id) {
    return sql.prepare('DELETE FROM records WHERE id = ?').run(id).changes > 0;
}

// ─── Atendimentos (compatível com os arrays antigos) ─────────────────────────
const STATUS = { pending: 'pending', active: 'active', completed: 'completed' };

function rowToAttendance(row) {
    const data = JSON.parse(row.data);
    return { ...data, id: row.id, status: row.status, rating: row.rating ?? data.rating ?? null, ratedAt: row.rated_at };
}

function loadByStatus(status) {
    return sql.prepare('SELECT * FROM attendances WHERE status = ? ORDER BY created_at').all(status).map(rowToAttendance);
}

const upsertAtt = sql.prepare(`
    INSERT INTO attendances (id, phone, status, service, attendant, created_at, started_at, completed_at, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, service = excluded.service, attendant = excluded.attendant,
        started_at = excluded.started_at, completed_at = excluded.completed_at, data = excluded.data`);

// Grava o array inteiro de um status: insere/atualiza os itens e remove do status
// os que saíram do array (ex.: pendente que virou ativo).
function saveByStatus(status, arr) {
    tx(() => {
        const ids = [];
        for (const item of arr) {
            if (!item.id) item.id = newId();
            const phone = ensurePatient(item.phone, item.name);
            const { status: _s, rating: _r, ratedAt: _ra, ...data } = item;
            upsertAtt.run(item.id, phone, status, item.service || null, item.attendant || null,
                item.timestamp || item.createdAt || now(), item.startedAt || null, item.completedAt || null,
                JSON.stringify(data));
            ids.push(item.id);
        }
        const placeholders = ids.map(() => '?').join(',');
        sql.prepare(`DELETE FROM attendances WHERE status = ? ${ids.length ? `AND id NOT IN (${placeholders})` : ''}`)
            .run(status, ...ids);
    });
}

function setRating(attendanceId, rating) {
    return sql.prepare('UPDATE attendances SET rating = ?, rated_at = ? WHERE id = ?').run(rating, now(), attendanceId).changes > 0;
}

function ratingStats() {
    return sql.prepare(`SELECT COUNT(rating) AS total, ROUND(AVG(rating), 2) AS average,
        SUM(rating = 5) AS r5, SUM(rating = 4) AS r4, SUM(rating = 3) AS r3, SUM(rating = 2) AS r2, SUM(rating = 1) AS r1
        FROM attendances WHERE rating IS NOT NULL`).get();
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function loadChat(phone) {
    return sql.prepare('SELECT phone, from_role AS "from", sender, text, timestamp FROM chat_messages WHERE phone = ? ORDER BY id')
        .all(phoneKey(phone));
}

function addChatMessage(msg) {
    const key = phoneKey(msg.phone);
    sql.prepare('INSERT INTO chat_messages (phone, from_role, sender, text, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(key, msg.from, msg.sender || null, msg.text, msg.timestamp || now());
}

// ─── Usuários ─────────────────────────────────────────────────────────────────
function loadUsers() {
    return sql.prepare('SELECT * FROM users ORDER BY created_at').all().map(u => ({
        id: u.id, name: u.name, username: u.username, password: u.password,
        role: u.role, active: !!u.active, createdAt: u.created_at
    }));
}

function saveUsers(arr) {
    tx(() => {
        const up = sql.prepare(`INSERT INTO users (id, name, username, password, role, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username,
                password = excluded.password, role = excluded.role, active = excluded.active`);
        for (const u of arr) up.run(u.id, u.name, u.username, u.password, u.role, u.active ? 1 : 0, u.createdAt || now());
    });
}

// ─── Tokens (clientes APK/EXE) ───────────────────────────────────────────────
const tokens = {
    save: (token, user, expires) => sql.prepare('INSERT OR REPLACE INTO tokens (token, user, expires) VALUES (?, ?, ?)')
        .run(token, JSON.stringify(user), expires),
    get: (token) => {
        const row = sql.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
        if (!row) return null;
        if (row.expires < Date.now()) { tokens.remove(token); return null; }
        return JSON.parse(row.user);
    },
    remove: (token) => sql.prepare('DELETE FROM tokens WHERE token = ?').run(token),
    removeForUser: (userId) => sql.prepare("DELETE FROM tokens WHERE json_extract(user, '$.id') = ?").run(userId),
    purgeExpired: () => sql.prepare('DELETE FROM tokens WHERE expires < ?').run(Date.now())
};
tokens.purgeExpired();

// ─── Configurações ────────────────────────────────────────────────────────────
function getSetting(key, fallback = null) {
    const row = sql.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
    sql.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

// ─── Migração dos arquivos JSON antigos (executa uma única vez) ──────────────
function migrateFromJson() {
    if (getSetting('migrated_json')) return;
    const read = (f) => {
        try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; }
    };
    const users = read('users.json');
    if (users && users.length) saveUsers(users);
    const map = { 'appointments.json': 'pending', 'active.json': 'active', 'completed.json': 'completed' };
    // concluídos primeiro: se um telefone aparecer em mais de um, o status mais recente prevalece
    for (const f of ['completed.json', 'active.json', 'appointments.json']) {
        const arr = read(f);
        if (arr && arr.length) saveByStatus(map[f], [...loadByStatus(map[f]), ...arr]);
    }
    for (const f of fs.readdirSync(DATA_DIR).filter(f => /^chat_\d+\.json$/.test(f))) {
        for (const m of read(f) || []) addChatMessage(m);
    }
    for (const f of fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'))) {
        fs.renameSync(path.join(DATA_DIR, f), path.join(DATA_DIR, f + '.migrado'));
    }
    setSetting('migrated_json', now());
}
migrateFromJson();

module.exports = {
    sql, phoneKey,
    // compat
    loadAppointments: () => loadByStatus(STATUS.pending),
    saveAppointments: (arr) => saveByStatus(STATUS.pending, arr),
    loadActive: () => loadByStatus(STATUS.active),
    saveActive: (arr) => saveByStatus(STATUS.active, arr),
    loadCompleted: () => loadByStatus(STATUS.completed),
    saveCompleted: (arr) => saveByStatus(STATUS.completed, arr),
    loadUsers, saveUsers,
    loadChat, addChatMessage,
    countRecurrences: (phone) => sql.prepare("SELECT COUNT(*) AS n FROM attendances WHERE phone = ? AND status = 'completed'")
        .get(phoneKey(phone)).n,
    // pacientes
    ensurePatient, getPatient, updatePatient, searchPatients, getPatientProfile,
    RECORD_TYPES, addRecord, updateRecord, deleteRecord,
    setRating, ratingStats,
    tokens, getSetting, setSetting
};
