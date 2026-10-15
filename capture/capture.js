/* GDrive Down capture bookmarklet.
   Runs entirely in your own browser on a Google Drive preview page:
   captures every rendered page, builds a PDF locally and downloads it.
   No server involved. Works for any file you can view, including
   private ones. */
(function () {
  'use strict';
  if (window.__GDD_RUNNING__) { alert('A capture is already running on this page.'); return; }
  window.__GDD_RUNNING__ = true;

  var IMG = 'img[src^="blob:"]';
  var cancelled = false;

  var hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#0a0d13;color:#eaf0f8;font:600 13px/1.5 system-ui,sans-serif;padding:10px 14px;border-radius:10px;border:1px solid rgba(62,213,163,.45);box-shadow:0 10px 30px rgba(0,0,0,.55);cursor:pointer;max-width:340px';
  hud.title = 'Click to cancel';
  hud.onclick = function () { cancelled = true; };
  document.body.appendChild(hud);
  function status(t) { hud.textContent = 'GDrive Down: ' + t; }
  function finish() { window.__GDD_RUNNING__ = false; }
  function fail(e) {
    status('stopped: ' + ((e && e.message) || e));
    setTimeout(function () { hud.remove(); }, 9000);
    finish();
  }
  status('scanning the preview…');

  function getPages() {
    var imgs = [].slice.call(document.querySelectorAll(IMG));
    if (!imgs.length) {
      throw new Error('No page images found. Open the file PREVIEW first, wait for page 1 to render, then click this bookmark again.');
    }
    try {
      var first = imgs[0].parentElement;
      var cls = first.className;
      if (cls && !/\s/.test(cls)) {
        var ps = [].slice.call(first.parentElement.querySelectorAll(':scope > .' + CSS.escape(cls)));
        if (ps.length) return ps;
      }
    } catch (e) { /* fall through */ }
    var seen = [];
    for (var i = 0; i < imgs.length; i++) {
      var p = imgs[i].parentElement;
      if (p && seen.indexOf(p) === -1) seen.push(p);
    }
    seen.sort(function (a, b) {
      return (a.getBoundingClientRect().top + window.scrollY) -
             (b.getBoundingClientRect().top + window.scrollY);
    });
    return seen;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitImage(page) {
    return new Promise(function (resolve, reject) {
      var img = page.querySelector(IMG);
      if (!img) {
        var obs = new MutationObserver(function () {
          var i = page.querySelector(IMG);
          if (i) { obs.disconnect(); page.scrollIntoView(); resolve(i); }
        });
        obs.observe(page, { childList: true, attributes: true, subtree: true });
        page.scrollIntoView();
        return;
      }
      page.scrollIntoView();
      if (img.complete && img.naturalWidth) { resolve(img); return; }
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('a page image failed to load')); };
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
    if (!name) name = 'gdrive-capture';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return name;
  }

  (async function main() {
    try {
      var pages = getPages();
      var total = pages.length;
      var out = [];
      for (var i = 0; i < total; i++) {
        if (cancelled) throw new Error('cancelled');
        status('capturing page ' + (i + 1) + ' of ' + total + '  (click to cancel)');
        var img = await waitImage(pages[i]);
        await sleep(120);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { throw new Error('page ' + (i + 1) + ' has no size'); }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0);
        var dataUrl = c.toDataURL('image/jpeg', 0.92);
        out.push({ w: w, h: h, bytes: b64ToBytes(dataUrl.split(',')[1]) });
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
    } catch (e) {
      fail(e);
    }
  })();
})();
