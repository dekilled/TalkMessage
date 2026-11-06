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
const access = require('./access');

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

// Bloqueio por rede vem antes de tudo (inclusive dos arquivos do painel)
app.use(access.networkMiddleware);
app.use(auth.corsMiddleware);
app.use(auth.tokenMiddleware);
app.use(sessionMiddleware);
// Dispositivo + horário de expediente para usuários logados
app.use(access.requestMiddleware);

const io = require('socket.io')(server, {
    cors: {
        // A rede já é filtrada pelo access.js; aqui só barramos sites de fora
        origin: (origin, cb) => cb(null, auth.isLanOrigin(origin) || access.ipAllowed(new URL(origin).hostname, access.getConfig())),
        credentials: true
    }
});
io.engine.use(sessionMiddleware);

const PORT = process.env.PORT || 3001;

// 3. Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 4. Variáveis globais
let autoReplyEnabled = true;
let whatsappClient = null;
let connectionState = 'disconnected';
let disableAutoReply = [];
let appointments = db.loadAppointments();
let activeAppointments = db.loadActive();
let completedAppointments = db.loadCompleted();
// Pacientes que receberam o pedido de avaliação: phoneKey -> id do atendimento
const pendingRatings = new Map();

const toWid = (phone) => `${db.phoneKey(phone)}@c.us`;

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

        // Se está em atendimento via chat da ferramenta, roteia a mensagem para o chat
        const fromKey = db.phoneKey(from);
        const activeChatAppt = activeAppointments.find(a => db.phoneKey(a.phone) === fromKey && a.channel === 'chat');
        if (activeChatAppt) {
            const chatMsg = {
                phone: fromKey,
                from: 'patient',
                sender: message.pushname || from,
                text: message.body,
                timestamp: new Date().toISOString()
            };
            db.addChatMessage(chatMsg);
            io.emit('chat_message', chatMsg);
            return;
        }

        // Resposta à pesquisa de satisfação (nota de 1 a 5)
        if (pendingRatings.has(fromKey)) {
            const attendanceId = pendingRatings.get(fromKey);
            const answer = message.body.trim();
            if (/^[1-5]$/.test(answer)) {
                pendingRatings.delete(fromKey);
                const rating = Number(answer);
                db.setRating(attendanceId, rating);
                const appt = completedAppointments.find(a => a.id === attendanceId);
                if (appt) appt.rating = rating;
                io.emit('rating_received', { id: attendanceId, phone: fromKey, rating });
                await client.sendText(from, rating >= 4
                    ? 'Muito obrigada pela avaliação! 💙 Ficamos felizes em ajudar.'
                    : 'Obrigada pela avaliação! Vamos usar sua opinião para melhorar nosso atendimento.');
                return;
            }
            pendingRatings.delete(fromKey); // respondeu outra coisa: segue o fluxo normal
        }

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
                    const known = db.getPatient(from);
                    if (known && known.name) currentUserState.data.knownName = known.name;
                    const welcomeMessage = known && known.name
                        ? `Olá, ${known.name.split(' ')[0]}! Que bom ter você de volta. Como posso ajudar?`
                        : welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
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

                    if (currentUserState.data.knownName) {
                        currentUserState.data.name = currentUserState.data.knownName;
                        currentUserState.data.date = currentUserState.data.contactDate;
                        currentUserState.data.time = currentUserState.data.contactTime;
                        await client.startTyping(from);
                        await delayRandom();
                        await client.sendText(from, descriptionSolicitationMessages[Math.floor(Math.random() * descriptionSolicitationMessages.length)]);
                        await client.stopTyping(from);
                        currentUserState.step = 'awaiting_description';
                        break;
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
                    const hours = access.scheduleStatus();
                    await client.sendText(from, hours.open ? conclusionMessage
                        : `${conclusionMessage}\n\nNo momento estamos fora do horário de atendimento (${access.scheduleText(access.getConfig())}). Sua solicitação ficará na fila e será atendida no próximo expediente.`);
                    await client.stopTyping(from);
                    const { knownName, ...apptData } = currentUserState.data;
                    delete userStates[from];
                    saveAppointment(apptData);
                    break;
            }
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
        }
    });
}

// 6. Socket.IO — autenticação via sessão
io.use((socket, next) => {
    const ip = access.clientIp(socket.handshake);
    const netDenied = access.check({ ip, stage: 'network' });
    if (netDenied) return next(new Error(netDenied.code));
    next();
});

io.use((socket, next) => {
    const tokenUser = auth.userFromToken(socket.handshake.auth && socket.handshake.auth.token);
    if (tokenUser) {
        socket.user = tokenUser;
        return next();
    }
    const sess = socket.request.session;
    if (sess && sess.user) {
        socket.user = sess.user;
        return next();
    }
    next(new Error('Não autorizado'));
});

// Dispositivo + horário também valem para o tempo real
const socketDenied = (socket) => access.check({
    ip: access.clientIp(socket.handshake),
    deviceId: socket.handshake.auth && socket.handshake.auth.deviceId,
    userAgent: socket.handshake.headers['user-agent'],
    user: socket.user
});
io.use((socket, next) => {
    const denied = socketDenied(socket);
    if (denied) return next(new Error(denied.code));
    next();
});

// A cada minuto derruba quem perdeu o acesso (fim do expediente, aparelho bloqueado…)
function enforceAccessOnSockets() {
    for (const socket of io.of('/').sockets.values()) {
        const denied = socketDenied(socket);
        if (denied) {
            socket.emit('access_blocked', denied);
            socket.disconnect(true);
        }
    }
}
// Avisa 10 e 5 minutos antes de um período do expediente terminar
const shiftWarned = new Set();
function warnShiftEnding() {
    const cfg = access.getConfig();
    if (cfg.disabled || !cfg.enforceSchedule) return;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const { periods } = access.periodsFor(now, cfg);
    for (const p of periods) {
        const [h, m] = p.end.split(':').map(Number);
        const left = h * 60 + m - nowMin;
        const startMin = Number(p.start.slice(0, 2)) * 60 + Number(p.start.slice(3));
        if ((left === 10 || left === 5) && nowMin >= startMin) {
            const key = `${access.dateKey(now)}-${p.end}-${left}`;
            if (shiftWarned.has(key)) continue;
            shiftWarned.add(key);
            io.emit('shift_ending', { endsAt: p.end, minutesLeft: left });
        }
    }
    if (shiftWarned.size > 50) shiftWarned.clear();
}

setInterval(() => { warnShiftEnding(); enforceAccessOnSockets(); }, 60 * 1000);

// 7. Rotas — Públicas (sem autenticação)
// Usado pelos clientes (APK/EXE) para localizar o servidor na rede
app.get('/api/ping', (req, res) => {
    res.json({ app: 'talkmessage', version: require('./package.json').version });
});

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
    const sessionUser = { id: user.id, name: user.name, role: user.role, username: user.username };
    const denied = access.check({
        ip: access.clientIp(req), deviceId: access.deviceIdOf(req),
        userAgent: req.headers['user-agent'], user: sessionUser
    });
    if (denied && denied.code === 'OUT_OF_HOURS' && denied.canAdjust) {
        // Fora do horário, mas dentro da janela permitida: entra só para ajustar o horário de hoje
        req.session.user = sessionUser;
        return res.status(403).json({ success: false, ...denied, user: sessionUser, token: auth.issueToken(sessionUser) });
    }
    if (denied) return res.status(denied.status).json({ success: false, ...denied });
    req.session.user = sessionUser;
    // Token para clientes empacotados (cookies não atravessam origens)
    res.json({ success: true, user: sessionUser, token: auth.issueToken(sessionUser) });
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

// Iniciar atendimento: move de pendentes → ativos, desativa resposta automática
app.post('/start-appointment', auth.authMiddleware, async (req, res) => {
    try {
        const { phone, channel } = req.body;
        if (!phone || !channel) return res.status(400).json({ success: false, message: 'phone e channel são obrigatórios' });

        const idx = appointments.findIndex(a => a.phone === phone);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Agendamento não encontrado' });

        const appt = appointments.splice(idx, 1)[0];
        db.saveAppointments(appointments);

        const activeAppt = {
            ...appt,
            startedAt: new Date().toISOString(),
            channel,
            attendant: req.session.user.username
        };
        activeAppointments.push(activeAppt);
        db.saveActive(activeAppointments);

        const formatted = `${phone}@c.us`;
        if (!disableAutoReply.includes(phone)) disableAutoReply.push(phone);
        if (!disableAutoReply.includes(formatted)) disableAutoReply.push(formatted);

        io.emit('appointment_started', activeAppt);
        res.json({ success: true, appointment: activeAppt });
    } catch (e) {
        console.error('Erro ao iniciar atendimento:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Listar atendimentos ativos
app.get('/active-appointments', auth.authMiddleware, (req, res) => {
    res.json(activeAppointments);
});

// Histórico do chat de um paciente
app.get('/chat/:phone', auth.authMiddleware, (req, res) => {
    res.json(db.loadChat(req.params.phone));
});

// Atendente envia mensagem pelo chat da ferramenta → repassa via WhatsApp
app.post('/chat/:phone/message', auth.authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;
        const { phone } = req.params;
        if (!text) return res.status(400).json({ success: false });

        const msg = {
            phone,
            from: 'attendant',
            sender: req.session.user.name,
            text,
            timestamp: new Date().toISOString()
        };
        db.addChatMessage(msg);

        if (whatsappClient) {
            try { await whatsappClient.sendText(toWid(phone), text); } catch (e) {
                console.error('Erro ao enviar mensagem WhatsApp:', e.message);
            }
        }

        io.emit('chat_message', msg);
        res.json({ success: true, message: msg });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Finalizar atendimento: move de ativos → concluídos, reativa resposta automática
app.post('/complete-appointment', auth.authMiddleware, async (req, res) => {
    try {
        const { phone, attendantNotes, completionStatus, completionTypes } = req.body;
        const formatted = `${phone}@c.us`;

        const idx = activeAppointments.findIndex(a => a.phone === phone);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Atendimento ativo não encontrado' });

        const appt = activeAppointments.splice(idx, 1)[0];
        db.saveActive(activeAppointments);

        disableAutoReply = disableAutoReply.filter(p => p !== phone && p !== formatted);

        const recurrenceCount = db.countRecurrences(phone);

        const completedAppointment = {
            ...appt,
            attendantNotes: attendantNotes || '',
            completionStatus: completionStatus || 'finalizada',
            completionTypes: completionTypes || [],
            completedAt: new Date().toISOString(),
            completionDate: new Date().toISOString(),
            completedBy: req.session.user.name,
            recurrenceCount: recurrenceCount + 1
        };

        completedAppointments.push(completedAppointment);
        try { db.saveCompleted(completedAppointments); } catch (e) {
            console.error('Erro ao salvar concluídos:', e.message);
        }

        io.emit('appointment_completed', completedAppointment);

        // Pesquisa de satisfação via WhatsApp
        if (whatsappClient && req.body.askRating !== false) {
            pendingRatings.set(db.phoneKey(phone), completedAppointment.id);
            whatsappClient.sendText(toWid(phone),
                'Seu atendimento foi finalizado. Como você avalia nosso atendimento?\n' +
                'Responda com um número de 1 a 5:\n1 - Péssimo\n2 - Ruim\n3 - Regular\n4 - Bom\n5 - Ótimo'
            ).catch(e => console.error('Erro ao enviar pesquisa de satisfação:', e.message));
        }
        res.json({ success: true, completedAppointment });
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
        db.tokens.removeForUser(id);
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
    db.tokens.removeForUser(id);
    res.json({ success: true });
});

// 11. Rotas — Controle de acesso (rede, dispositivos e horário)
app.get('/access/status', (req, res) => {
    res.json(access.publicStatus());
});

app.get('/access/whoami', auth.authMiddleware, (req, res) => {
    res.json({ ip: access.clientIp(req), deviceId: access.deviceIdOf(req) });
});

app.get('/access', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    res.json({
        config: access.getConfig(),
        status: access.publicStatus(),
        devices: access.listDevices(),
        you: { ip: access.clientIp(req), deviceId: access.deviceIdOf(req) },
        serverIps: getLocalIPs()
    });
});

app.put('/access', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    try {
        const config = access.saveConfig(req.body || {});
        enforceAccessOnSockets();
        io.emit('access_changed', access.publicStatus());
        res.json({ success: true, config });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// Liberação temporária fora do horário: { minutes } | { endOfDay: true } | { cancel: true }
app.post('/access/override', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    const { minutes, endOfDay, cancel } = req.body || {};
    let until = null;
    if (!cancel) {
        if (endOfDay) { until = new Date(); until.setHours(23, 59, 59, 0); }
        else {
            const m = Number(minutes);
            if (!Number.isFinite(m) || m <= 0 || m > 24 * 60) return res.status(400).json({ success: false, message: 'Informe de 1 a 1440 minutos.' });
            until = new Date(Date.now() + m * 60000);
        }
    }
    access.saveConfig({ overrideUntil: until ? until.toISOString() : null });
    if (cancel) enforceAccessOnSockets();
    io.emit('access_changed', access.publicStatus());
    res.json({ success: true, status: access.publicStatus() });
});

app.put('/devices/:id', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    try {
        if (!access.updateDevice(req.params.id, req.body || {})) return res.status(404).json({ success: false, message: 'Dispositivo não encontrado.' });
        enforceAccessOnSockets();
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.delete('/devices/:id', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    if (!access.removeDevice(req.params.id)) return res.status(404).json({ success: false });
    enforceAccessOnSockets();
    res.json({ success: true });
});

// Horário do dia / dias especiais — qualquer usuário logado pode definir
// (atendentes ficam dentro do limite configurado pelo admin)
app.get('/schedule', auth.authMiddleware, (req, res) => {
    const cfg = access.getConfig();
    res.json({
        today: access.scheduleStatus(cfg).today,
        normal: cfg.schedule,
        extraPeriods: cfg.extraPeriods,
        attendantLimit: cfg.attendantLimit,
        enforceSchedule: cfg.enforceSchedule,
        specialDays: access.listSpecialDays()
    });
});

function scheduleChanged(user, day, removed = false) {
    const text = removed ? 'horário normal' : access.periodsText(day.periods);
    console.log(`[horário] ${user.username} definiu ${day.date}: ${text}${day.note ? ' — ' + day.note : ''}`);
    enforceAccessOnSockets();
    io.emit('access_changed', access.publicStatus());
    io.emit('schedule_changed', {
        by: user.name, date: day.date, text, note: removed ? '' : (day.note || ''),
        today: day.date === access.dateKey()
    });
}

// Mudança rápida no meio do expediente: { action: 'extra' | 'close_now' | 'work_until', until, note }
app.post('/schedule/today', auth.authMiddleware, (req, res) => {
    try {
        const { action, until, note } = req.body || {};
        const day = access.todayAction(action, { until, note }, req.session.user);
        scheduleChanged(req.session.user, day);
        res.json({ success: true, day, status: access.publicStatus() });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.put('/schedule/special/:date', auth.authMiddleware, (req, res) => {
    try {
        const day = access.setSpecialDay(req.params.date, req.body || {}, req.session.user);
        scheduleChanged(req.session.user, day);
        res.json({ success: true, day });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.delete('/schedule/special/:date', auth.authMiddleware, (req, res) => {
    if (req.params.date < access.dateKey()) return res.status(400).json({ success: false, message: 'Não é possível alterar dias que já passaram.' });
    if (!access.removeSpecialDay(req.params.date)) return res.status(404).json({ success: false, message: 'Não há horário especial nessa data.' });
    scheduleChanged(req.session.user, { date: req.params.date }, true);
    res.json({ success: true });
});

// 10. Rotas — Pacientes (ficha, histórico, exames e pedidos)
app.get('/patients', auth.authMiddleware, (req, res) => {
    res.json(db.searchPatients(req.query.q || ''));
});

app.get('/patients/:phone', auth.authMiddleware, (req, res) => {
    const profile = db.getPatientProfile(req.params.phone);
    if (!profile) return res.status(404).json({ success: false, message: 'Paciente não encontrado.' });
    res.json(profile);
});

app.put('/patients/:phone', auth.authMiddleware, (req, res) => {
    if (!db.phoneKey(req.params.phone)) return res.status(400).json({ success: false, message: 'Telefone inválido.' });
    const patient = db.updatePatient(req.params.phone, req.body || {});
    io.emit('patient_updated', patient);
    res.json({ success: true, patient });
});

app.post('/patients/:phone/records', auth.authMiddleware, (req, res) => {
    const { type, title } = req.body || {};
    if (!db.RECORD_TYPES.includes(type) || !title) {
        return res.status(400).json({ success: false, message: `Informe título e tipo (${db.RECORD_TYPES.join(', ')}).` });
    }
    const record = db.addRecord(req.params.phone, req.body, req.session.user.name);
    io.emit('record_updated', record);
    res.json({ success: true, record });
});

app.put('/records/:id', auth.authMiddleware, (req, res) => {
    if (req.body.type && !db.RECORD_TYPES.includes(req.body.type)) {
        return res.status(400).json({ success: false, message: 'Tipo inválido.' });
    }
    const record = db.updateRecord(Number(req.params.id), req.body || {});
    if (!record) return res.status(404).json({ success: false, message: 'Registro não encontrado.' });
    io.emit('record_updated', record);
    res.json({ success: true, record });
});

app.delete('/records/:id', auth.authMiddleware, auth.requireRole('supervisor', 'admin'), (req, res) => {
    if (!db.deleteRecord(Number(req.params.id))) return res.status(404).json({ success: false });
    res.json({ success: true });
});

app.get('/ratings/stats', auth.authMiddleware, auth.requireRole('supervisor', 'admin'), (req, res) => {
    res.json(db.ratingStats());
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
    updatesEnabled: false,
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
