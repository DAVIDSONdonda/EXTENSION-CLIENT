const apiKey = document.querySelector('#apiKey');
const modelSelect = document.querySelector('#modelSelect');
const extensionActive = document.querySelector('#extensionActive');
const downloadImages = document.querySelector('#downloadImages');
const status = document.querySelector('#status');

chrome.storage.local.get({
  geminiApiKey: '',
  geminiModel: 'gemini-3.5-flash-lite',
  extensionActive: true,
  downloadImages: true
}, (values) => {
  apiKey.value = values.geminiApiKey;
  modelSelect.value = values.geminiModel;
  extensionActive.checked = values.extensionActive;
  downloadImages.checked = values.downloadImages;
});

document.querySelector('#save').addEventListener('click', () => {
  const key = apiKey.value.trim();
  if (!key) {
    status.textContent = 'Veuillez coller une clé API Gemini.';
    status.style.color = '#dc2626';
    return;
  }
  chrome.storage.local.set({
    geminiApiKey: key,
    geminiModel: modelSelect.value,
    extensionActive: extensionActive.checked,
    downloadImages: downloadImages.checked
  }, () => {
    if (chrome.runtime.lastError) {
      status.textContent = `Erreur : ${chrome.runtime.lastError.message}`;
      status.style.color = '#dc2626';
      return;
    }
    status.textContent = 'Configuration enregistrée avec succès !';
    status.style.color = '#059669';
  });
});