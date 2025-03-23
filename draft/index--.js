/*const express = require('express');
const app = express();

// Rota de teste
app.get('/', (req, res) => {
  res.send('Express está funcionando!');
});

// Inicia o servidor na porta 3000
app.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});*/

const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();

app.use(bodyParser.json());
app.use(express.static('public')); // Servir os arquivos HTML da pasta "public"

let disableAutoReply = []; // Lista de números com mensagens automáticas desativadas

// Inicializa o WPPConnect
wppconnect.create().then((client) => start(client));

function start(client) {
  client.onMessage(async (message) => {
    const from = message.from;
    console.log(from);

    // Verifica se o número está desativado
    if (disableAutoReply.includes(from)) {
      console.log(`Respostas automáticas desativadas para: ${from}`);
      return; // Ignora respostas automáticas para este número
    }

    // Envia resposta automática, se ativada
    if (message.body.toLowerCase() === 'menu') {
      await client.sendText(
        from,
        'Olá! Escolha uma das opções:\n1 - Passagem\n2 - Exames\n3 - Cirurgias'
      );
    }
    
    // Filtra mensagens automáticas desnecessárias
    if (message.body.includes("Currently I am sleeping")) {
        console.log("Mensagem automática bloqueada.");
        return;
    }

    // Resto da lógica normal do bot
    console.log(`Mensagem recebida de ${from}: ${message.body}`);
 
  });

  // Endpoint para desabilitar mensagens automáticas
  app.post('/disable-auto-reply', (req, res) => {
    const { number } = req.body;
    if (!disableAutoReply.includes(number)) {
      disableAutoReply.push(number);
      res.json({ success: true, message: `Auto-respostas desativadas para o número ${number}.` });
    } else {
      res.json({ success: false, message: 'Auto-respostas já estavam desativadas.' });
    }
  });

  // Endpoint para habilitar mensagens automáticas
  app.post('/enable-auto-reply', (req, res) => {
    const { number } = req.body;
    disableAutoReply = disableAutoReply.filter((num) => num !== number);
    res.json({ success: true, message: `Auto-respostas reativadas para o número ${number}.` });
  });

  // Endpoint para listar números desativados
  app.get('/disabled-numbers', (req, res) => {
    res.json(disableAutoReply);
  });

  // Inicia o servidor
  app.listen(3000, () => {
    console.log('Servidor rodando em http://localhost:3000');
  });
}
