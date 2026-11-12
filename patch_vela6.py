#!/usr/bin/env python3
"""Fix: Beim Öffnen eines Chats werden manchmal alte Nachrichten gezeigt und neue fehlen.

Ursache: Ein bereits geladener Chat wurde beim Öffnen nur aus dem Zwischenspeicher gezeigt und nie mit dem Server
abgeglichen. Nachrichten, deren WebSocket-Ereignis verpasst wurde (Handy im Hintergrund, kurz offline), fehlten.
Nach einer Wiederverbindung wurde nur der gerade offene Chat neu geladen, alle anderen blieben veraltet.

Jetzt: Zwischengespeicherter Chat wird sofort gezeigt und im Hintergrund abgeglichen (neu zeichnen nur bei Änderung);
nach Wiederverbindung werden die Zwischenspeicher der anderen Chats verworfen; nach >15 s im Hintergrund wird der
offene Chat beim Zurückkehren abgeglichen.

    python patch_vela6.py      (oder alles zusammen: patch_all.py)
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EDITS = [
    ("Funktion refreshChat", "async function refreshChat(",
     ["export async function openChat(id, { keepHistory = false } = {}) {\n"],
     "// Gleicht einen bereits angezeigten Chat mit dem Server ab (verpasste WebSocket-Ereignisse nach Hintergrund/Offline)\n"
     "const refreshing = new Set();\n"
     "async function refreshChat(id) {\n"
     "  if (refreshing.has(id)) return;\n"
     "  refreshing.add(id);\n"
     "  const sig = () => (S.messages.get(id) || []).map((m) => `${m.id}:${m.read_at || ''}:${m.deleted_at || ''}`).join('|');\n"
     "  const before = sig();\n"
     "  try { await loadMessages(id); } catch { /* beim nächsten Öffnen erneut */ } finally { refreshing.delete(id); }\n"
     "  if (S.chat === id && sig() !== before) await renderMessages();\n"
     "}\n\n"
     "export async function openChat(id, { keepHistory = false } = {}) {\n"),
    ("Beim Öffnen mit dem Server abgleichen", "refreshChat(id); }",
     ["  else el.msgProgress.el.hidden = true;\n"],
     "  else { el.msgProgress.el.hidden = true; refreshChat(id); }   // Zwischenspeicher sofort zeigen, im Hintergrund abgleichen\n"),
    ("Nach Wiederverbindung alle Chats auffrischen", "refreshChat(S.chat); }",
     ["if (S.chat) loadMessages(S.chat).then(() => renderMessages()); }"],
     "for (const k of [...S.messages.keys()]) if (k !== S.chat) { S.messages.delete(k); S.hasMore.delete(k); } if (S.chat) refreshChat(S.chat); }"),
    ("Nach Rückkehr aus dem Hintergrund abgleichen", "let hiddenAt",
     ["document.addEventListener('visibilitychange', () => { if (!document.hidden && S.chat) markRead(S.chat); });\n"],
     "let hiddenAt = 0;\n"
     "document.addEventListener('visibilitychange', () => {\n"
     "  if (document.hidden) { hiddenAt = Date.now(); return; }\n"
     "  if (S.chat) { markRead(S.chat); if (Date.now() - hiddenAt > 15000) refreshChat(S.chat); }   // Handy lag im Hintergrund\n"
     "});\n"),
]


def main() -> None:
    path = ROOT / "static" / "js" / "app.js"
    if not path.exists():
        sys.exit("✗ static/js/app.js nicht gefunden")
    raw = path.read_bytes().decode("utf-8")
    eol = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    new, ok = text, True
    print("static/js/app.js")
    for desc, marker, olds, repl in EDITS:
        if marker in new:
            print(f"  = {desc} (schon vorhanden)")
            continue
        old = next((o for o in olds if new.count(o) == 1), None)
        if old is None:
            print(f"  ✗ {desc}: Einstiegspunkt nicht gefunden (gesucht: {olds[0].strip().splitlines()[0][:90]!r})")
            ok = False
            continue
        new = new.replace(old, repl, 1)
        print(f"  ✓ {desc}")
    if ok and new != text:
        shutil.copy2(path, path.with_suffix(".js.bak"))
        path.write_bytes(new.replace("\n", eol).encode("utf-8"))
    print("\nFertig." if ok else "\nMit Fehlern beendet (nichts geschrieben).")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
