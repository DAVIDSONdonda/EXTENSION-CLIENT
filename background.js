const NOTIF_ICON_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42mNkYPhfz0AEYBxVSF+FjAxkKmQkV+H/////00chAG3bC+kAAAAASUVORK5CYII=';

const DEFAULT_GEMINI_PROMPT = `Analyse cette image de CAPTCHA. 

STRUCTURE DE L'IMAGE :
- En haut à gauche : une case contenant l'IMAGE DE RÉFÉRENCE.
- En haut à droite : une case contenant le TEXTE (les instructions).
- En bas : une grande case contenant la SCÈNE à analyser.

RÈGLES DE LA TÂCHE :
- La scène du bas contient toujours exactement 8 monstres.
- Tu dois toujours choisir exactement 2 monstres selon la demande indiquée dans la case de référence (texte/instruction).
- ⚠️ RÈGLES CRITIQUES SUR LES BRAS ET LA COULEUR :
  1. Ignore complètement la couleur des monstres et de leurs bras. Seule la FORME compte.
  2. Le bras recherché peut être **long** ou **arrondi** (globuleux), exactement comme sur l'image de référence. Prends en compte ces variations de forme globale.

MÉTHODE OBLIGATOIRE (Calcul mental par grille) :
1. Lis attentivement le texte pour comprendre ce qu'il faut chercher.
2. **Examine attentivement les 8 monstres de la scène du bas. Ne te précipite pas.**
3. **Compare la FORME des bras de chaque monstre (qu'ils soient longs ou arrondis) avec l'image de référence pour trouver TOUTES les correspondances (en ignorant totalement les couleurs).**
4. Identifie les 2 monstres dont la forme des bras correspond le mieux à la demande.
5. **Imagine une grille virtuelle de 20 colonnes et 10 lignes superposée à la scène du bas.**
   - Les colonnes vont de A à T (A pour la 1ère, T pour la 20ème).
   - Les lignes vont de 1 à 10 (1 pour le haut, 10 pour le bas).
6. Pour chaque monstre sélectionné, détermine dans quelle case de cette grille virtuelle se trouve son centre.

FORMAT STRICT DE RÉPONSE (sans texte, sans markdown, sans explication) :
LettreColonne;NuméroLigne
LettreColonne;NuméroLigne

Exemple de réponse valide (si le monstre est dans la 3ème colonne, 5ème ligne) :
C;5
O;8`;

function notify(id, title, message, priority = 0) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: NOTIF_ICON_DATAURL,
    title,
    message,
    priority,
    requireInteraction: false
  });
}

function notifyCaptureDone(count, title) {
  notify('capture-done', 'Capture archivée', `${count} image(s) téléchargée(s).\nTexte : ${title ?? '—'}`, 0);
}

function notifyCaptureError(reason) {
  notify('capture-error', 'Échec de capture', reason, 2);
}

function sendPageStatus(tabId, message, type = 'info') {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'captureStatus', message, statusType: type }, () => {
    void chrome.runtime.lastError;
  });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: `captures/${filename}`,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(`${filename}: ${error.message}`));
        else if (downloadId === undefined) reject(new Error(`${filename}: identifiant de téléchargement absent`));
        else resolve(downloadId);
      }
    );
  });
}

async function downloadBlob(blob, filename) {
  const dataUrl = await blobToDataUrl(blob);
  return downloadDataUrl(dataUrl, filename);
}

function getLocalSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      geminiEnabled: true,
      geminiApiKey: '',
      geminiModel: 'gemini-3.5-flash-lite',
      extensionActive: true,
      downloadImages: true
    }, (values) => {
      resolve({
        geminiEnabled: values.geminiEnabled,
        geminiApiKey: values.geminiApiKey,
        geminiModel: values.geminiModel,
        extensionActive: values.extensionActive,
        downloadImages: values.downloadImages,
        geminiPrompt: DEFAULT_GEMINI_PROMPT
      });
    });
  });
}

function parseGridCoordinates(rawText, imgWidth, imgHeight, cols = 20, rows = 10) {
  const coords = [];
  const colWidth = imgWidth / cols;
  const rowHeight = imgHeight / rows;

  if (!rawText) return coords;

  const lines = rawText.split('\n');
  for (let line of lines) {
    line = line.trim().toUpperCase().replace(/\s+/g, '');
    if (!line || !line.includes(';')) continue;

    const parts = line.split(';');
    if (parts.length !== 2) continue;

    const [colStr, rowStr] = parts;
    if (colStr.length === 1 && colStr >= 'A' && colStr <= 'T') {
      const colIdx = colStr.charCodeAt(0) - 'A'.charCodeAt(0);
      if (/^\d+$/.test(rowStr)) {
        const rowIdx = parseInt(rowStr, 10) - 1;
        if (colIdx >= 0 && colIdx < cols && rowIdx >= 0 && rowIdx < rows) {
          const x = Math.round((colIdx + 0.5) * colWidth);
          const y = Math.round((rowIdx + 0.5) * rowHeight);
          coords.push({ x, y });
        }
      }
    }
  }
  return coords;
}

async function createSceneWithPoints(bitmap, stage, stageWidth, stageHeight, coords, timestamp) {
  const sceneCanvas = new OffscreenCanvas(stageWidth, stageHeight);
  const ctx = sceneCanvas.getContext('2d');

  ctx.drawImage(
    bitmap,
    Math.round(stage.x * stage.dpr), Math.round(stage.y * stage.dpr), stageWidth, stageHeight,
    0, 0, stageWidth, stageHeight
  );

  ctx.fillStyle = '#ff0000';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.font = 'bold 20px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  coords.forEach((coord, index) => {
    const { x, y } = coord;
    if (x < 0 || x > stageWidth || y < 0 || y > stageHeight) return;

    ctx.beginPath();
    ctx.arc(x, y, 12, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${index + 1}`, x, y - 2);
    ctx.fillStyle = '#ff0000';
  });

  const sceneBlob = await sceneCanvas.convertToBlob({ type: 'image/png' });
  await downloadBlob(sceneBlob, `capture-${timestamp}-scene-points.png`);
  return sceneBlob;
}

async function analyzeCompositeWithGemini(blob, timestamp, tabId, bitmap, stage, stageWidth, stageHeight) {
  const settings = await getLocalSettings();
  if (!settings.extensionActive) return;
  if (!settings.geminiEnabled) return;
  if (!settings.geminiApiKey) {
    sendPageStatus(tabId, 'Clé API Gemini non configurée.', 'error');
    return;
  }

  sendPageStatus(tabId, 'Envoi de l’image à Gemini…', 'loading');
  
  const dataUrl = await blobToDataUrl(blob);
  const base64Data = dataUrl.split(',')[1];
  const mimeType = dataUrl.split(';')[0].split(':')[1];

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${settings.geminiModel}:generateContent?key=${settings.geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: "Tu es un assistant de vision. Tu réponds UNIQUEMENT avec les coordonnées demandées, au format demandé, sans aucun autre texte." }]
      },
      contents: [
        {
          role: 'user',
          parts: [
            { text: settings.geminiPrompt },
            { inline_data: { mime_type: mimeType, data: base64Data } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.0,
        maxOutputTokens: 500
      }
    })
  });
  
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.error?.message || `API Gemini HTTP ${response.status}`);
  }
  
  let answer = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!answer) throw new Error('Réponse Gemini vide.');
  answer = answer.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();

  const coords = parseGridCoordinates(answer, stageWidth, stageHeight);

  if (coords.length === 0) {
    throw new Error(`Aucune coordonnée valide trouvée : ${answer.slice(0, 50)}`);
  }

  // Si l'option de téléchargement est active, on sauvegarde les images et les rapports
  if (settings.downloadImages) {
    const reportText = `Réponse brute Gemini :\n${answer}\n\nCoordonnées (Pixels) :\n${coords.map(c => `${c.x};${c.y}`).join('\n')}`;
    const report = new Blob([reportText], { type: 'text/plain;charset=utf-8' });
    await downloadBlob(report, `capture-${timestamp}-gemini.txt`);

    await createSceneWithPoints(bitmap, stage, stageWidth, stageHeight, coords, timestamp);
    notifyCaptureDone(1, 'Capture archivée');
  }

  const clickCoords = coords.map(c => ({
    x: stage.x + (c.x / stage.dpr),
    y: stage.y + (c.y / stage.dpr)
  }));

  chrome.tabs.sendMessage(tabId, {
    type: 'clickMonsters',
    coords: clickCoords
  }, () => {
    void chrome.runtime.lastError;
  });

  notify('capture-gemini', 'Analyse terminée', 'Clic automatique en cours...');
  sendPageStatus(tabId, `Analyse terminée : ${coords.length} élément(s). Clic en cours...`, 'success');
}

function drawPromptText(ctx, title, subtitle, x, width, headerHeight) {
  const padding = 14;
  const maxWidth = Math.max(80, width - padding * 2);
  let y = 28;

  ctx.fillStyle = '#000000';
  ctx.fillRect(x, 0, width, headerHeight);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 18px Arial, sans-serif';

  const drawLines = (text, lineHeight) => {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        ctx.fillText(line, x + padding, y);
        y += lineHeight;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      ctx.fillText(line, x + padding, y);
      y += lineHeight;
    }
  };

  drawLines(title || '(aucun titre)', 23);
  if (subtitle) {
    y += 6;
    ctx.fillStyle = '#d1d5db';
    ctx.font = '400 14px Arial, sans-serif';
    drawLines(subtitle, 19);
  }
}

async function dispatchTrustedClick(tabId, point) {
  const target = { tabId };
  let attached = false;
  const debuggerApi = globalThis.chrome?.debugger ?? globalThis.browser?.debugger;

  if (!debuggerApi?.attach || !debuggerApi?.sendCommand) {
    return { ok: false, trustedInput: false, error: 'API debugger indisponible.' };
  }

  try {
    await debuggerApi.attach(target, '1.3');
    attached = true;

    await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 });
    await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await debuggerApi.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });

    return { ok: true, trustedInput: true, point };
  } catch (error) {
    return { ok: false, trustedInput: false, error: error.message };
  } finally {
    if (attached) {
      try { await debuggerApi.detach(target); } catch (_) {}
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'trustedClick') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'Onglet source introuvable.' });
      return;
    }
    dispatchTrustedClick(tabId, msg.point).then(sendResponse);
    return true;
  }

  if (msg.type === 'captureError') {
    notifyCaptureError(msg.reason);
    return;
  }

  if (msg.type !== 'captureCards') return;

  const tabId = sender.tab.id;
  const windowId = sender.tab.windowId;

  chrome.tabs.update(tabId, { active: true }, () => {
    chrome.windows.update(windowId, { focused: true }, () => {
      setTimeout(() => {
        chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, async (dataUrl) => {
          if (chrome.runtime.lastError) {
            const reason = `Capture échouée : ${chrome.runtime.lastError.message}`;
            notifyCaptureError(reason);
            sendPageStatus(tabId, reason, 'error');
            return;
          }

          try {
            const blob = await fetch(dataUrl).then((r) => r.blob());
            const bitmap = await createImageBitmap(blob);
            const timestamp = msg.timestamp ?? Date.now();
            const ref = msg.rects.ref;
            const stage = msg.rects.stage;
            if (!ref || !stage) throw new Error('Zones introuvables.');

            const refWidth = Math.round(ref.width * ref.dpr);
            const refHeight = Math.round(ref.height * ref.dpr);
            const stageWidth = Math.round(stage.width * stage.dpr);
            const stageHeight = Math.round(stage.height * stage.dpr);
            
            if (refWidth <= 0 || refHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) {
              throw new Error('Dimensions invalides.');
            }

            const promptWidth = 280;
            const compositeWidth = Math.max(stageWidth, refWidth + promptWidth);
            const headerHeight = Math.max(refHeight, 120);
            const compositeHeight = headerHeight + stageHeight;
            const composite = new OffscreenCanvas(compositeWidth, compositeHeight);
            const compositeCtx = composite.getContext('2d');
            
            compositeCtx.fillStyle = '#ffffff';
            compositeCtx.fillRect(0, 0, compositeWidth, compositeHeight);
            
            drawPromptText(compositeCtx, msg.title, msg.subtitle, refWidth, compositeWidth - refWidth, headerHeight);
            
            compositeCtx.drawImage(
              bitmap,
              Math.round(ref.x * ref.dpr), Math.round(ref.y * ref.dpr), refWidth, refHeight,
              0, 0, refWidth, refHeight
            );
            compositeCtx.drawImage(
              bitmap,
              Math.round(stage.x * stage.dpr), Math.round(stage.y * stage.dpr), stageWidth, stageHeight,
              0, headerHeight, stageWidth, stageHeight
            );

            const compositeBlob = await composite.convertToBlob({ type: 'image/png' });
            
            // Si le téléchargement est activé, on sauvegarde aussi l'image composite globale
            const settings = await getLocalSettings();
            if (settings.downloadImages) {
              await downloadBlob(compositeBlob, `capture-${timestamp}-composite.png`);
            }
            
            try {
              await analyzeCompositeWithGemini(
                compositeBlob, 
                timestamp, 
                tabId,
                bitmap, 
                stage, 
                stageWidth, 
                stageHeight
              );
            } catch (analysisError) {
              console.error('[Auto Click] Analyse Gemini :', analysisError);
              notifyCaptureError(`Analyse Gemini échouée : ${analysisError.message}`);
              sendPageStatus(tabId, `Erreur d'analyse : ${analysisError.message}`, 'error');
            }
          } catch (err) {
            console.error('[Auto Click] Erreur :', err);
            const reason = `Téléchargement impossible : ${err.message}`;
            notifyCaptureError(reason);
            sendPageStatus(tabId, reason, 'error');
          }
        });
      }, 150);
    });
  });
});