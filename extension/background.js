// GDrive Down - background service worker (MV3).
// Coordinates capture jobs between the site bridge, the popup and the
// capture content script that runs on drive.google.com preview pages.

function parseId(text) {
  var s = String(text || '');
  var m = s.match(/\/file\/d\/([A-Za-z0-9_-]{25,})/) ||
          s.match(/(?:document|presentation|spreadsheets|forms|drawings)\/d\/([A-Za-z0-9_-]{25,})/) ||
          s.match(/[?&]id=([A-Za-z0-9_-]{25,})/) ||
          s.match(/^[A-Za-z0-9_-]{25,}$/);
  return m ? (m[1] || m[0]) : null;
}

async function getJobs() {
  try {
    const s = await chrome.storage.session.get('gddJobs');
    return s.gddJobs || {};
  } catch (e) {
    return {};
  }
}

async function setJob(tabId, job) {
  const jobs = await getJobs();
  jobs[tabId] = job;
  try { await chrome.storage.session.set({ gddJobs: jobs }); } catch (e) {}
}

async function delJob(tabId) {
  const jobs = await getJobs();
  delete jobs[tabId];
  try { await chrome.storage.session.set({ gddJobs: jobs }); } catch (e) {}
}

function tellSite(tabId, msg) {
  if (!tabId) return;
  try {
    chrome.tabs.sendMessage(tabId, msg, function () { void chrome.runtime.lastError; });
  } catch (e) {}
}

async function startJob(link, siteTabId) {
  const id = parseId(link);
  if (!id) {
    tellSite(siteTabId, { type: 'gdd-status', phase: 'error', message: 'No Drive file id found in that link.' });
    return { ok: false, error: 'no-file-id' };
  }
  const tab = await chrome.tabs.create({
    url: 'https://drive.google.com/file/d/' + id + '/preview',
    active: true
  });
  await setJob(tab.id, { siteTabId: siteTabId || null, startedAt: Date.now() });
  poke(tab.id, 0);
  return { ok: true };
}

// Retry until the capture content script on the new tab answers.
function poke(tabId, attempt) {
  if (attempt > 60) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: 'gdd-capture-now' }, function () {
      if (chrome.runtime.lastError) {
        setTimeout(function () { poke(tabId, attempt + 1); }, 500);
      }
    });
  } catch (e) {
    setTimeout(function () { poke(tabId, attempt + 1); }, 500);
  }
}

async function forwardToSite(senderTabId, msg) {
  const jobs = await getJobs();
  const job = jobs[senderTabId];
  if (msg.phase === 'done' || msg.phase === 'error') {
    await delJob(senderTabId);
    if (msg.phase === 'done') {
      setTimeout(function () {
        try { chrome.tabs.remove(senderTabId); } catch (e) {}
      }, 4500);
    }
  }
  if (job && job.siteTabId) {
    tellSite(job.siteTabId, Object.assign({ type: 'gdd-status' }, msg));
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    if (!msg || !msg.type) return;
    if (msg.type === 'gdd-start') {
      sendResponse(await startJob(msg.link, sender.tab ? sender.tab.id : null));
    } else if (msg.type === 'gdd-start-internal') {
      sendResponse(await startJob(msg.link, null));
    } else if (msg.type === 'gdd-popup-start') {
      sendResponse(await startJob(msg.link, null));
    } else if (msg.type === 'gdd-popup-tab') {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        try {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'gdd-capture-now' }, function () {
            void chrome.runtime.lastError;
          });
        } catch (e) {}
      }
      sendResponse({ ok: true });
    } else if (msg.type === 'gdd-progress') {
      await forwardToSite(sender.tab ? sender.tab.id : null, msg);
    }
  })();
  return true;
});
