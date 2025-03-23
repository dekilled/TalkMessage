// script.js
document.addEventListener('DOMContentLoaded', () => {
    const pendingList = document.getElementById('pending-list');
    const completedList = document.getElementById('completed-list');
    const chatPopup = document.getElementById('chat-popup');
    const chatClientName = document.getElementById('chat-client-name');
    const chatFlow = document.getElementById('chat-flow');
    const chatInput = document.getElementById('chat-input');
    const sendMessageBtn = document.getElementById('send-message');
    const endChatBtn = document.getElementById('end-chat');
    const closeChatBtn = document.getElementById('close-chat');
  
    // Dados fictícios de mensagens pendentes
    const pendingMessages = [
      { id: 1, name: 'João Silva', number: '5511999999999', type: 'Consulta', time: '10:30', date: '18/03/2025' },
    ];
  
    // Função para carregar mensagens pendentes
    function loadPendingMessages() {
      pendingList.innerHTML = '';
      pendingMessages.forEach((msg) => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${msg.id}</td>
          <td>${msg.name}</td>
          <td>${msg.number}</td>
          <td>${msg.type}</td>
          <td>${msg.time}</td>
          <td>${msg.date}</td>
          <td><button class="chat-btn" data-id="${msg.id}">Chat</button></td>
        `;
        pendingList.appendChild(row);
      });
    }
  
    // Abrir chat e desativar respostas automáticas
    pendingList.addEventListener('click', async (e) => {
      if (e.target.classList.contains('chat-btn')) {
        const id = e.target.dataset.id;
        const msg = pendingMessages.find((m) => m.id == id);
  
        await fetch('/disable-auto-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: msg.number }),
        });
  
        chatClientName.textContent = msg.name;
        chatPopup.classList.remove('hidden');
      }
    });
  
    // Finalizar chat e reativar respostas automáticas
    endChatBtn.addEventListener('click', async () => {
      const name = chatClientName.textContent;
      const msg = pendingMessages.find((m) => m.name === name);
  
      await fetch('/enable-auto-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: msg.number }),
      });
  
      completedList.innerHTML += `
        <tr>
          <td>${msg.id}</td>
          <td>${msg.name}</td>
          <td>${msg.number}</td>
          <td>${msg.type}</td>
          <td>${msg.time}</td>
          <td>${msg.date}</td>
        </tr>
      `;
  
      pendingMessages.splice(pendingMessages.indexOf(msg), 1);
      loadPendingMessages();
      chatPopup.classList.add('hidden');
    });
  
    loadPendingMessages();
  });
  