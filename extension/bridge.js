// GDrive Down - bridge content script (runs on the GDrive Down website).
// Lets the page talk to the extension: presence ping and capture requests.
(function () {
  'use strict';

  function sendToPage(data) {
    window.postMessage(Object.assign({ source: 'gdd-ext' }, data), '*');
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'gdd-site') return;
    if (e.data.type === 'gdd-ping') {
      sendToPage({ type: 'gdd-pong' });
    } else if (e.data.type === 'gdd-start') {
      sendToPage({ type: 'gdd-status', phase: 'starting' });
      try {
        chrome.runtime.sendMessage({ type: 'gdd-start', link: e.data.link }, function (r) {
          if (chrome.runtime.lastError || !r || !r.ok) {
            sendToPage({
              type: 'gdd-status',
              phase: 'error',
              message: 'Could not start the capture (is the file link valid?).'
            });
          }
        });
      } catch (err) {
        sendToPage({ type: 'gdd-status', phase: 'error', message: 'Extension not reachable.' });
      }
    }
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'gdd-status') {
      sendToPage(msg);
    }
  });

  // Announce presence as soon as we load.
  sendToPage({ type: 'gdd-hello' });
})();
