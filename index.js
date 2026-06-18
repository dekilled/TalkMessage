// 1. Imports
const express = require('express');
const path = require('path');
const http = require('http');
const os = require('os');
const wppconnect = require('@wppconnect-team/wppconnect');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const auth = require('./auth');

// 2. Configurações iniciais
const app = express();
const server = http.createServer(app);

// Session middleware compartilhado entre Express e Socket.IO
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'talkmessage-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } // 8 horas
});

app.use(sessionMiddleware);

const io = require('socket.io')(server);
io.engine.use(sessionMiddleware);

const PORT = process.env.PORT || 3000;

// 3. Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 4. Variáveis globais
let autoReplyEnabled = true;
let whatsappClient = null;
let connectionState = 'disconnected';
let disableAutoReply = [];
let appointments = db.loadAppointments();
let completedAppointments = db.loadCompleted();

// Arrays de mensagens de boas-vindas
const welcomeMessages = [
    'Olá! Como posso ajudar você hoje?',
    'Bem-vindo! O que você precisa?',
    'Oi! Estou aqui para ajudar. Qual é a sua dúvida?',
    'Saudações! Como posso assisti-lo?',
    'Olá! Estou à disposição para ajudar. O que você gostaria de saber?'
];

const menuMessages = [
    'Escolha uma das opções:\n1 - Passagem\n2 - Exames\n3 - Cirurgias',
    'Aqui estão suas opções:\n1 - Passagem\n2 - Exames\n3 - Cirurgias',
    'Você pode escolher entre:\n1 - Passagem\n2 - Exames\n3 - Cirurgias',
    'Por favor, selecione uma opção:\n1 - Passagem\n2 - Exames\n3 - Cirurgias',
    'Quais serviços você gostaria de acessar?\n1 - Passagem\n2 - Exames\n3 - Cirurgias'
];

const invalidOptionMessages = [
    'Opção inválida. Por favor, escolha 1, 2 ou 3.',
    'Desculpe, essa opção não está disponível. Tente novamente com 1, 2 ou 3.',
    'Essa opção não é válida. Por favor, escolha uma das opções disponíveis.',
    'Parece que você escolheu uma opção errada. Tente 1, 2 ou 3.'
];

const nameSolicitationMessages = [
    'Por favor, digite seu nome completo:',
    'Qual é o seu nome?',
    'Para continuar, poderia me informar seu nome?',
    'Antes de prosseguir, por favor, me diga seu nome.'
];

const descriptionSolicitationMessages = [
    'Por favor, descreva em poucas palavras o que deseja:',
    'Pode me dar uma breve descrição do serviço que você está procurando?',
    'Legal! O que você gostaria de solicitar? Descreva em poucas palavras.',
    'Para continuar, me diga em poucas palavras qual serviço você deseja.'
];

const conclusionMessages = [
    'Você foi colocado na fila de espera. Em breve, uma atendente entrará em contato.',
    'Agradecemos pela sua paciência! Estamos cuidando do seu atendimento e logo entraremos em contato.',
    'Obrigado por esperar! Estamos processando sua solicitação e entraremos em contato em breve.',
    'Sua solicitação foi recebida. Um atendente entrará em contato com você em breve.'
];

// 5. Funções
function saveAppointment(data) {
    appointments.push(data);
    try {
        db.saveAppointments(appointments);
    } catch (e) {
        console.error('Erro ao salvar agendamento em disco:', e.message);
    }
    io.emit('new_appointment', data);
}

function delayRandom() {
    return new Promise(resolve => {
        const ms = Math.floor(Math.random() * (20000 - 5000 + 1)) + 5000;
        setTimeout(resolve, ms);
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

function start(client) {
    let userStates = {};

    const servicosMap = {
        '1': 'Passagem',
        '2': 'Exames',
        '3': 'Cirurgias',
        '4': 'Consultas',
        '5': 'Nossos contatos',
        '6': 'Outras informações',
    };

    client.onMessage(async (message) => {
        const from = message.from;

        io.emit('typing', { from });

        if (disableAutoReply.includes(from) && autoReplyEnabled) {
            console.log(`Auto-respostas desativadas para: ${from}`);
            return;
        }

        const userState = userStates[from];

        if (!userState && message.body.trim() !== '' && /[a-zA-Z]/.test(message.body)) {
            userStates[from] = {
                step: 'initial',
                data: {
                    firstMessage: message.body,
                    timestamp: new Date().toISOString(),
                    contactDate: new Date().toLocaleDateString('pt-BR'),
                    contactTime: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                }
            };
        }

        const currentUserState = userStates[from];
        if (!currentUserState) return;

        try {
            switch (currentUserState.step) {
                case 'initial':
                    const welcomeMessage = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
                    await client.startTyping(from);
                    await delayRandom();
                    await client.sendText(from, welcomeMessage);
                    await client.stopTyping(from);
                    delay(2000);
                    await client.setChatState(from, 0);
                    await delayRandom();
                    const menuMessage = menuMessages[Math.floor(Math.random() * menuMessages.length)];
                    await client.sendText(from, menuMessage);
                    await client.stopTyping(from);
                    currentUserState.step = 'awaiting_service';
                    break;

                case 'awaiting_service':
                    const serviceOption = message.body;
                    const validServices = ['1', '2', '3'];

                    if (!validServices.includes(serviceOption)) {
                        await client.setChatState(from, 0);
                        await delayRandom();
                        const invalidMessage = invalidOptionMessages[Math.floor(Math.random() * invalidOptionMessages.length)];
                        await client.stopTyping(from);
                        await client.sendText(from, invalidMessage);
                        return;
                    }

                    currentUserState.data.service = servicosMap[serviceOption];
                    await client.setChatState(from, 0);
                    await delayRandom();
                    await client.sendText(from, `Você escolheu ${currentUserState.data.service}. O que você gostaria de fazer?\n1 - Solicitar ${currentUserState.data.service}\n2 - Cancelar ${currentUserState.data.service}`);
                    await client.stopTyping(from);
                    currentUserState.step = 'awaiting_submenu';
                    break;

                case 'awaiting_submenu':
                    const submenuOption = message.body;
                    const validSubmenuOptions = ['1', '2'];

                    if (!validSubmenuOptions.includes(submenuOption)) {
                        await client.setChatState(from, 0);
                        await delayRandom();
                        const invalidMessage = invalidOptionMessages[Math.floor(Math.random() * invalidOptionMessages.length)];
                        await client.sendText(from, invalidMessage);
                        await client.stopTyping(from);
                        return;
                    }

                    await client.startTyping(from);
                    await delayRandom();
                    const nameMessage = nameSolicitationMessages[Math.floor(Math.random() * nameSolicitationMessages.length)];
                    await client.sendText(from, nameMessage);
                    await client.stopTyping(from);
                    currentUserState.step = 'awaiting_name';
                    break;

                case 'awaiting_name':
                    currentUserState.data.name = message.body;
                    await client.startTyping(from);
                    await delayRandom();
                    const descriptionMessage = descriptionSolicitationMessages[Math.floor(Math.random() * descriptionSolicitationMessages.length)];
                    await client.sendText(from, descriptionMessage);
                    await client.stopTyping(from);
                    currentUserState.data.date = currentUserState.data.contactDate;
                    currentUserState.data.time = currentUserState.data.contactTime;
                    currentUserState.step = 'awaiting_description';
                    break;

                case 'awaiting_description':
                    currentUserState.data.description = message.body;
                    currentUserState.data.phone = from.replace('@c.us', '');
                    await client.startTyping(from);
                    await delayRandom();
                    const conclusionMessage = conclusionMessages[Math.floor(Math.random() * conclusionMessages.length)];
                    await client.sendText(from, conclusionMessage);
                    await client.stopTyping(from);
                    currentUserState.step = 'initial';
                    saveAppointment({ ...currentUserState.data });
                    break;
            }
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
        }
    });
}

// 6. Socket.IO — autenticação via sessão
io.use((socket, next) => {
    const sess = socket.request.session;
    if (sess && sess.user) {
        socket.user = sess.user;
        return next();
    }
    next(new Error('Não autorizado'));
});

// 7. Rotas — Públicas (sem autenticação)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Usuário e senha são obrigatórios.' });
    }
    const users = db.loadUsers();
    const user = users.find(u => u.username === username && u.active);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ success: false, message: 'Usuário ou senha incorretos.' });
    }
    req.session.user = { id: user.id, name: user.name, role: user.role, username: user.username };
    res.json({ success: true, user: req.session.user });
});

app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/auth/me', auth.authMiddleware, (req, res) => {
    res.json(req.session.user);
});

// 8. Rotas — API Protegidas
app.get('/appointments', auth.authMiddleware, (req, res) => {
    res.json(appointments);
});

app.get('/completed-appointments', auth.authMiddleware, (req, res) => {
    res.json(completedAppointments);
});

app.get('/disabled-numbers', auth.authMiddleware, (req, res) => {
    res.json(disableAutoReply);
});

app.get('/connection-status', auth.authMiddleware, (req, res) => {
    res.json({ status: connectionState });
});

app.get('/appointments/stats', auth.authMiddleware, auth.requireRole('supervisor', 'admin'), (req, res) => {
    const stats = {};
    completedAppointments.forEach(a => {
        const date = a.completionDate ? a.completionDate.slice(0, 10) : 'desconhecido';
        stats[date] = (stats[date] || 0) + 1;
    });
    const result = Object.entries(stats)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }));
    res.json(result);
});

app.post('/disable-auto-reply', auth.authMiddleware, (req, res) => {
    const { number } = req.body;
    const formattedNumber = `${number}@c.us`;
    if (!disableAutoReply.includes(formattedNumber)) {
        disableAutoReply.push(formattedNumber);
        res.json({ success: true, message: `Auto-respostas desativadas para o número: ${number}.` });
    } else {
        res.json({ success: false, message: 'Número já está desativado.' });
    }
});

app.post('/enable-auto-reply', auth.authMiddleware, (req, res) => {
    const { number } = req.body;
    const formattedNumber = `${number}@c.us`;
    disableAutoReply = disableAutoReply.filter(num => num !== formattedNumber);
    res.json({ success: true, message: `Auto-respostas reativadas para o número: ${formattedNumber}.` });
});

app.post('/complete-appointment', auth.authMiddleware, (req, res) => {
    const { phone, name, service, resolution, completedAt } = req.body;
    const formattedNumber = `${phone}@c.us`;

    try {
        disableAutoReply = disableAutoReply.filter(num => num !== formattedNumber);

        const completedAppointment = {
            phone,
            name,
            service,
            resolution,
            completedAt,
            completionDate: new Date().toISOString(),
            completedBy: req.session.user.name
        };

        completedAppointments.push(completedAppointment);
        try {
            db.saveCompleted(completedAppointments);
        } catch (e) {
            console.error('Erro ao salvar concluídos em disco:', e.message);
        }
        io.emit('appointment_completed', completedAppointment);

        res.json({ success: true, message: 'Atendimento concluído com sucesso.', completedAppointment });
    } catch (error) {
        console.error('Erro ao completar atendimento:', error);
        res.status(500).json({ success: false, message: 'Erro ao completar atendimento' });
    }
});

app.post('/disconnect-whatsapp', auth.authMiddleware, auth.requireRole('admin'), async (req, res) => {
    try {
        if (whatsappClient) {
            await whatsappClient.close();
            connectionState = 'disconnected';
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Erro ao desconectar WhatsApp:', e);
        res.status(500).json({ success: false });
    }
});

// 9. Rotas — Gerenciamento de Usuários (admin only)
app.get('/users', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    const users = db.loadUsers().map(({ password, ...u }) => u);
    res.json(users);
});

app.post('/users', auth.authMiddleware, auth.requireRole('admin'), async (req, res) => {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password || !role) {
        return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios.' });
    }
    const validRoles = ['atendente', 'supervisor', 'admin'];
    if (!validRoles.includes(role)) {
        return res.status(400).json({ success: false, message: 'Role inválido.' });
    }
    const users = db.loadUsers();
    if (users.find(u => u.username === username)) {
        return res.status(409).json({ success: false, message: 'Nome de usuário já existe.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: Date.now().toString(),
        name,
        username,
        password: hashedPassword,
        role,
        active: true,
        createdAt: new Date().toISOString()
    };
    users.push(newUser);
    db.saveUsers(users);
    const { password: _, ...safeUser } = newUser;
    res.json({ success: true, user: safeUser });
});

app.put('/users/:id', auth.authMiddleware, auth.requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { name, role, password } = req.body;
    const users = db.loadUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    if (name) users[idx].name = name;
    if (role) {
        const validRoles = ['atendente', 'supervisor', 'admin'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ success: false, message: 'Role inválido.' });
        }
        users[idx].role = role;
    }
    if (password) {
        users[idx].password = await bcrypt.hash(password, 10);
    }
    db.saveUsers(users);
    const { password: _, ...safeUser } = users[idx];
    res.json({ success: true, user: safeUser });
});

app.delete('/users/:id', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    const { id } = req.params;
    if (req.session.user.id === id) {
        return res.status(400).json({ success: false, message: 'Não é possível desativar o próprio usuário.' });
    }
    const users = db.loadUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }
    users[idx].active = false;
    db.saveUsers(users);
    res.json({ success: true });
});

// Error handler global
app.use((err, req, res, next) => {
    console.error('Erro na rota:', err.message);
    res.status(500).json({ success: false, message: 'Erro interno do servidor' });
});

process.on('unhandledRejection', (reason) => {
    console.error('Rejeição não tratada:', reason);
});

// 10. Inicialização
auth.initDefaultAdmin().catch(console.error);

wppconnect.create({
    session: process.env.SESSION_NAME || 'sessionName',
    catchQR: (base64Qr) => {
        connectionState = 'qr_waiting';
        io.emit('qr_code', { qr: base64Qr });
    },
    statusFind: (status) => {
        connectionState = status;
        io.emit('connection_status', { status });
    },
    logQR: false,
}).then((client) => {
    whatsappClient = client;
    connectionState = 'connected';
    io.emit('connection_status', { status: 'isLogged' });
    start(client);
}).catch((error) => console.error('Erro ao iniciar WPPConnect:', error));

server.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIPs();
    console.log('\nServidor TalkMessage iniciado:');
    console.log(`  → http://localhost:${PORT}  (este computador)`);
    ips.forEach(ip => console.log(`  → http://${ip}:${PORT}  (rede local)`));
    console.log('');
});
