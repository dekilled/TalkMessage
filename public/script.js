// script.js
function switchTab(tabId) {
    // Remove a classe ativa de todos os botões e seções
    document.querySelectorAll('.tab-button').forEach(button => button.classList.remove('active'));
    document.querySelectorAll('.main-content section').forEach(tab => tab.classList.remove('active'));
  
    // Adiciona a classe ativa ao botão e à seção correspondente
    document.querySelector(`.tab-button[onclick="switchTab('${tabId}')"]`).classList.add('active');
    document.getElementById(tabId).classList.add('active');
  }
  