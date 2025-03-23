// 1. Imports
const express = require('express');
const path = require('path');
const http = require('http');
const wppconnect = require('@wppconnect-team/wppconnect');

// 2. Configurações iniciais
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);
const PORT = 3000;

// 3. Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 4. Variáveis globais
let disableAutoReply = [];
let appointments = []; // Array para armazenar os atendimentos

// 5. Funções
function saveAppointment(data) {
  appointments.push(data);
  io.emit('new_appointment', data);
}

function start(client) {
  let userStates = {};

  // Mapa de serviços
  const servicosMap = {
    '1': 'Passagem',
    '2': 'Exames',
    '3': 'Cirurgias'
    /*'4': 'Consultas',
    '5': 'Nosso contatos',
    '6': 'Outras informações',*/
  };

  client.onMessage(async (message) => {
    const from = message.from;
    
    if (disableAutoReply.includes(from)) {
      console.log(`Auto-respostas desativadas para: ${from}`);
      return;
    }

    if (!userStates[from]) {
      userStates[from] = {
        step: 'initial',
        data: {
          timestamp: new Date().toISOString(), // Registra o momento do primeiro contato
          contactDate: new Date().toLocaleDateString('pt-BR'),
          contactTime: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        }
      };
    }

    const userState = userStates[from];
    
    try {
      switch (userState.step) {
        case 'initial':
          if (message.body.toLowerCase() === 'menu') {
            await client.sendText(from, 'Bem-vindo! Escolha uma das opções:\n1 - Passagem\n2 - Exames\n3 - Cirurgias');
            userState.step = 'awaiting_service';
          }
          break;

        case 'awaiting_service':
          const serviceType = servicosMap[message.body];
          if (!serviceType) {
            await client.sendText(from, 'Opção inválida. Por favor, escolha 1, 2 ou 3.');
            return;
          }
          userState.data.service = serviceType;
          await client.sendText(from, 'Por favor, digite seu nome completo:');
          userState.step = 'awaiting_name';
          break;

        case 'awaiting_name':
          userState.data.name = message.body;
          await client.sendText(from, 'Descreva em poucas palavras qual o serviço desejado:');
          userState.step = 'awaiting_description';
          break;

        case 'awaiting_description':
          userState.data.description = message.body;
          userState.data.phone = from.replace('@c.us', '');
          
          // Usa a data e hora do primeiro contato
          userState.data.date = userState.data.contactDate;
          userState.data.time = userState.data.contactTime;
          
          saveAppointment(userState.data);
          
          await client.sendText(from, 'Obrigado! Seus dados foram registrados. Em breve entraremos em contato.');
          userState.step = 'initial';
          break;
      }
    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
    }
  });
}

// 6. Rotas
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/appointments', (req, res) => {
  res.json(appointments);
});

app.post('/disable-auto-reply', (req, res) => {
  const { number } = req.body;
  const formattedNumber = `${number}@c.us`;
  if (!disableAutoReply.includes(formattedNumber)) {
    disableAutoReply.push(formattedNumber);
    res.json({ success: true, message: `Auto-respostas desativadas para o número: ${number}.` });
  } else {
    res.json({ success: false, message: 'Número já está desativado.' });
  }
});

app.post('/enable-auto-reply', (req, res) => {
  const { number } = req.body;
  const formattedNumber = `${number}@c.us`;
  disableAutoReply = disableAutoReply.filter((num) => num !== formattedNumber);
  res.json({ success: true, message: `Auto-respostas reativadas para o número: ${formattedNumber}.` });
});

app.get('/disabled-numbers', (req, res) => {
  res.json(disableAutoReply);
});

// Array para armazenar os atendimentos concluídos
let completedAppointments = [];

// Rota para completar atendimento
app.post('/complete-appointment', (req, res) => {
  const { phone, name, service, resolution, completedAt } = req.body;
  const formattedNumber = `${phone}@c.us`;
  
  try {
    // Remove do array de números desabilitados
    disableAutoReply = disableAutoReply.filter(num => num !== formattedNumber);
    
    // Cria o objeto de atendimento concluído
    const completedAppointment = {
      phone,
      name,
      service,
      resolution,
      completedAt,
      completionDate: new Date().toISOString()
    };
    
    // Adiciona aos atendimentos concluídos
    completedAppointments.push(completedAppointment);
    
    // Emite evento para atualizar o frontend
    io.emit('appointment_completed', completedAppointment);
    
    res.json({ 
      success: true, 
      message: 'Atendimento concluído com sucesso.',
      completedAppointment 
    });
  } catch (error) {
    console.error('Erro ao completar atendimento:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao completar atendimento' 
    });
  }
});

// Rota para obter atendimentos concluídos
app.get('/completed-appointments', (req, res) => {
  res.json(completedAppointments);
});

// 7. Inicialização
wppconnect.create().then((client) => start(client));

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});