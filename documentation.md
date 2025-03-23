Documentação do Código - Bot de Atendimento

**Visão Geral**

Este código implementa um bot de atendimento que interage com os usuários via mensagens. O bot utiliza a biblioteca _wppconnect_ para se conectar ao WhatsApp e _socket.io_ para enviar atualizações em tempo real para uma interface web. O bot é projetado para responder a comandos, gerenciar estados de interação e enviar mensagens de forma dinâmica e aleatória.
Funcionalidades

**1. Mensagens de Boas-Vindas:**
    
    O bot envia uma mensagem de boas-vindas aleatória ao usuário quando ele inicia uma conversa.

**2. Menu de Opções:**
    
    Após a mensagem de boas-vindas, o bot apresenta um menu com opções de serviços (Passagem, Exames, Cirurgias).

**3. Submenus:**
    
    O usuário pode escolher um serviço e, em seguida, selecionar uma ação (Solicitar ou Cancelar).

**4. Coleta de Informações:**
    
    O bot coleta o nome do usuário e uma descrição do que ele deseja.

**5. Fila de Espera:**
    
    Após coletar as informações, o bot informa ao usuário que ele foi colocado na fila de espera e em breve será contatado por um atendente.

**6. Comando de Encerramento:**
    
    O usuário pode enviar o comando _/encerrar_ para desativar as respostas automáticas do bot.

**7. Atualizações em Tempo Real:**
    
    O bot emite eventos via Socket.IO para atualizar a interface web com as informações do atendimento.

**Variáveis e Estruturas**
**Variáveis Globais**

**disableAutoReply:** 

Array que armazena números de telefone que não devem receber respostas automáticas.

**appointments:** 

Array que armazena os atendimentos em andamento.
completedAppointments: Array que armazena os atendimentos concluídos.
userStates: Objeto que armazena o estado atual de cada usuário, incluindo informações sobre o atendimento.

**Mensagens**

_welcomeMessages:_ Array de mensagens de boas-vindas que são escolhidas aleatoriamente.

_menuMessages:_ Array de mensagens que apresentam as opções de serviços disponíveis.
Estrutura do Estado do Usuário
Cada usuário tem um estado armazenado em userStates que contém:

_step:_ 

Indica em qual etapa do atendimento o usuário se encontra (ex: 'initial', 'awaiting_service', 'awaiting_name', etc.).

_data:_ Objeto que armazena informações coletadas do usuário, como:
name: Nome do usuário.

_service:_ 

Serviço escolhido pelo usuário.
description: Descrição do que o usuário deseja.

_date:_ 

Data do contato.

_time:_ Hora do contato.

Como Utilizar para Implementação na Web

_Configuração do Ambiente:_

Instale as dependências necessárias (express, socket.io, @wppconnect-team/wppconnect).
Configure o servidor Express e a conexão com o Socket.IO.

**Integração com a Interface Web:**

Utilize o evento *new_message* emitido pelo bot para atualizar a interface web em tempo real.
Crie um cliente Socket.IO na sua interface web para escutar esses eventos e atualizar a UI conforme necessário.

O evento *new_message* que é emitido no código contém todos os dados do usuário que foram coletados durante a interação, não apenas a mensagem. Especificamente, ele inclui as seguintes informações armazenadas no objeto userState.data:
*name:* O nome do usuário.
*service:* O serviço que o usuário escolheu (por exemplo, Passagem, Exames, Cirurgias).
*description:* A descrição do que o usuário deseja.
*date:* A data em que o usuário entrou em contato.
*time:* A hora em que o usuário entrou em contato.

**Exemplo de Estrutura de Dados**
Quando o evento *new_message* é emitido, ele pode ter uma estrutura semelhante a esta:

{
    name: "Nome do Usuário",
    service: "Passagem",
    description: "Solicitar passagem para o dia 20",
    date: "10/03/2025",
    time: "10:30"
}

**Como Utilizar na Interface Web**
Na sua interface web, ao escutar o evento *new_message*, você pode acessar todos esses dados e utilizá-los para atualizar a interface, exibir informações sobre o atendimento ou qualquer outra funcionalidade que você deseje implementar.

Por exemplo, você pode fazer algo assim:

socket.on('new_message', (data) => {
    console.log('Novo atendimento:', data);
    // Atualize a interface com os dados do atendimento
    // Exemplo: adicionar à lista de atendimentos pendentes
});

Dessa forma, você terá acesso a todas as informações relevantes do usuário, permitindo uma gestão mais eficaz dos atendimentos.

**Gerenciamento de Estados:**

Utilize a estrutura de estados para gerenciar a interação do usuário. Cada vez que o usuário envia uma mensagem, verifique o estado atual e responda de acordo.

**Comandos:**

Implemente a lógica para reconhecer comandos como */encerrar* e gerenciar a ativação/desativação das respostas automáticas.

**Testes:**

Teste a interação do bot com diferentes usuários e cenários para garantir que todas as funcionalidades estejam funcionando conforme esperado.
Conclusão.

Este bot de atendimento é uma solução flexível e dinâmica para interações via WhatsApp, permitindo que os usuários recebam assistência de forma eficiente. A implementação do Socket.IO permite que a interface web seja atualizada em tempo real, melhorando a experiência do usuário.


