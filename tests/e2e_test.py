"""End-to-End-Test: zwei Nutzer im Browser (Desktop + Pixel 7) und Wiederherstellung auf einem iPhone 13.

Voraussetzung: Server läuft (python run.py) mit frischem data/-Ordner.
    pip install playwright && python -m playwright install chromium
    python tests/e2e_test.py
"""
import sys, time, re, sqlite3, os, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from app.security import totp_now
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE', 'https://localhost:8443')
OUT = os.environ.get('OUT', os.path.join(tempfile.gettempdir(), 'vela-shots'))
TMP = tempfile.mkdtemp()
os.makedirs(OUT, exist_ok=True)
DATA = os.environ.get('VELA_DATA_DIR', os.path.join(ROOT, 'data'))
DB = os.path.join(DATA, 'vela.db')
errors = []

def shot(page, name):
    page.screenshot(path=f'{OUT}/{name}.png')

def watch(page, who):
    page.on('console', lambda m: errors.append(f'[{who}] {m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'[{who}] PAGEERROR: {e}'))

def wait_next_step(secret_used_at):
    # TOTP-Schritt muss neuer sein als der zuletzt verwendete (Replay-Schutz)
    step = int(time.time() // 30)
    while int(time.time() // 30) <= secret_used_at:
        time.sleep(1)

def register(page, user, bits='2048 Bit'):
    page.goto(BASE)
    page.get_by_role('button', name='Neues Konto erstellen').click()
    page.fill('input[name=username]', user)
    page.fill('input[name=email]', f'{user}@example.org')
    page.fill('input[name=password]', 'correct horse battery')
    page.fill('input[name=password2]', 'correct horse battery')
    page.get_by_role('radio', name=bits).click()
    shot(page, f'reg1_{user}')
    page.get_by_role('button', name='Weiter').click()
    page.wait_for_selector('.recovery-key', timeout=120000)
    rk = '-'.join(page.locator('.recovery-key span').all_text_contents())
    shot(page, f'reg3_{user}')
    page.check('#rk-ok')
    page.get_by_role('button', name='Weiter').click()
    page.wait_for_selector('img.qr')
    shot(page, f'reg4_{user}')
    secret = page.locator('code.secret').text_content().replace(' ', '')
    page.fill('input[name=code]', totp_now(secret))
    page.get_by_role('button', name='Bestätigen & loslegen').click()
    page.wait_for_selector('.app-shell', timeout=20000)
    return rk, secret, int(time.time() // 30)

with sync_playwright() as p:
    b = p.chromium.launch()
    A = b.new_context(ignore_https_errors=True, viewport={'width': 1280, 'height': 800}, permissions=['clipboard-read', 'clipboard-write'])
    pixel = p.devices['Pixel 7']
    B = b.new_context(ignore_https_errors=True, **pixel)
    a = A.new_page(); bb = B.new_page()
    watch(a, 'alice'); watch(bb, 'bob')

    a_rk, a_secret, a_step = register(a, 'alice')
    shot(a, 'a_empty')
    b_rk, b_secret, b_step = register(bb, 'bob', '3072 Bit')
    shot(bb, 'b_empty')
    print('registered')

    # Kontaktanfrage
    a.get_by_role('button', name='Kontakt hinzufügen').first.click()
    a.fill('dialog input[name=contact]', 'bob')
    a.get_by_role('button', name='Anfrage senden').click()
    a.wait_for_selector('text=Anfrage gesendet – wartet auf Annahme')
    bb.get_by_role('tab', name=re.compile('Anfragen')).click()
    bb.get_by_role('button', name='Annehmen').click()
    bb.wait_for_selector('.chat-row >> text=alice')
    print('contact accepted')

    # Alice öffnet Chat und schreibt
    a.wait_for_selector('.chat-row:not(.request) >> text=bob', timeout=10000)
    a.wait_for_selector('.snackbar >> text=angenommen')
    a.locator('.chat-row:not(.request)', has_text='bob').locator('.row-inner').click()
    a.fill('.composer-input', 'Hallo Bob! 🔐 Das hier ist Ende-zu-Ende verschlüsselt: https://example.org')
    a.keyboard.press('Enter')
    a.wait_for_selector('.msg-row.mine >> text=Hallo Bob!')

    # Bob sieht Nachricht in der Liste und im Chat
    bb.wait_for_selector('.row-sub >> text=Hallo Bob!', timeout=10000)
    shot(bb, 'b_list')
    bb.locator('.chat-row', has_text='alice').locator('.row-inner').click()
    bb.wait_for_selector('.msg-row.theirs >> text=Hallo Bob!')
    # Tipp-Indikator: Bob tippt, Alice sieht es
    bb.fill('.composer-input', 'Hi Alice, angekommen')
    a.wait_for_selector('.chat-title .status.typing', timeout=5000)
    print('typing indicator ok')
    bb.locator('.send-btn').click()
    a.wait_for_selector('.msg-row.theirs >> text=Hi Alice, angekommen')
    # Lesebestätigung bei Alice
    a.wait_for_selector('.msg-row.mine .tick.read', timeout=5000)
    print('read receipt ok')

    # Bild (groß -> Kompression)
    img_page = b.new_page(viewport={'width': 3000, 'height': 2000})
    img_page.set_content('<body style="margin:0;background:linear-gradient(135deg,#0b6,#06b,#b06);height:100vh"><h1 style="font:bold 300px sans-serif;color:white;padding:200px">Vela</h1></body>')
    img_page.screenshot(path=os.path.join(TMP, 'big.png')); img_page.close()
    a.evaluate("document.querySelector('.composer input[type=file]').dataset.mode='image'")
    a.set_input_files('.composer input[type=file]', os.path.join(TMP, 'big.png'))
    a.wait_for_selector('.msg-row.mine .media img', timeout=30000)
    bb.wait_for_selector('.msg-row.theirs .media.loaded img', timeout=30000)
    print('image ok')

    # Datei
    open(os.path.join(TMP, 'notiz.txt'), 'w').write('Geheime Notiz ' * 1000)
    a.evaluate("document.querySelector('.composer input[type=file]').dataset.mode='file'")
    a.set_input_files('.composer input[type=file]', os.path.join(TMP, 'notiz.txt'))
    bb.wait_for_selector('.file-card >> text=notiz.txt', timeout=20000)
    with bb.expect_download() as dl:
        bb.locator('.file-card .icon-btn').click()
    path = dl.value.path()
    assert open(path).read() == 'Geheime Notiz ' * 1000, 'file mismatch'
    print('file ok')

    # Einmalansicht-Text
    a.locator('.vo-toggle').click()
    a.fill('.composer-input', 'Diese Nachricht zerstört sich selbst')
    a.keyboard.press('Enter')
    a.wait_for_selector('.msg-row.mine >> text=Einmalansicht gesendet')
    bb.wait_for_selector('.vo-open', timeout=10000)
    shot(bb, 'b_chat')
    bb.locator('.vo-open').click()
    bb.locator('dialog[open] .btn.filled').click()
    bb.wait_for_selector('.viewer >> text=Diese Nachricht zerstört sich selbst')
    shot(bb, 'b_viewonce')
    con = sqlite3.connect(DB)
    row = con.execute("SELECT envelope, viewed_at FROM messages WHERE view_once=1").fetchone()
    assert row[0] is None and row[1], 'view-once not deleted on server'
    bb.locator('.viewer .icon-btn[aria-label=Schließen]').click()
    bb.wait_for_selector('.msg-row.theirs >> text=Einmalansicht · geöffnet')
    a.wait_for_selector('.msg-row.mine >> text=Einmalansicht · geöffnet', timeout=5000)
    print('view-once ok')

    # Reaktion über Rechtsklick-Menü (Desktop)
    a.locator('.msg-row.theirs .bubble', has_text='Hi Alice').click(button='right')
    a.locator('.reaction-pick', has_text='❤️').click()
    bb.wait_for_selector('.msg-row.mine .reaction >> text=❤️', timeout=10000)
    print('reaction ok')

    # Server speichert nur Ciphertext
    envs = [r[0] for r in con.execute("SELECT envelope FROM messages WHERE envelope IS NOT NULL")]
    assert envs and not any('Hallo Bob' in e or 'Hi Alice' in e for e in envs), 'plaintext on server!'
    blobs = os.listdir(os.path.join(DATA, 'uploads'))
    for f in blobs:
        assert b'Geheime Notiz' not in open(os.path.join(DATA, 'uploads', f), 'rb').read()
    print('server holds ciphertext only:', len(envs), 'envelopes,', len(blobs), 'files')

    shot(a, 'a_chat')
    # Bob zurück zur Liste (History back), dann wischen zum Archivieren (Touch-Pointer-Events)
    bb.go_back()
    bb.wait_for_selector('.app-shell:not(.chat-open)')
    time.sleep(0.4)
    bb.evaluate("""() => {
      const el = document.querySelector('.chat-row');
      const r = el.getBoundingClientRect(); const y = r.top + r.height/2; let x = r.right - 30;
      const ev = (t, x) => el.dispatchEvent(new PointerEvent(t, {bubbles:true, pointerId:7, pointerType:'touch', isPrimary:true, clientX:x, clientY:y, button:0}));
      ev('pointerdown', x);
      for (let i=1;i<=12;i++) ev('pointermove', x - i*25);
      ev('pointerup', x - 300);
    }""")
    bb.wait_for_selector('.snackbar >> text=archiviert', timeout=3000)
    bb.get_by_role('tab', name=re.compile('Archiv')).click()
    bb.wait_for_selector('.chat-row >> text=alice')
    print('swipe archive ok')
    shot(bb, 'b_archive')

    # Einstellungen + Dark Mode Screenshots
    a.get_by_role('button', name='Einstellungen').click()
    a.wait_for_selector('.settings-page.open')
    time.sleep(0.4)
    shot(a, 'a_settings')
    a.get_by_role('radio', name='Dunkel').click()
    a.get_by_role('button', name='Zurück').first.click()
    time.sleep(0.4)
    shot(a, 'a_chat_dark')

    # Sicherheitsnummer bei beiden identisch
    a.get_by_role('button', name='Sicherheitsnummer').click()
    sn_a = a.locator('.safety-grid').inner_text()
    shot(a, 'a_verify')
    a.get_by_role('button', name='Als verifiziert markieren').click()
    bb.locator('.chat-row', has_text='alice').locator('.row-inner').click()
    bb.get_by_role('button', name='Sicherheitsnummer').click()
    sn_b = bb.locator('.safety-grid').inner_text()
    assert sn_a.split() == sn_b.split(), (sn_a, sn_b)
    print('safety numbers match')
    bb.keyboard.press('Escape')

    # Neues Gerät für Alice: Anmeldung + Schlüssel aus Backup
    print('waiting for next TOTP step …')
    wait_next_step(a_step)
    C = b.new_context(ignore_https_errors=True, **p.devices['iPhone 13'])
    c = C.new_page(); watch(c, 'alice-ios')
    c.goto(BASE)
    c.fill('input[name=username]', 'alice')
    c.fill('input[name=password]', 'correct horse battery')
    c.fill('input[name=code]', totp_now(a_secret))
    shot(c, 'c_login')
    c.get_by_role('button', name='Anmelden').click()
    c.wait_for_selector('text=Neues Gerät')
    c.fill('textarea.rk-input', a_rk.lower().replace('-', ' '))
    c.get_by_role('button', name='Schlüssel entsperren').click()
    c.wait_for_selector('.app-shell')
    c.locator('.chat-row', has_text='bob').locator('.row-inner').click()
    c.wait_for_selector('.msg-row.mine >> text=Hallo Bob!')
    c.wait_for_selector('.msg-row.theirs >> text=Hi Alice, angekommen')
    shot(c, 'c_chat_ios')
    print('new device restore ok')
    b.close()

print('\n'.join(errors) if errors else 'Keine Konsolenfehler')
print('ALLE TESTS BESTANDEN')
