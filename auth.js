// Autenticação: sessão, controle de papéis e admin padrão
const bcrypt = require('bcryptjs');
const db = require('./db');

const crypto = require('crypto');

// Tokens para clientes empacotados (APK/EXE), que não podem usar cookie de sessão
const TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 horas, igual à sessão
// Tokens ficam no SQLite: sobrevivem a reinícios do servidor

function issueToken(user) {
    const token = crypto.randomBytes(32).toString('hex');
    db.tokens.save(token, user, Date.now() + TOKEN_TTL);
    return token;
}

function revokeToken(token) { if (token) db.tokens.remove(token); }

function userFromToken(token) {
    return token ? db.tokens.get(token) : null;
}

function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Deve vir ANTES do express-session: com Bearer válido, cria uma "sessão" leve
// por requisição (o express-session ignora requisições que já têm req.session).
function tokenMiddleware(req, res, next) {
    const token = bearer(req);
    const user = userFromToken(token);
    if (user) {
        req.session = { user, token, destroy(cb) { revokeToken(token); cb && cb(); } };
    }
    next();
}

// CORS só para origens da rede local e dos apps empacotados
function isLanOrigin(origin) {
    if (!origin || origin === 'null') return true;
    try {
        const { protocol, hostname } = new URL(origin);
        if (['capacitor:', 'ionic:', 'file:', 'app:'].includes(protocol)) return true;
        return hostname === 'localhost' || hostname === '127.0.0.1' ||
            /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    } catch { return false; }
}

function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;
    // Mesma origem (página servida pelo próprio servidor) sempre passa
    let sameOrigin = false;
    try { sameOrigin = !!origin && new URL(origin).host === req.headers.host; } catch {}
    if (origin && (sameOrigin || isLanOrigin(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Vary', 'Origin');
    } else if (origin) {
        return res.status(403).json({ success: false, message: 'Origem não permitida.' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
}

const ROLE_LEVEL = { atendente: 1, supervisor: 2, admin: 3 };

function authMiddleware(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.status(401).json({ success: false, message: 'Não autenticado.' });
}

// Libera se o usuário tiver qualquer um dos papéis informados
function requireRole(...roles) {
    return (req, res, next) => {
        const user = req.session && req.session.user;
        if (!user) return res.status(401).json({ success: false, message: 'Não autenticado.' });
        if (!roles.includes(user.role)) {
            return res.status(403).json({ success: false, message: 'Acesso negado.' });
        }
        next();
    };
}

// Cria um admin inicial caso não exista nenhum admin ativo
async function initDefaultAdmin() {
    const users = db.loadUsers();
    if (users.some(u => u.role === 'admin' && u.active)) return;
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    users.push({
        id: Date.now().toString(),
        name: 'Administrador',
        username,
        password: await bcrypt.hash(password, 10),
        role: 'admin',
        active: true,
        createdAt: new Date().toISOString()
    });
    db.saveUsers(users);
    console.log(`[auth] Admin padrão criado -> usuário: ${username} / senha: ${password} (troque após o primeiro login!)`);
}

module.exports = {
    authMiddleware, requireRole, initDefaultAdmin, ROLE_LEVEL,
    issueToken, revokeToken, userFromToken, tokenMiddleware, corsMiddleware, isLanOrigin
};
