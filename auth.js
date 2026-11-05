// Autenticação: sessão, controle de papéis e admin padrão
const bcrypt = require('bcryptjs');
const db = require('./db');

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

module.exports = { authMiddleware, requireRole, initDefaultAdmin, ROLE_LEVEL };
