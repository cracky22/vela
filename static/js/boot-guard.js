// Start-Wächter: Bleibt die Ladeanzeige länger als ein paar Sekunden stehen, wird angezeigt, WARUM die App nicht
// startet (fehlende Datei, Syntaxfehler, falscher Dateityp …), statt endlos zu laden. Klassisches Skript, wird vor
// app.js geladen. Enthält keinen Inline-Code (Content-Security-Policy).
(function () {
  var WAIT_MS = 8000;
  var errors = [];
  var entry = new URL('app.js', document.currentScript.src).href;
  var short = function (u) { return String(u).split('/').slice(-3).join('/'); };
  window.addEventListener('error', function (e) { errors.push((e.message || 'Fehler') + (e.filename ? ' (' + short(e.filename) + ':' + e.lineno + ')' : '')); });
  window.addEventListener('unhandledrejection', function (e) { errors.push(String((e.reason && e.reason.message) || e.reason)); });

  function parseImports(src) {
    var out = [], m;
    var re = /(?:^|[\n;])\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
    while ((m = re.exec(src))) { var s = m[1] || m[2]; if (s && s.charAt(0) === '.') out.push(s); }
    return out;
  }

  async function diagnose() {
    var seen = {}, order = [], problems = [];
    async function visit(url) {
      if (seen[url]) return;
      seen[url] = true;
      var res;
      try { res = await fetch(url, { cache: 'no-store' }); } catch (e) { problems.push(short(url) + ': nicht erreichbar'); return; }
      var type = (res.headers.get('content-type') || '').split(';')[0];
      if (!res.ok) { problems.push(short(url) + ': HTTP ' + res.status); return; }
      if (!/javascript|ecmascript/.test(type)) { problems.push(short(url) + ': keine JavaScript-Datei (' + (type || 'unbekannt') + ') – fehlt die Datei?'); return; }
      var deps = parseImports(await res.text());
      for (var i = 0; i < deps.length; i++) await visit(new URL(deps[i], url).href);
      order.push(url);
    }
    await visit(entry);
    if (!problems.length) {            // alle Dateien da -> die Module einzeln laden, das erste fehlerhafte benennen
      for (var i = 0; i < order.length; i++) {
        try { await import(order[i]); } catch (e) { problems.push(short(order[i]) + ': ' + (e && e.message)); break; }
      }
    }
    return problems;
  }

  function el(tag, text, css) {
    var e = document.createElement(tag);
    if (text) e.textContent = text;
    if (css) for (var k in css) e.style[k] = css[k];
    return e;
  }

  function show(problems) {
    var root = document.getElementById('app');
    if (!root || !root.querySelector('.boot')) return;          // App ist inzwischen gestartet
    var box = el('div', null, { maxWidth: '560px', margin: '12vh auto 0', padding: '0 20px', fontFamily: 'system-ui, sans-serif', color: 'inherit' });
    box.append(el('h1', 'Vela konnte nicht gestartet werden', { fontSize: '22px', margin: '0 0 10px' }));
    box.append(el('p', problems.length ? 'Gefunden:' : 'Es wurde kein Fehler gefunden - vielleicht ist die Verbindung nur sehr langsam.', { margin: '0 0 8px' }));
    var pre = el('pre', problems.concat(errors.slice(-3)).join('\n') || '–', { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px', padding: '12px', borderRadius: '12px', background: 'rgba(127,127,127,.15)' });
    box.append(pre);
    var row = el('div', null, { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '14px' });
    var b1 = el('button', 'Neu laden', { padding: '10px 18px', borderRadius: '20px', border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' });
    b1.onclick = function () { location.reload(); };
    var b2 = el('button', 'Zwischenspeicher leeren und neu laden', { padding: '10px 18px', borderRadius: '20px', border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' });
    b2.onclick = async function () {
      try { var regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(function (r) { return r.unregister(); })); } catch (e) { /* ok */ }
      try { var keys = await caches.keys(); await Promise.all(keys.map(function (k) { return caches.delete(k); })); } catch (e) { /* ok */ }
      location.reload();
    };
    row.append(b1, b2);
    box.append(row, el('p', 'Diesen Text bitte dem Administrator schicken.', { fontSize: '13px', opacity: '.7', marginTop: '14px' }));
    root.replaceChildren(box);
  }

  setTimeout(function () {
    var root = document.getElementById('app');
    if (root && root.querySelector('.boot')) diagnose().then(show).catch(function (e) { show(['Prüfung fehlgeschlagen: ' + e.message]); });
  }, WAIT_MS);
})();