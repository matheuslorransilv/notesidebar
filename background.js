// Abre o painel lateral ao clicar no ícone da extensão (ou usar o atalho).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));
