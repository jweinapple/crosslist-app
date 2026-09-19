const EXTENSION_ID = chrome.runtime.id;

document.documentElement.dataset.crosslistExtensionId = EXTENSION_ID;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== 'CROSSLIST_EXT_REQUEST') return;

  chrome.runtime.sendMessage(
    {
      command: data.command,
      payload: data.payload || {},
    },
    (response) => {
      const error = chrome.runtime.lastError;
      window.postMessage(
        {
          type: 'CROSSLIST_EXT_RESPONSE',
          requestId: data.requestId,
          response: error ? { error: error.message } : response,
        },
        window.location.origin
      );
    }
  );
});
