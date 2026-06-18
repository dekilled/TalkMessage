const bcrypt = require('bcryptjs');
const db = require('./db');

async function initDefaultAdmin() {
    const users = db.loadUsers();
    if (users.length === 0) {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        const admin = {
            id: Date.now().toString(),
            name: 'Administrador',
            username: 'admin',
            password: hashedPassword,
            role: 'admin',
            active: true,
            createdAt: new Date().toISOString()
        };
        db.saveUsers([admin]);
        console.log('Usuário admin padrão criado. Login: admin / Senha: admin123');
        console.log('Troque a senha após o primeiro acesso!');
    }
}

function authMiddleware(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    res.status(401).json({ success: false, message: 'Não autorizado. Faça login.' });
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ success: false, message: 'Não autorizado.' });
        }
        if (!roles.includes(req.session.user.role)) {
            return res.status(403).json({ success: false, message: 'Permissão insuficiente.' });
        }
        next();
    };
}

module.exports = { initDefaultAdmin, authMiddleware, requireRole };
