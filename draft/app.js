const fs = require('fs');
const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const app = express();
app.use(express.json()); // Permite trabalhar com JSON nas requisições


// Porta para o servidor Express
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

wppconnect
  .create({
    session: 'sessionName',
    catchQR: (base64Qr, asciiQR) => {
      console.log(asciiQR); // Optional to log the QR in the terminal
      var matches = base64Qr.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/),
        response = {};

      if (matches.length !== 3) {
        return new Error('Invalid input string');
      }
      response.type = matches[1];
      response.data = new Buffer.from(matches[2], 'base64');

      var imageBuffer = response;
      require('fs').writeFile(
        'out.png',
        imageBuffer['data'],
        'binary',
        function (err) {
          if (err != null) {
            console.log(err);
          }
        }
      );
    },
    logQR: false,
  })
  .then((client) => start(client))
  .catch((error) => console.log(error));


// Lista para armazenar os números com respostas automáticas desativadas
let disableAutoReply = [];
let history = '';


function start(client) {
client.onMessage(async (message) => {
    const from = message.from; // Número do contato
    
    // Filtra mensagens automáticas desnecessárias
    if (message.body.includes("Currently I am sleeping")) {
        console.log("Mensagem automática bloqueada.");
        return;
    }

    // Resto da lógica normal do bot
    console.log(`Mensagem recebida de ${from}: ${message.body}`);
    //Captura o nome do contato
    const contact = await client.getContact(message.from);
    const contactName = contact.name || contact.pushname || 'Usuário desconhecido';
    
    
    if (message.body === 'Oi') {
        client.sendText(message.from, 'Olá! Bem Vindo a Secreataria de Saúde, como posso ajudá-lo hoje? \n1 - Passagem \n2 - Exames \n2 - Consultas')
            .then((result) => {
            console.log('Result: ', result); //return object success
            })
            .catch((erro) => {
            console.error('Error when sending: ', erro); //return object error
            });
    }
    if(disableAutoReply.includes(from)){
        console.log(`Respostas automáticas desativadas para:(${from})`);
        return; //Não responde automaticamente
    }
    //Comando para mostrar o menu principal
    if(message.body.toLowerCase() === 'Menu'){
        await client.sendText(
            from,
            `Olá, ${contactName}! Bem vindo(a) a Secretaria de Saúde de Botumirim!\n\n Como posso te ajudar hoje? n1 - Passagem\n2 - Exames\n3 - Consultas\n4 - Cirurgias`
        );
    }
    if (message.body.toLowerCase() === 'desativar') {
        if (!disableAutoReply.includes(from)){
            disableAutoReply.push(from);
            await client.sendText(
                from, 
                `Respostas automaticas desativadas para você,${contactName}. Um atendente irá falar com você em instantes!`
            );
        }else{
            await client.sendText(
                from,
                `Respostas automáticas já estão desativadas para este número.`
            )
        }
    }

    if(message.body.toLowerCase() === 'ativar') {
        disableAutoReply = disableAutoReply.filter((num) => num !== from);
        await client.sendText(
            from,
            `Respostas automáticas reativadas para você, ${contactName}.`
        );
    }

    if (message.body === '1'){
        await client.sendText(from, 'Você escolheu "Passagem, por favor aguarde."');
    }
    if (message.body === '2'){
        await client.sendText(from, 'Você escolheu "Exames, por favor aguarde."');
    }
    if (message.body === '3'){
        await client.sendText(from, 'Você escolheu "Consultas, por favor aguarde."');
    }
    /*
    */
});
}

/*
//PARTE 3
app.post('/disable-auto-reply', (req, res) => {
  const { number } = req.body;
  if (!disableAutoReply.includes(number)) {
    disableAutoReply.push(number);
    console.log(`Número desativado: ${number}`);
    res.json({ success: true, message: `Auto-respostas desativadas para o número: ${number}.` });
  } else {
    res.json({ success: false, message: 'Número já está desativado.' });
  }
});


//PARTE 4
app.post('/enable-auto-reply', (req, res) => {
  const { number } = req.body;
  disableAutoReply = disableAutoReply.filter((num) => num !== number);
  console.log(`Número ativado: ${number}`);
  res.json({ success: true, message: `Auto-respostas reativadas para o número: ${number}.` });
});


//PARTE 5
app.get('/disabled-numbers', (req, res) => {
  res.json(disableAutoReply);
  console.log(`Lista atual de números desativados: ${disableAutoReply}`);
});*/