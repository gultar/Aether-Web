(() => {
  let initial;
  try { initial = new URL(location.href); } catch { return; }
  const requestId = initial.searchParams.get('browseros_request');
  if (!requestId) return;

  const initialQuery = Object.fromEntries(initial.searchParams.entries());
  const send = message => new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(response || { ok: false, error: 'No response from BrowserOS Companion.' });
    });
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const visible = el => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 1 && box.height > 1 && !el.disabled;
  };
  const controlText = el => norm([
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('title'),
    el.getAttribute?.('data-automationid'),
    el.textContent
  ].filter(Boolean).join(' '));

  function queryMatches(expected = {}) {
    for (const [key, wantedRaw] of Object.entries(expected)) {
      const wanted = String(wantedRaw ?? '');
      const actual = String(initialQuery[key] ?? '');
      if (actual !== wanted) return { ok: false, error: `Outlook URL verification failed for ${key}.` };
    }
    return { ok: true };
  }

  function titleIsPresent(subject) {
    const wanted = norm(subject);
    if (!wanted) return false;
    const nodes = document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]');
    for (const el of nodes) {
      const value = norm(el.value ?? el.textContent ?? el.getAttribute?.('aria-label') ?? '');
      if (value === wanted || value.includes(wanted)) return true;
    }
    // Outlook can render the pre-filled subject in a non-input Fluent control
    // before the editable textbox is attached. Requiring the exact visible title
    // anywhere in the compose surface is still much safer than blind clicking.
    const bodyText = norm(document.body?.innerText || '');
    return bodyText.includes(wanted);
  }

  function findSaveButton() {
    const exact = new Set(['save', 'save event', 'enregistrer', 'enregistrer l’événement', "enregistrer l'evenement", 'guardar', 'guardar evento']);
    const candidates = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    return candidates.find(el => {
      const text = controlText(el);
      if (exact.has(text)) return true;
      return /^(save|enregistrer|guardar)(\s+(event|appointment|événement|rendez-vous|evento))?$/.test(text);
    }) || null;
  }

  async function report(status, detail = '', error = '') {
    return send({ type: 'SET_OUTLOOK_AUTOMATION_STATUS', requestId, status, detail, error });
  }

  async function run() {
    const request = await send({ type: 'GET_OUTLOOK_AUTOMATION_REQUEST', requestId });
    if (!request?.ok) return;
    if (!request.autoSave) return report('opened', 'Automatic Save was disabled for this event.');

    const verifiedUrl = queryMatches(request.expectedQuery || {});
    if (!verifiedUrl.ok) return report('failed', '', verifiedUrl.error);
    await report('opened', 'Outlook compose page opened in the signed-in browser profile.');

    const deadline = Date.now() + 30000;
    let saveButton = null;
    while (Date.now() < deadline) {
      if (titleIsPresent(request.event?.subject) && (saveButton = findSaveButton())) break;
      await sleep(250);
    }
    if (!saveButton) return report('failed', '', 'The Outlook event form loaded, but BrowserOS could not safely verify the title and Save button. Nothing was clicked.');

    await report('verified', 'Verified the requested event and Outlook Save control.');
    await sleep(500);
    saveButton.click();
    await report('save-clicked', 'Clicked Save in Outlook Web.');

    // Outlook is a SPA. A successful save normally removes the editor/save control
    // or navigates away from the compose state. Wait for that instead of declaring
    // success immediately after dispatching a click.
    const confirmationDeadline = Date.now() + 20000;
    while (Date.now() < confirmationDeadline) {
      await sleep(350);
      const stillThere = findSaveButton();
      const body = norm(document.body?.innerText || '');
      const successText = /(event (created|saved)|événement (créé|enregistré)|evento (creado|guardado))/.test(body);
      if (!stillThere || successText) {
        await report('saved', 'Outlook closed the event editor after Save.');
        return;
      }
    }
    await report('save-clicked', 'Save was clicked, but the extension could not independently confirm that Outlook closed the editor.');
  }

  run().catch(error => report('failed', '', String(error?.message || error)).catch(() => {}));
})();
