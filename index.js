// 1. Imports
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const http = require('http');
const wppconnect = require('@wppconnect-team/wppconnect');

// 2. Configurações iniciais
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);
const PORT = 3000;

let autoReplyEnabled = true;
// Texto para gerar o QR code
const text = 'https://localhost:5501/public/index.html';
const QRCode = require('qrcode');

// 3. Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 4. Variáveis globais
let disableAutoReply = [];
let appointments = []; // Array para armazenar os atendimentos

// Array de mensagens de boas-vindas
const welcomeMessages = [
    'Olá! Como posso ajudar você hoje?',
    'Bem-vindo! O que você precisa?',
    'Oi! Estou aqui para ajudar. Qual é a sua dúvida?',
    'Saudações! Como posso assisti-lo?',
    'Olá! Estou à disposição para ajudar. O que você gostaria de saber?'
];

// ARRAYS DE MENSAGENS DINAMICAS
// Array de mensagens para o menu
const menuMessages = [
    'Escolha uma das opções:\n1 - Passagem\n2 - Exames\n3 - Cirurgias',
    'Aqui estão suas opções:\n1 - Passagem\n2 - Exames\n3 - Cirurgias',
    'Você pode escolher entre:\n1 - Passagem\n2 - Exames\n3 - Cirurgias',
    'Por favor, selecione uma opção:\n1 - Passagem\n2 - Exames\n3 - Cirurgias',
    'Quais serviços você gostaria de acessar?\n1 - Passagem\n2 - Exames\n3 - Cirurgias'
];

// Array de mensagens para opções inválidas
const invalidOptionMessages = [
    'Opção inválida. Por favor, escolha 1, 2 ou 3.',
    'Desculpe, essa opção não está disponível. Tente novamente com 1, 2 ou 3.',
    'Essa opção não é válida. Por favor, escolha uma das opções disponíveis.',
    'Parece que você escolheu uma opção errada. Tente 1, 2 ou 3.'
];

// Array de mensagens para solicitar o nome
const nameSolicitationMessages = [
    'Por favor, digite seu nome completo:',
    'Qual é o seu nome?',
    'Para continuar, poderia me informar seu nome?',
    'Antes de prosseguir, por favor, me diga seu nome.'
];

// Array de mensagens para solicitar a descrição
const descriptionSolicitationMessages = [
    'Por favor, descreva em poucas palavras o que deseja:',
    'Pode me dar uma breve descrição do serviço que você está procurando?',
    'Legal! O que você gostaria de solicitar? Descreva em poucas palavras.',
    'Para continuar, me diga em poucas palavras qual serviço você deseja.'
];

// Array de mensagens de conclusão
const conclusionMessages = [
    'Você foi colocado na fila de espera. Em breve, uma atendente entrará em contato.',
    'Agradecemos pela sua paciência! Estamos cuidando do seu atendimento e logo entraremos em contato.',
    'Obrigado por esperar! Estamos processando sua solicitação e entraremos em contato em breve.',
    'Sua solicitação foi recebida. Um atendente entrará em contato com você em breve.'
];

// 5. Funções
function saveAppointment(data) {
  appointments.push(data);
  io.emit('new_appointment', data);
}

// Funções de Navegação
generateQRCode = async (text) => {
  try {
      const url = await QRCode.toDataURL(text);
      console.log(url);
  } catch (err) {
      console.error(err);
  }
};
// Função para gerar um atraso aleatório
function delayRandom() {
    return new Promise(resolve => {
        const delay = Math.floor(Math.random() * (20000 - 5000 + 1)) + 5000; // Delay entre 5 e 20 segundos
        setTimeout(resolve, delay);
    });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function start(client) {
  let userStates = {};

  // Mapa de serviços
  const servicosMap = {
    '1': 'Passagem',
    '2': 'Exames',
    '3': 'Cirurgias',
    '4': 'Consultas',
    '5': 'Nosso contatos',
    '6': 'Outras informações',
  };
  

  const generateQRCode = async (text) => {
    try {
      const url = await QRCode.toDataURL(text);
      console.log(url);
    } catch (err) {
      console.error(err);
    }
  };
  
  // Texto para gerar o QR code
  const text = 'https://www.example.com';
  generateQRCode(text);
  client.onMessage(async (message) => {
    const from = message.from;
    
    // Emitir evento de typing para a interface web
    io.emit('typing', { from }); // Notifica que o usuário está digitando

    //console.log(`On Message: ${message.body}`)
    // Verifica se a mensagem é um comando
    
    console.log(`disabled Includes: ${disableAutoReply.includes(from)}`);
    console.log(`number: ${from}`);
    console.log(`boolean: ${autoReplyEnabled}`);

    if (disableAutoReply.includes(from) && autoReplyEnabled) {
      console.log(`Auto-respostas desativadas para: ${from}`);
      return;
    }else{
      const userState = userStates[from];
      console.log('processando mensagem');
      // Verifica se a mensagem não está vazia e contém pelo menos uma letra
      if (!userState && message.body.trim() !== "" && /[a-zA-Z]/.test(message.body)) {
          userStates[from] = {
              step: 'initial',
              data: {
                  firstMessage: message.body, // Armazena a primeira mensagem
                  timestamp: new Date().toISOString(),
                  contactDate: new Date().toLocaleDateString('pt-BR'),
                  contactTime: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
              }
          };
          console.log(`Estado inicializado para ${from} com a mensagem: ${message.body}`);
      }

      // Atribui o estado do usuário
      const currentUserState = userStates[from];

      try {
          switch (currentUserState.step) {
              case 'initial':
                  console.log(`Step: ${currentUserState.step}`);
                  const welcomeMessage = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
                  await client.startTyping(from); // Indica que o bot está digitando
                  await delayRandom(); // Atraso antes de enviar a mensagem
                  await client.sendText(from, welcomeMessage);
                  await client.stopTyping(from); // Para o sinal de digitando
                  delay(2000);
                  //await client.startTyping(from); // Indica que o bot está digitando
                  await client.setChatState(from, 0);// Indica que o bot está digitando
                  await delayRandom(); // Atraso antes de enviar o menu
                  const menuMessage = menuMessages[Math.floor(Math.random() * menuMessages.length)];
                  await client.sendText(from, menuMessage);
                  await client.stopTyping(from); // Para o sinal de digitando
                  currentUserState.step = 'awaiting_service';
                  break;

              case 'awaiting_service':
                  console.log(`Step: ${currentUserState.step}`);
                  const serviceOption = message.body;
                  const validServices = ['1', '2', '3']; // Opções válidas

                  if (!validServices.includes(serviceOption)) {
                      //await client.startTyping(from);// Indica que o bot está digitando
                      await client.setChatState(from, 0);// Indica que o bot está digitando
                      await delayRandom(); // Atraso antes de enviar a mensagem
                      const invalidMessage = invalidOptionMessages[Math.floor(Math.random() * invalidOptionMessages.length)];
                      await client.stopTyping(from);// Indica que o bot parou de digitar
                      await client.sendText(from, invalidMessage);
                      return; // Mantém o usuário no mesmo estado
                  }

                  currentUserState.data.service = servicosMap[serviceOption];
                  await client.setChatState(from, 0);// Indica que o bot está digitando
                  await delayRandom(); // Atraso antes de enviar a mensagem
                  await client.sendText(from, `Você escolheu ${currentUserState.data.service}. O que você gostaria de fazer?\n1 - Solicitar ${currentUserState.data.service}\n2 - Cancelar ${currentUserState.data.service}`);
                  await client.stopTyping(from);// Indica que o bot está digitando
                  currentUserState.step = 'awaiting_submenu';
                  break;

              case 'awaiting_submenu':
                console.log(`Step: ${currentUserState.step}`);
                  const submenuOption = message.body;
                  const validSubmenuOptions = ['1', '2']; // Opções válidas do submenu

                  if (!validSubmenuOptions.includes(submenuOption)) {
                    //await client.startTyping(from);// Indica que o bot está digitando
                    await client.setChatState(from, 0);// Indica que o bot está digitando
                    await delayRandom(); // Atraso antes de enviar a mensagem
                    const invalidMessage = invalidOptionMessages[Math.floor(Math.random() * invalidOptionMessages.length)];
                    await client.sendText(from, invalidMessage);
                    await client.stopTyping(from);// Indica que o bot está digitando
                    return; // Mantém o usuário no mesmo estado
                  }

                  if (submenuOption === '1') {
                    await client.startTyping(from);// Indica que o bot está digitando
                    await delayRandom(); // Atraso antes de enviar a mensagem
                    const nameMessage = nameSolicitationMessages[Math.floor(Math.random() * nameSolicitationMessages.length)];
                    await client.sendText(from, nameMessage);
                    await client.stopTyping(from);// Indica que o bot está digitando
                    currentUserState.step = 'awaiting_name'; // Muda para awaiting_name
                  } else if (submenuOption === '2') {
                    await client.startTyping(from);// Indica que o bot está digitando
                    await delayRandom(); // Atraso antes de enviar a mensagem
                    const nameMessage = nameSolicitationMessages[Math.floor(Math.random() * nameSolicitationMessages.length)];
                    await client.sendText(from, nameMessage);
                    await client.stopTyping(from);// Indica que o bot está digitando
                    currentUserState.step = 'awaiting_name'; // Muda para awaiting_name
                  }
                  break;

              case 'awaiting_name':
                console.log(`Step: ${currentUserState.step}`);
                currentUserState.data.name = message.body; // Captura o nome
                await client.startTyping(from);// Indica que o bot está digitando
                await delayRandom(); // Atraso antes de enviar a mensagem
                const descriptionMessage = descriptionSolicitationMessages[Math.floor(Math.random() * descriptionSolicitationMessages.length)];
                await client.sendText(from, descriptionMessage);
                await client.stopTyping(from);// Indica que o bot está digitando
                currentUserState.data.date = currentUserState.data.contactDate; // Configura a data
                currentUserState.data.time = currentUserState.data.contactTime; // Configura a hora
                currentUserState.step = 'awaiting_description'; // Muda para awaiting_description
                break;

              case 'awaiting_description':
                console.log(`Step: ${currentUserState.step}`);
                currentUserState.data.description = message.body; // Captura a descrição
                await client.startTyping(from);// Indica que o bot está digitando
                await delayRandom(); // Atraso antes de enviar a mensagem
                const conclusionMessage = conclusionMessages[Math.floor(Math.random() * conclusionMessages.length)];
                await client.sendText(from, conclusionMessage);
                await client.stopTyping(from);// Indica que o bot está digitando
                currentUserState.step = 'initial'; // Retorna ao estado inicial

                console.log(`Step: ${currentUserState.step}`);
                // Emitir evento para atualizar a interface web
                io.emit('new_message', currentUserState.data); // Envia os dados do atendimento para a interface
                break;
          }
      } catch (error) {
          console.error('Erro ao processar mensagem:', error);
      }
    }
  });
}

//const userState = userStates[from];
// Função para processar a mensagem
async function processMessage(message, client, from, userStates) {
    
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