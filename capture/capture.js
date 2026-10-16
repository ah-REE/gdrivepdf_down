/* GDrive Down capture bookmarklet (v3).
   Runs entirely in your own browser. Click it on any Google Drive file
   link: it opens the preview inline (or uses the one already open), then
   captures every rendered page and saves a PDF. No server involved.
   Works for any file you can view, including private ones. */
(function () {
  'use strict';
  if (window.__GDD_RUNNING__) { return; }
  window.__GDD_RUNNING__ = true;

  var IMG = 'img[src^="blob:"]';
  var cancelled = false;
  var panel = null, overlay = null, iframeEl = null;
  var barEl = null, statusEl = null, countEl = null, timeEl = null, cancelBtn = null;
  var startedAt = Date.now();
  var tickTimer = null;

  var C = {
    fg: '#121212', sub: '#46433c', mut: '#6b665c',
    bg: '#f4f1ea', border: '#121212',
    track: '#fffefb', accent: '#ff2d20', accent2: '#ff2d20',
    green: '#0c7a42'
  };

  function el(tag, css, parent) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (parent) parent.appendChild(e);
    return e;
  }

  function logo(size) {
    var s = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 32 32" style="display:block">'
      + '<rect width="32" height="32" rx="9" fill="' + C.accent + '"/>'
      + '<path d="M16 7v12m0 0l-5-5m5 5l5-5M9.5 25h13" stroke="#121212" stroke-width="2.6" '
      + 'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    var d = document.createElement('div');
    d.style.cssText = 'flex:none;display:flex';
    d.innerHTML = s;
    return d;
  }

  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function buildHeader(parent) {
    var head = el('div', 'display:flex;align-items:center;gap:10px', parent);
    head.appendChild(logo(22));
    el('div', 'font:700 13px/1.2 ui-monospace,Menlo,Consolas,monospace;color:' + C.fg + ';flex:none;letter-spacing:.08em', head)
      .textContent = 'GDRIVE_DOWN';
    statusEl = el('div', 'flex:1;min-width:0;font:500 11.5px/1.4 ui-monospace,Menlo,Consolas,monospace;color:' + C.sub
      + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis', head);
    timeEl = el('div', 'flex:none;font:500 11.5px ui-monospace,Menlo,Consolas,monospace;color:' + C.mut, head);
    cancelBtn = el('button', 'flex:none;font:600 10.5px ui-monospace,Menlo,Consolas,monospace;color:' + C.fg + ';background:' + C.track
      + ';border:2px solid ' + C.border + ';padding:6px 10px;cursor:pointer;letter-spacing:.08em;text-transform:uppercase', head);
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = function () { cancelled = true; cancelBtn.textContent = 'Stopping…'; };
  }

  function buildProgress(parent) {
    var track = el('div', 'height:10px;background:' + C.track
      + ';border:2px solid ' + C.border + ';overflow:hidden;margin-top:12px', parent);
    barEl = el('div', 'height:100%;width:0%;background:' + C.accent + ';transition:width .3s ease', track);
    var meta = el('div', 'display:flex;justify-content:space-between;gap:10px;margin-top:8px', parent);
    countEl = el('div', 'font:500 11px ui-monospace,Menlo,Consolas,monospace;color:' + C.mut, meta);
    el('div', 'font:500 11px ui-monospace,Menlo,Consolas,monospace;color:' + C.mut + ';letter-spacing:.06em', meta)
      .textContent = 'RUNS LOCALLY · CLICK CANCEL TO STOP';
  }

  /* Corner panel: used when the preview is already on screen. */
  function buildCornerPanel() {
    panel = el('div', 'position:fixed;top:16px;right:16px;z-index:2147483647;width:360px;max-width:calc(100vw - 32px);'
      + 'background:' + C.bg + ';border:2px solid ' + C.border + ';padding:14px 16px;'
      + 'box-shadow:8px 8px 0 rgba(18,18,18,.85);font-family:ui-monospace,Menlo,Consolas,monospace;'
      + 'opacity:0;transition:opacity .25s ease', document.body);
    panel.id = 'gdd-panel';
    buildHeader(panel);
    buildProgress(panel);
    requestAnimationFrame(function () { panel.style.opacity = '1'; });
  }

  /* Overlay: preview loads inline in a same-origin frame. */
  function buildOverlay(previewUrl) {
    overlay = el('div', 'position:fixed;inset:0;z-index:2147483647;background:rgba(244,241,234,.97);'
      + 'display:flex;flex-direction:column;align-items:center;padding:18px;gap:12px;'
      + 'opacity:0;transition:opacity .25s ease', document.body);
    overlay.id = 'gdd-overlay';
    panel = el('div', 'width:min(1100px,100%);flex:none;background:' + C.bg + ';border:2px solid ' + C.border
      + ';padding:14px 16px;box-shadow:8px 8px 0 rgba(18,18,18,.85);font-family:ui-monospace,Menlo,Consolas,monospace', overlay);
    panel.id = 'gdd-panel';
    buildHeader(panel);
    buildProgress(panel);
    var wrap = el('div', 'width:min(1100px,100%);flex:1;min-height:0', overlay);
    iframeEl = el('iframe', 'width:100%;height:100%;border:2px solid ' + C.border + ';background:#fff', wrap);
    iframeEl.setAttribute('allow', 'clipboard-read');
    iframeEl.src = previewUrl;
    requestAnimationFrame(function () { overlay.style.opacity = '1'; });
  }

  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function setProgress(done, total) {
    if (barEl && total > 0) {
      barEl.style.width = Math.min(100, Math.round((done / total) * 100)) + '%';
    }
    if (countEl) {
      countEl.textContent = total > 0 ? ('Page ' + done + ' / ' + total) : '';
    }
  }
  function startTicker() {
    tickTimer = setInterval(function () {
      if (timeEl) timeEl.textContent = fmtTime(Date.now() - startedAt);
    }, 1000);
  }
  function cleanup(delay, keepOpen) {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    setTimeout(function () {
      if (overlay) { overlay.style.opacity = '0'; setTimeout(function () { overlay.remove(); }, 400); }
      if (panel && !overlay) { panel.style.opacity = '0'; setTimeout(function () { panel.remove(); }, 400); }
      window.__GDD_RUNNING__ = false;
    }, keepOpen ? 6000 : delay || 0);
  }

  function fail(e) {
    var msg = (e && e.message) || String(e);
    if (msg === 'cancelled') {
      setStatus('Cancelled.');
      if (cancelBtn) cancelBtn.style.display = 'none';
      cleanup(0);
      return;
    }
    setStatus('Stopped: ' + msg);
    if (statusEl) statusEl.style.color = C.accent;
    if (cancelBtn) cancelBtn.style.display = 'none';
    cleanup(0, true);
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

  function pageId() {
    var href = location.href;
    var m = href.match(/\/file\/d\/([A-Za-z0-9_-]{25,})/) ||
            href.match(/(?:document|presentation|spreadsheets|forms|drawings)\/d\/([A-Za-z0-9_-]{25,})/) ||
            href.match(/[?&]id=([A-Za-z0-9_-]{25,})/) ||
            href.match(/\/d\/([A-Za-z0-9_-]{25,})/);
    return m ? m[1] : null;
  }

  function getPages(doc) {
    var imgs = [].slice.call(doc.querySelectorAll(IMG));
    if (!imgs.length) { throw new Error('no page images found yet'); }
    try {
      var first = imgs[0].parentElement;
      var cls = first.className;
      if (cls && !/\s/.test(cls)) {
        var ps = [].slice.call(first.parentElement.querySelectorAll(':scope > .' + CSS.escape(cls)));
        if (ps.length) return ps;
      }
    } catch (e) { /* fall through */ }
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

  async function captureFrom(doc) {
    setStatus('waiting for pages to render…');
    await waitFor(function () { return hasImages(doc); }, 45000,
      'the preview did not render any pages');
    var pages = getPages(doc);
    var total = pages.length;
    setStatus('capturing ' + total + ' page' + (total === 1 ? '' : 's') + '…');
    var out = [];
    for (var i = 0; i < total; i++) {
      if (cancelled) throw new Error('cancelled');
      var img = await waitImage(pages[i]);
      await sleep(80);
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error('page ' + (i + 1) + ' has no size');
      var c = doc.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0);
      out.push({ w: w, h: h, bytes: b64ToBytes(c.toDataURL('image/jpeg', 0.92).split(',')[1]) });
      setProgress(i + 1, total);
    }
    setStatus('building the PDF…');
    var blob = buildPdf(out);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = pdfName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setProgress(total, total);
    setStatus('Saved ' + pdfName() + ' · ' + total + ' pages');
    if (statusEl) statusEl.style.color = C.green;
    if (cancelBtn) cancelBtn.style.display = 'none';
    cleanup(0, true);
  }

  (async function main() {
    try {
      // 1) Page images already on screen: capture in place.
      if (hasImages(document)) {
        buildCornerPanel();
        setStatus('capturing the open preview…');
        startTicker();
        await captureFrom(document);
        return;
      }

      var id = pageId();
      if (!id) {
        throw new Error('No Drive file id in this page. Open the file link first, then click the bookmark.');
      }
      var base = window.__GDD_TEST_PREVIEW_BASE__ || 'https://drive.google.com';
      var previewUrl = base + '/file/d/' + id + '/preview';
      var isDrive = location.hostname === 'drive.google.com' || window.__GDD_TEST_DRIVE__ === true;

      if (!isDrive) {
        var w = window.open(previewUrl, '_blank');
        if (!w) {
          alert('Pop-ups are blocked. Enable them for this site, then click the bookmark again.');
        } else {
          alert('Preview opened in a new tab. Switch to it and click the bookmark there to capture.');
        }
        window.__GDD_RUNNING__ = false;
        return;
      }

      if (/\/preview/.test(location.pathname)) {
        buildCornerPanel();
        setStatus('the preview is still loading…');
        startTicker();
        await captureFrom(document);
        return;
      }

      // 2) Normal Drive page: load the preview inline and capture it.
      buildOverlay(previewUrl);
      startTicker();
      var frameDoc = null;
      try {
        frameDoc = await waitFor(function () {
          try {
            var d = iframeEl.contentDocument;
            return d && hasImages(d) ? d : null;
          } catch (e) { return null; }
        }, 45000, 'inline preview did not render');
      } catch (e) {
        // Embed refused or too slow: fall back to same-tab preview + one more click.
        if (cancelled) throw new Error('cancelled');
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        overlay.style.opacity = '0';
        setTimeout(function () { overlay.remove(); }, 300);
        alert('This page would not show the preview inline, so I will open it here instead. When it loads, click the bookmark once more to capture.');
        location.href = previewUrl;
        return;
      }
      await captureFrom(frameDoc);
    } catch (e) {
      fail(e);
    }
  })();
})();
