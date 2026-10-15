/* GDrive Down capture bookmarklet (v2).
   Runs entirely in your own browser. Open any Google Drive file link and
   click the bookmark: if the preview is not open yet, it opens one itself,
   then captures every rendered page and saves a PDF. No server involved.
   Works for any file you can view, including private ones. */
(function () {
  'use strict';
  if (window.__GDD_RUNNING__) { alert('A capture is already running on this page.'); return; }
  window.__GDD_RUNNING__ = true;

  var IMG = 'img[src^="blob:"]';
  var cancelled = false;
  var audioCtx = null;
  var droveWindow = null;

  var hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#0a0d13;color:#eaf0f8;font:600 13px/1.5 system-ui,sans-serif;padding:10px 14px;border-radius:10px;border:1px solid rgba(62,213,163,.45);box-shadow:0 10px 30px rgba(0,0,0,.55);cursor:pointer;max-width:360px';
  hud.title = 'Click to cancel';
  hud.onclick = function () { cancelled = true; };
  document.body.appendChild(hud);
  function status(t) { hud.textContent = 'GDrive Down: ' + t; }
  function finish() {
    window.__GDD_RUNNING__ = false;
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  }
  function fail(e) {
    status('stopped: ' + ((e && e.message) || e));
    setTimeout(function () { hud.remove(); }, 9000);
    finish();
  }
  status('scanning the page…');

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

  /* While driving a visible preview window, this tab sits in the
     background; a nearly silent audio node keeps its timers alive. */
  function keepAlive() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
    } catch (e) { /* not critical */ }
  }

  function getPages(doc) {
    var imgs = [].slice.call(doc.querySelectorAll(IMG));
    if (!imgs.length) {
      throw new Error('no page images found yet');
    }
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
    page.scrollIntoView();
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      var tickCount = 0;
      (function tick() {
        if (cancelled) { reject(new Error('cancelled')); return; }
        tickCount++;
        var img = page.querySelector(IMG);
        if (img && img.complete && img.naturalWidth) { resolve(img); return; }
        if (Date.now() - t0 > 20000) {
          reject(new Error('a page image failed to load'));
          return;
        }
        if (tickCount % 8 === 0) { try { page.scrollIntoView(); } catch (e) {} }
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

  /* Minimal JPEG-in-PDF writer: one /DCTDecode image per page. */
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
    for (var n = 0; n < chunks.length; n++) { merged.set(chunks[n], pos); pos += chunks[n].length; }
    return new Blob([merged], { type: 'application/pdf' });
  }

  function pdfName() {
    var name = (document.title || '').replace(/\s*-\s*Google (Drive|Docs|Slides|Sheets)\s*$/i, '').trim();
    if (!name || name === 'GDrive Down') {
      try { name = (droveWindow && droveWindow.document.title) || ''; } catch (e) { name = ''; }
      name = name.replace(/\s*-\s*Google (Drive|Docs|Slides|Sheets)\s*$/i, '').trim();
    }
    if (!name) name = 'gdrive-capture';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return name;
  }

  async function captureFrom(doc) {
    var pages = [];
    await waitFor(function () { return hasImages(doc); }, 60000,
      'the preview never rendered any pages');
    pages = getPages(doc);
    var total = pages.length;
    var out = [];
    for (var i = 0; i < total; i++) {
      if (cancelled) throw new Error('cancelled');
      status('capturing page ' + (i + 1) + ' of ' + total + '  (click to cancel)');
      var img = await waitImage(pages[i]);
      await sleep(100);
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error('page ' + (i + 1) + ' has no size');
      var c = doc.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0);
      out.push({ w: w, h: h, bytes: b64ToBytes(c.toDataURL('image/jpeg', 0.92).split(',')[1]) });
    }
    status('building the PDF (' + total + ' pages)…');
    var blob = buildPdf(out);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = pdfName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    status('done. PDF downloaded (' + total + ' pages).');
    setTimeout(function () { hud.remove(); }, 8000);
    finish();
  }

  (async function main() {
    try {
      // 1) Page images are visible right here: capture in place.
      if (hasImages(document)) {
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
        // Google Docs/Slides editors and other origins: a new tab is opened
        // and the bookmark is clicked there (cross-origin can't be driven).
        var w = window.open(previewUrl, '_blank');
        if (!w) {
          alert('Pop-ups are blocked. Enable them for this site, then click the bookmark again.');
        } else {
          alert('Preview opened in a new tab. Switch to it and click the bookmark there to capture.');
        }
        finish();
        return;
      }

      if (/\/preview/.test(location.pathname)) {
        // Already on a preview that just has not rendered yet.
        await waitFor(function () { return hasImages(document); }, 60000,
          'the preview is open but no pages rendered (is this a page-based document?)');
        await captureFrom(document);
        return;
      }

      // On a Drive page without a rendered preview: open one and drive it.
      status('opening the preview window…');
      var win2 = window.open(previewUrl, 'gdd_preview');
      if (!win2) {
        alert('Pop-ups are blocked, so I could not open the preview automatically. Press OK, the preview will open in this tab instead; click the bookmark once more after it loads.');
        location.href = previewUrl;
        finish();
        return;
      }
      droveWindow = win2;
      keepAlive();
      status('waiting for the preview to render…');
      var doc2 = await waitFor(function () {
        if (win2.closed) throw new Error('the preview window was closed');
        try { return win2.document && hasImages(win2.document) ? win2.document : null; }
        catch (e) { return null; }
      }, 60000, 'the preview never rendered any pages');
      await captureFrom(doc2);
    } catch (e) {
      fail(e);
    }
  })();
})();
