// GDrive Down - capture content script (runs on drive.google.com).
// Auto-captures a preview tab on request, provides a floating button on
// file pages, builds the PDF locally and saves it. No server involved.
(function () {
  'use strict';
  if (window.__GDD_EXT__) return;
  window.__GDD_EXT__ = true;

  var IMG = 'img[src^="blob:"]';
  var C = {
    fg: '#eaf0f8', sub: '#b9c3d4', mut: '#8b95a7',
    bg: '#0b0f16', border: 'rgba(255,255,255,.09)',
    track: '#1b2432', accent: '#3ed5a3'
  };
  var running = false;
  var cancelled = false;

  function el(tag, css, parent) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (parent) parent.appendChild(e);
    return e;
  }

  function logo(size) {
    var d = document.createElement('div');
    d.style.cssText = 'flex:none;display:flex';
    d.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 32 32" style="display:block">'
      + '<rect width="32" height="32" rx="9" fill="' + C.accent + '"/>'
      + '<path d="M16 7v12m0 0l-5-5m5 5l5-5M9.5 25h13" stroke="#04140d" stroke-width="2.6" '
      + 'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    return d;
  }

  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function report(o) {
    try { chrome.runtime.sendMessage(Object.assign({ type: 'gdd-progress' }, o)); } catch (e) {}
  }

  function makeUI() {
    var startedAt = Date.now();
    var panel = el('div', 'position:fixed;top:16px;right:16px;z-index:2147483647;width:340px;max-width:calc(100vw - 32px);'
      + 'background:' + C.bg + ';border:1px solid ' + C.border + ';border-radius:14px;padding:14px 16px;'
      + 'box-shadow:0 18px 50px rgba(0,0,0,.55);opacity:0;transition:opacity .25s ease', document.body);
    panel.id = 'gdd-panel';
    var head = el('div', 'display:flex;align-items:center;gap:10px', panel);
    head.appendChild(logo(22));
    el('div', 'font:600 14px/1.2 system-ui,sans-serif;color:' + C.fg + ';flex:none', head).textContent = 'GDrive Down';
    var statusEl = el('div', 'flex:1;min-width:0;font:500 12.5px/1.4 system-ui,sans-serif;color:' + C.sub
      + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis', head);
    var timeEl = el('div', 'flex:none;font:500 12px ui-monospace,Menlo,Consolas,monospace;color:' + C.mut, head);
    var cancelBtn = el('button', 'flex:none;font:600 12px system-ui,sans-serif;color:#cfd6e2;background:transparent;'
      + 'border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:6px 12px;cursor:pointer', head);
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = function () { cancelled = true; cancelBtn.textContent = 'Cancelling…'; };
    var track = el('div', 'height:6px;border-radius:999px;background:' + C.track + ';overflow:hidden;margin-top:12px', panel);
    var barEl = el('div', 'height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,'
      + C.accent + ',#7ee7c4);transition:width .3s ease', track);
    var meta = el('div', 'display:flex;justify-content:space-between;gap:10px;margin-top:8px', panel);
    var countEl = el('div', 'font:500 11.5px ui-monospace,Menlo,Consolas,monospace;color:' + C.mut, meta);
    el('div', 'font:500 11.5px ui-monospace,Menlo,Consolas,monospace;color:' + C.mut, meta)
      .textContent = 'runs locally';

    var tick = setInterval(function () { timeEl.textContent = fmtTime(Date.now() - startedAt); }, 1000);
    requestAnimationFrame(function () { panel.style.opacity = '1'; });

    function finishPanel(delay, keep) {
      clearInterval(tick);
      setTimeout(function () {
        panel.style.opacity = '0';
        setTimeout(function () { panel.remove(); }, 400);
      }, keep ? 6000 : (delay || 0));
    }

    return {
      setStatus: function (t) { statusEl.textContent = t; },
      setProgress: function (done, total) {
        if (total > 0) barEl.style.width = Math.min(100, Math.round((done / total) * 100)) + '%';
        countEl.textContent = total > 0 ? ('Page ' + done + ' / ' + total) : '';
      },
      success: function (text) {
        statusEl.textContent = text;
        cancelBtn.style.display = 'none';
        finishPanel(0, true);
      },
      fail: function (text) {
        statusEl.textContent = text;
        cancelBtn.style.display = 'none';
        finishPanel(0, true);
      },
      cancelled: function () {
        statusEl.textContent = 'Cancelled.';
        cancelBtn.style.display = 'none';
        finishPanel(0);
      }
    };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitFor(fn, timeoutMs, errMsg) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function tick() {
        if (cancelled) { reject(new Error('cancelled')); return; }
        var v = null;
        try { v = fn(); } catch (e) { reject(e); return; }
        if (v) { resolve(v); return; }
        if (Date.now() - t0 > timeoutMs) { reject(new Error(errMsg)); return; }
        setTimeout(tick, 250);
      })();
    });
  }

  function hasImages(d) {
    try { return d.querySelectorAll(IMG).length > 0; } catch (e) { return false; }
  }

  function pageId(href) {
    var s = String(href || location.href);
    var m = s.match(/\/file\/d\/([A-Za-z0-9_-]{25,})/) ||
            s.match(/(?:document|presentation|spreadsheets|forms|drawings)\/d\/([A-Za-z0-9_-]{25,})/) ||
            s.match(/[?&]id=([A-Za-z0-9_-]{25,})/) ||
            s.match(/\/d\/([A-Za-z0-9_-]{25,})/);
    return m ? m[1] : null;
  }

  function getPages(doc) {
    var imgs = [].slice.call(doc.querySelectorAll(IMG));
    if (!imgs.length) throw new Error('no page images found yet');
    try {
      var first = imgs[0].parentElement;
      var cls = first.className;
      if (cls && !/\s/.test(cls)) {
        var ps = [].slice.call(first.parentElement.querySelectorAll(':scope > .' + CSS.escape(cls)));
        if (ps.length) return ps;
      }
    } catch (e) {}
    var win = doc.defaultView || window;
    var seen = [];
    for (var i = 0; i < imgs.length; i++) {
      var p = imgs[i].parentElement;
      if (p && seen.indexOf(p) === -1) seen.push(p);
    }
    seen.sort(function (a, b) {
      return (a.getBoundingClientRect().top + win.scrollY) -
             (b.getBoundingClientRect().top + win.scrollY);
    });
    return seen;
  }

  function waitImage(page) {
    try { page.scrollIntoView(); } catch (e) {}
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      var n = 0;
      (function tick() {
        if (cancelled) { reject(new Error('cancelled')); return; }
        n++;
        var img = page.querySelector(IMG);
        if (img && img.complete && img.naturalWidth) { resolve(img); return; }
        if (Date.now() - t0 > 20000) { reject(new Error('a page image failed to load')); return; }
        if (n % 8 === 0) { try { page.scrollIntoView(); } catch (e) {} }
        setTimeout(tick, 250);
      })();
    });
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function buildPdf(pages) {
    var enc = new TextEncoder();
    var chunks = [];
    var length = 0;
    var offsets = [];
    var objCount = 2 + pages.length * 3;
    function push(data) {
      var b = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(b);
      length += b.length;
    }
    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xff, 0xff, 0xff, 0xff, 0x0a]));
    function addObj(n, body, streamBytes) {
      offsets[n] = length;
      push(n + ' 0 obj\n' + body + '\n');
      if (streamBytes) { push('stream\n'); push(streamBytes); push('\nendstream\n'); }
      push('endobj\n');
    }
    var kids = [];
    for (var i = 0; i < pages.length; i++) kids.push((3 + i * 3) + ' 0 R');
    addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    addObj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>');
    for (var j = 0; j < pages.length; j++) {
      var pg = pages[j];
      var pageNum = 3 + j * 3;
      var contentNum = pageNum + 1;
      var imgNum = pageNum + 2;
      var content = 'q\n' + pg.w + ' 0 0 ' + pg.h + ' 0 0 cm\n/Im0 Do\nQ\n';
      addObj(pageNum,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pg.w + ' ' + pg.h + '] ' +
        '/Resources << /XObject << /Im0 ' + imgNum + ' 0 R >> >> ' +
        '/Contents ' + contentNum + ' 0 R >>');
      addObj(contentNum, '<< /Length ' + content.length + ' >>', enc.encode(content));
      offsets[imgNum] = length;
      push(imgNum + ' 0 obj\n' +
        '<< /Type /XObject /Subtype /Image /Width ' + pg.w + ' /Height ' + pg.h + ' ' +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
        '/Length ' + pg.bytes.length + ' >>\nstream\n');
      push(pg.bytes);
      push('\nendstream\nendobj\n');
    }
    var xrefPos = length;
    var xref = 'xref\n0 ' + (objCount + 1) + '\n0000000000 65535 f \n';
    for (var k = 1; k <= objCount; k++) {
      var off = String(offsets[k] || 0);
      while (off.length < 10) off = '0' + off;
      xref += off + ' 00000 n \n';
    }
    push(xref);
    push('trailer\n<< /Size ' + (objCount + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');
    var total = 0;
    for (var m = 0; m < chunks.length; m++) total += chunks[m].length;
    var merged = new Uint8Array(total);
    var pos = 0;
    for (var n2 = 0; n2 < chunks.length; n2++) { merged.set(chunks[n2], pos); pos += chunks[n2].length; }
    return new Blob([merged], { type: 'application/pdf' });
  }

  function pdfName() {
    var name = (document.title || '').replace(/\s*-\s*Google (Drive|Docs|Slides|Sheets)\s*$/i, '').trim();
    if (!name || name === 'GDrive Down') name = 'gdrive-capture';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return name;
  }

  async function captureAll(ui) {
    ui.setStatus('waiting for pages to render…');
    report({ phase: 'started' });
    await waitFor(function () { return hasImages(document); }, 45000,
      'the preview did not render any pages');
    var pages = getPages(document);
    var total = pages.length;
    ui.setStatus('capturing ' + total + ' page' + (total === 1 ? '' : 's') + '…');
    var out = [];
    for (var i = 0; i < total; i++) {
      if (cancelled) throw new Error('cancelled');
      var img = await waitImage(pages[i]);
      await sleep(80);
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error('page ' + (i + 1) + ' has no size');
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0);
      out.push({ w: w, h: h, bytes: b64ToBytes(c.toDataURL('image/jpeg', 0.92).split(',')[1]) });
      ui.setProgress(i + 1, total);
      report({ phase: 'page', done: i + 1, total: total });
    }
    ui.setStatus('building the PDF…');
    report({ phase: 'building', done: total, total: total });
    var blob = buildPdf(out);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = pdfName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    ui.setProgress(total, total);
    var name = pdfName();
    ui.success('Saved ' + name + ' · ' + total + ' pages');
    report({ phase: 'done', name: name, pages: total });
  }

  async function runCapture() {
    if (running) return;
    running = true;
    cancelled = false;
    var ui = makeUI();
    try {
      await captureAll(ui);
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (msg === 'cancelled') {
        ui.cancelled();
        report({ phase: 'error', message: 'cancelled' });
      } else {
        ui.fail('Stopped: ' + msg);
        report({ phase: 'error', message: msg });
      }
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'gdd-capture-now') {
      sendResponse({ ack: true, started: true });
      runCapture();
    }
  });

  /* Floating button on Drive file pages. */
  var btn = null;
  function updateButton() {
    var id = pageId(location.href);
    var want = Boolean(id) && !running;
    if (want && !btn) {
      btn = el('button', 'position:fixed;bottom:20px;right:20px;z-index:2147483646;display:flex;align-items:center;gap:8px;'
        + 'background:' + C.bg + ';color:' + C.fg + ';border:1px solid rgba(62,213,163,.5);'
        + 'border-radius:12px;padding:10px 16px;font:600 13px system-ui,sans-serif;cursor:pointer;'
        + 'box-shadow:0 10px 30px rgba(0,0,0,.45)', document.body);
      btn.innerHTML = '<span style="width:10px;height:10px;border-radius:3px;background:' + C.accent + '"></span>'
        + 'Save as PDF';
      btn.onclick = function () {
        if (hasImages(document)) {
          runCapture();
        } else {
          try { chrome.runtime.sendMessage({ type: 'gdd-start-internal', link: location.href }); } catch (e) {}
        }
      };
    } else if (!want && btn) {
      btn.remove();
      btn = null;
    }
  }
  setInterval(updateButton, 1500);
  updateButton();
})();
