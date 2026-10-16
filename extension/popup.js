// GDrive Down - extension popup.
const q = (s) => document.querySelector(s);

(async function () {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const isDrive = tabs[0] && /drive\.google\.com/.test(tabs[0].url || '');
    if (!isDrive) {
      q('#tabBtn').disabled = true;
      q('#tabBtn').textContent = 'Open a Drive page first';
    }
  } catch (e) {
    q('#tabBtn').disabled = true;
  }
})();

q('#tabBtn').onclick = () => {
  chrome.runtime.sendMessage({ type: 'gdd-popup-tab' });
  window.close();
};

q('#goBtn').onclick = async () => {
  const link = q('#link').value.trim();
  if (!link) {
    q('#msg').textContent = 'Paste a link first.';
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'gdd-popup-start', link });
  if (r && r.ok) {
    q('#msg').textContent = 'Capturing in a new tab…';
    setTimeout(() => window.close(), 700);
  } else {
    q('#msg').textContent = (r && r.error) || 'Could not start.';
  }
};
