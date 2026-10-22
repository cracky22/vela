"""End-to-End-Test Gruppen & Chat-Funktionen: drei Nutzer (Desktop, Pixel 7, Desktop).

Bob und Carol sind KEINE Kontakte voneinander – ihre Schlüssel erhalten sie über die Gruppe.
Voraussetzung: Server läuft (python run.py) mit frischem data/-Ordner.
    python tests/e2e_groups.py
"""
import os
import re
import sqlite3
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from app.security import totp_now  # noqa: E402
from playwright.sync_api import expect, sync_playwright  # noqa: E402

BASE = os.environ.get('BASE', 'https://localhost:8443')
OUT = os.environ.get('OUT', os.path.join(tempfile.gettempdir(), 'vela-shots'))
DATA = os.environ.get('VELA_DATA_DIR', os.path.join(ROOT, 'data'))
os.makedirs(OUT, exist_ok=True)
TMP = tempfile.mkdtemp()
errors = []


def shot(page, name):
    page.screenshot(path=f'{OUT}/{name}.png')


def watch(page, who):
    page.on('console', lambda m: errors.append(f'[{who}] {m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(f'[{who}] PAGEERROR: {e}'))


def register(page, user):
    page.goto(BASE)
    page.get_by_role('button', name='Neues Konto erstellen').click()
    page.fill('input[name=username]', user)
    page.fill('input[name=email]', f'{user}@example.org')
    page.fill('input[name=password]', 'correct horse battery')
    page.fill('input[name=password2]', 'correct horse battery')
    page.get_by_role('radio', name='2048 Bit').click()
    page.get_by_role('button', name='Weiter').click()
    page.wait_for_selector('.recovery-key', timeout=120000)
    page.check('#rk-ok')
    page.get_by_role('button', name='Weiter').click()
    page.wait_for_selector('img.qr')
    secret = page.locator('code.secret').text_content().replace(' ', '')
    page.fill('input[name=code]', totp_now(secret))
    page.get_by_role('button', name='Bestätigen & loslegen').click()
    page.wait_for_selector('.app-shell', timeout=20000)


def befriend(a, b, b_name):
    a.locator('.chat-list, .list-empty').first.wait_for()
    a.locator('.view[data-view=chats] .top-bar').get_by_role('button', name='Kontakt hinzufügen').click()
    a.fill('dialog input[name=contact]', b_name)
    a.get_by_role('button', name='Anfrage senden').click()
    b.get_by_role('tab', name=re.compile('Anfragen')).click()
    b.get_by_role('button', name='Annehmen').first.click()
    b.wait_for_timeout(500)


def row(page, title):
    return page.locator(f'.chat-row:has(.row-name:text-is("{title}")) .row-inner')


def open_chat(page, title):
    row(page, title).click()
    page.wait_for_selector('.composer-input')


def send(page, text):
    page.fill('.composer-input', text)
    page.locator('.send-btn').click()


with sync_playwright() as p:
    br = p.chromium.launch()
    A = br.new_context(ignore_https_errors=True, viewport={'width': 1280, 'height': 820})
    B = br.new_context(ignore_https_errors=True, **p.devices['Pixel 7'])
    C = br.new_context(ignore_https_errors=True, viewport={'width': 1100, 'height': 760})
    a, b, c = A.new_page(), B.new_page(), C.new_page()
    watch(a, 'anna'); watch(b, 'ben'); watch(c, 'cleo')
    register(a, 'anna'); register(b, 'ben'); register(c, 'cleo')
    befriend(a, b, 'ben'); befriend(a, c, 'cleo')
    a.wait_for_selector('.chat-row:not(.request) >> text=ben')
    a.wait_for_selector('.chat-row:not(.request) >> text=cleo')
    print('contacts ok')

    # Online-Status
    a.get_by_role('tab', name=re.compile('Alle')).click()
    a.wait_for_selector('.chat-row[data-id] .row-avatar.online', timeout=10000)
    print('online status ok')

    # Gruppe erstellen
    a.locator('.view[data-view=chats] .top-bar').get_by_role('button', name='Neue Gruppe').click()
    a.fill('dialog input[name=gname]', 'Projekt Vela')
    a.locator('dialog .pick-row', has_text='ben').click()
    a.locator('dialog .pick-row', has_text='cleo').click()
    a.screenshot(path=f'{OUT}/g_create.png')
    a.get_by_role('button', name='Gruppe erstellen').click()
    a.wait_for_selector('.chat-bar >> text=Projekt Vela')
    a.wait_for_selector('.sys-row >> text=die Gruppe „Projekt Vela“ erstellt')
    print('group created')

    b.get_by_role('tab', name=re.compile('Alle')).click()
    b.wait_for_selector('.chat-row >> text=Projekt Vela', timeout=10000)
    c.wait_for_selector('.chat-row >> text=Projekt Vela', timeout=10000)

    send(a, 'Willkommen im Team! @ben und @cleo – alles Ende-zu-Ende-verschlüsselt 🔐')
    open_chat(b, 'Projekt Vela'); open_chat(c, 'Projekt Vela')
    b.wait_for_selector('.msg-row.theirs >> text=Willkommen im Team!')
    c.wait_for_selector('.msg-row.theirs >> text=Willkommen im Team!')
    # Bob und Cleo kennen sich nicht – trotzdem entschlüsselbar (Schlüssel über die Gruppe)
    send(b, 'Hi Cleo, wir kennen uns noch nicht 👋')
    c.wait_for_selector('.msg-row.theirs >> text=wir kennen uns noch nicht')
    expect(c.locator('.msg-row.theirs .sender', has_text='ben')).to_have_count(1)
    print('group messages E2E ok (non-contacts)')

    # Lesebestätigung in der Gruppe: beide haben gelesen -> blaue Haken bei Anna
    a.wait_for_selector('.msg-row.mine .tick.read', timeout=10000)
    print('group read receipts ok')

    # Tipp-Anzeige
    c.fill('.composer-input', 'Ich tippe gerade …')
    a.wait_for_selector('.typing-slot.show >> text=cleo', timeout=5000)
    a.wait_for_selector('.chat-title .status.typing >> text=cleo schreibt', timeout=5000)
    a.screenshot(path=f'{OUT}/g_typing.png')
    c.locator('.send-btn').click()
    a.wait_for_selector('.msg-row.theirs >> text=Ich tippe gerade')
    print('group typing ok')

    # Bearbeiten (Pfeil hoch im leeren Feld)
    a.locator('.composer-input').click()
    a.keyboard.press('ArrowUp')
    a.wait_for_selector('.reply-preview.editing')
    a.fill('.composer-input', 'Willkommen im Team, ihr zwei! (bearbeitet)')
    a.keyboard.press('Enter')
    b.wait_for_selector('.msg-row.theirs >> text=Willkommen im Team, ihr zwei!', timeout=10000)
    b.wait_for_selector('.msg-row.theirs .edited')
    print('edit ok')

    # Bild in der Gruppe
    img = br.new_page(viewport={'width': 1200, 'height': 800})
    img.set_content('<body style="margin:0;background:linear-gradient(120deg,#ffb347,#ff5f6d,#845ec2);height:100vh;display:grid;place-items:center"><h1 style="font:700 140px sans-serif;color:#fff">Team</h1></body>')
    img.screenshot(path=os.path.join(TMP, 'team.png')); img.close()
    a.evaluate("document.querySelector('.composer input[type=file]').dataset.mode='image'")
    a.set_input_files('.composer input[type=file]', os.path.join(TMP, 'team.png'))
    b.wait_for_selector('.msg-row.theirs .media.loaded img', timeout=30000)
    c.wait_for_selector('.msg-row.theirs .media.loaded img', timeout=30000)
    print('group image ok')

    # Suche im Chat
    a.locator('.chat-bar').get_by_role('button', name='In Chat suchen').click()
    a.fill('.chat-search-input', 'kennen')
    a.wait_for_selector('.msg-row.search-current')
    expect(a.locator('.search-count')).to_have_text('1/1')
    a.screenshot(path=f'{OUT}/g_search.png')
    a.keyboard.press('Escape')
    a.wait_for_selector('.chat-bar .chat-title')
    print('search ok')

    # Weiterleiten: Ben leitet Annas Nachricht in seinen Einzelchat mit Anna weiter
    b.locator('.msg-row.theirs .bubble', has_text='Willkommen im Team').first.click(button='right')
    b.get_by_role('menuitem', name='Weiterleiten').click()
    b.locator('dialog .pick-row', has_text='anna').click()
    b.locator('dialog').get_by_role('button', name='Senden').click()
    b.wait_for_selector('.snackbar >> text=weitergeleitet')
    row(a, 'ben').click()
    a.wait_for_selector('.msg-row.theirs .fwd-label')
    print('forward ok')

    # Verschwindende Nachrichten in der Gruppe
    row(a, 'Projekt Vela').click()
    a.locator('.chat-bar').get_by_role('button', name='Mehr').click()
    a.get_by_role('menuitem', name='Verschwindende Nachrichten').click()
    a.get_by_role('radio', name='24 Stunden').click()
    a.get_by_role('button', name='Übernehmen').click()
    b.wait_for_selector('.sys-row >> text=verschwindende Nachrichten aktiviert (24 Stunden)', timeout=10000)
    con = sqlite3.connect(os.path.join(DATA, 'vela.db'))
    print('ttl ok')

    # Gruppeninfo: Cleo zum Admin machen, dann entfernen
    a.locator('.chat-bar .chat-title').click()
    a.wait_for_selector('.side-panel.open')
    time.sleep(0.4)
    a.screenshot(path=f'{OUT}/g_info.png')
    a.locator('.side-panel .member-row', has_text='cleo').click()
    a.get_by_role('menuitem', name='Zum Admin machen').click()
    c.wait_for_selector('.sys-row >> text=bist jetzt Admin', timeout=10000)
    a.wait_for_selector('.side-panel .member-row:has-text("cleo") .role-chip')
    a.locator('.side-panel .member-row', has_text='cleo').click()
    a.get_by_role('menuitem', name='Aus Gruppe entfernen').click()
    a.locator('dialog').get_by_role('button', name='Entfernen').click()
    c.wait_for_selector('.snackbar >> text=nicht mehr Mitglied', timeout=10000)
    expect(c.locator('.chat-row', has_text='Projekt Vela')).to_have_count(0)
    b.wait_for_selector('.sys-row >> text=cleo entfernt', timeout=10000)
    a.locator('.side-panel').get_by_role('button', name='Schließen').click()
    print('admin & remove ok')

    # Nach dem Entfernen: neue Nachricht ist nicht mehr für Cleo verschlüsselt
    send(a, 'Nur noch für Ben')
    b.wait_for_selector('.msg-row.theirs >> text=Nur noch für Ben')
    cleo_id = con.execute("SELECT id FROM users WHERE username='cleo'").fetchone()[0]
    env = con.execute("SELECT envelope FROM group_messages WHERE envelope IS NOT NULL ORDER BY created_at DESC LIMIT 1").fetchone()[0]
    assert cleo_id not in env, 'removed member still in envelope'
    envs = [r[0] for r in con.execute("SELECT envelope FROM group_messages WHERE envelope IS NOT NULL")]
    assert envs and not any('Willkommen' in e or 'kennen' in e for e in envs), 'plaintext on server!'
    exp = con.execute("SELECT expires_at - created_at FROM group_messages WHERE envelope IS NOT NULL ORDER BY created_at DESC LIMIT 1").fetchone()[0]
    assert abs(exp - 86_400_000) < 5000, exp
    print('server: ciphertext only, removed member excluded, ttl applied')

    # Admin löscht Nachricht für alle
    b.wait_for_timeout(300)
    a.locator('.msg-row.theirs .bubble', has_text='wir kennen uns noch nicht').click(button='right')
    a.get_by_role('menuitem', name='Für alle löschen (Admin)').click()
    a.locator('dialog').get_by_role('button', name='Löschen').click()
    b.wait_for_selector('.msg-row.mine .tombstone, .msg-row.mine .bubble.tombstone', timeout=10000)
    print('admin delete ok')

    # Gruppe verlassen (Ben)
    b.locator('.chat-bar').get_by_role('button', name='Mehr').click()
    b.get_by_role('menuitem', name='Gruppe verlassen').click()
    b.locator('dialog').get_by_role('button', name='Verlassen').click()
    a.wait_for_selector('.sys-row >> text=ben hat die Gruppe verlassen', timeout=10000)
    print('leave ok')

    row(a, 'ben').click()
    time.sleep(0.5)
    a.screenshot(path=f'{OUT}/g_dm_forward.png')
    row(a, 'Projekt Vela').click()
    time.sleep(0.5)
    a.screenshot(path=f'{OUT}/g_chat.png')
    row(b, 'anna').click()
    time.sleep(0.5)
    b.screenshot(path=f'{OUT}/g_mobile_dm.png')
    br.close()

errs = [e for e in errors if 'status of 4' not in e]
print('\n'.join(errs) if errs else 'Keine Konsolenfehler')
print('ALLE GRUPPENTESTS BESTANDEN')
