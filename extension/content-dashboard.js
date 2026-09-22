const EXTENSION_ID = chrome.runtime.id;

document.documentElement.dataset.crosslistExtensionId = EXTENSION_ID;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.type !== 'CROSSLIST_EXT_REQUEST') return;

  const port = chrome.runtime.connect({ name: 'dashboard' });
  let done = false;
  const finish = (response) => {
    if (done) return;
    done = true;
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
    window.postMessage(
      {
        type: 'CROSSLIST_EXT_RESPONSE',
        requestId: data.requestId,
        response,
      },
      window.location.origin
    );
  };

  port.onMessage.addListener((response) => finish(response || {}));
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    finish({ error: error || 'The Chrome helper disconnected. Reload it and try again.' });
  });
  try {
    port.postMessage({
      command: data.command,
      payload: data.payload || {},
    });
  } catch (error) {
    finish({ error: error.message || 'Could not reach the Chrome helper' });
  }
});
