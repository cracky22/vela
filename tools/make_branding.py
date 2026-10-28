#!/usr/bin/env python3
"""Erzeugt Icon (SVG + PNGs) und das Farbschema (theme.css) aus der Basisfarbe #ab6b11.
Aufruf (im Projektordner):  python tools/make_branding.py   (benötigt: pip install cairosvg materialyoucolor)
"""
from __future__ import annotations
import re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
SEED = 0xFFAB6B11
BG, G1, G2 = "#1A1007", "#FFC56E", "#AB6B11"      # Hintergrund, Verlauf hell -> Marke

DOTS = ('<rect x="294" y="120" width="20" height="20" rx="4.4"/><rect x="294" y="144" width="20" height="20" rx="4.4"/><rect x="294" y="168" width="20" height="20" rx="4.4"/><rect x="294" y="192" width="20" height="20" rx="4.4"/><rect x="294" y="216" width="20" height="20" rx="4.4"/><rect x="294" y="240" width="20" height="20" rx="4.4"/><rect x="294" y="264" width="20" height="20" rx="4.4"/><rect x="294" y="288" width="20" height="20" rx="4.4"/><rect x="294" y="312" width="20" height="20" rx="4.4"/>'
        '<rect x="319" y="121" width="18" height="18" rx="4"/><rect x="319" y="145" width="18" height="18" rx="4"/><rect x="319" y="169" width="18" height="18" rx="4"/><rect x="319" y="193" width="18" height="18" rx="4"/><rect x="319" y="217" width="18" height="18" rx="4"/><rect x="319" y="241" width="18" height="18" rx="4"/><rect x="319" y="265" width="18" height="18" rx="4"/><rect x="319" y="289" width="18" height="18" rx="4"/><rect x="319" y="313" width="18" height="18" rx="4"/>'
        '<rect x="344.5" y="122.5" width="15" height="15" rx="3.3"/><rect x="344.5" y="146.5" width="15" height="15" rx="3.3"/><rect x="344.5" y="194.5" width="15" height="15" rx="3.3"/><rect x="344.5" y="218.5" width="15" height="15" rx="3.3"/><rect x="344.5" y="242.5" width="15" height="15" rx="3.3"/><rect x="344.5" y="266.5" width="15" height="15" rx="3.3"/><rect x="344.5" y="314.5" width="15" height="15" rx="3.3"/>'
        '<rect x="370" y="124" width="12" height="12" rx="2.6"/><rect x="370" y="172" width="12" height="12" rx="2.6"/><rect x="370" y="220" width="12" height="12" rx="2.6"/><rect x="370" y="244" width="12" height="12" rx="2.6"/><rect x="370" y="292" width="12" height="12" rx="2.6"/>'
        '<rect x="395.5" y="149.5" width="9" height="9" rx="2"/><rect x="395.5" y="197.5" width="9" height="9" rx="2"/><rect x="395.5" y="269.5" width="9" height="9" rx="2"/>'
        '<rect x="420.5" y="246.5" width="7" height="7" rx="1.5" opacity="0.55"/><rect x="445.5" y="151.5" width="5" height="5" rx="1.5" opacity="0.35"/><rect x="445.5" y="271.5" width="5" height="5" rx="1.5" opacity="0.35"/>')
BUBBLE = '<path clip-path="url(#c)" d="M180,118H332A104,104 0 0 1 436,222V236A104,104 0 0 1 332,340H206C190,368 146,394 78,398C104,380 76,350 76,236V222A104,104 0 0 1 180,118Z"/>'
CIRCLES = '<circle cx="140" cy="229" r="17"/><circle cx="190" cy="229" r="17"/><circle cx="240" cy="229" r="17"/>'
DEFS = (f'<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="76" y1="118" x2="436" y2="398"><stop offset="0" stop-color="{G1}"/><stop offset="1" stop-color="{G2}"/></linearGradient>'
        '<clipPath id="c"><rect width="292" height="512"/></clipPath></defs>')


def icon_svg(scale: float = 1.0, rounded: bool = True) -> str:
    rx = ' rx="112"' if rounded else ""
    t = f'translate(-4,-6)' if scale == 1.0 else f'translate({256 - 256 * scale - 4 * scale},{256 - 256 * scale - 6 * scale}) scale({scale})'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">{DEFS}<rect width="512" height="512"{rx} fill="{BG}"/>'
            f'<g transform="{t}" fill="url(#g)">{BUBBLE}{DOTS}<g fill="{BG}">{CIRCLES}</g></g></svg>\n')


def badge_svg() -> str:   # einfarbig weiß, Punkte ausgestanzt (Android-Statusleiste)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><clipPath id="c"><rect width="292" height="512"/></clipPath>'
            f'<mask id="m"><rect width="512" height="512" fill="white"/><g fill="black" transform="translate(-4,-6)">{CIRCLES}</g></mask></defs>'
            f'<g transform="translate(-4,-6)" fill="white" mask="url(#m)">{BUBBLE}{DOTS}</g></svg>')


def hexs(i: int) -> str:
    return "#%06x" % (i & 0xFFFFFF)


def theme_css() -> str:
    from materialyoucolor.hct import Hct
    from materialyoucolor.scheme.scheme_fidelity import SchemeFidelity
    from materialyoucolor.dynamiccolor.material_dynamic_colors import MaterialDynamicColors as M
    names = {"primary": "primary", "onPrimary": "on-primary", "primaryContainer": "primary-container", "onPrimaryContainer": "on-primary-container",
             "secondary": "secondary", "onSecondary": "on-secondary", "secondaryContainer": "secondary-container", "onSecondaryContainer": "on-secondary-container",
             "tertiary": "tertiary", "onTertiary": "on-tertiary", "tertiaryContainer": "tertiary-container", "onTertiaryContainer": "on-tertiary-container",
             "error": "error", "onError": "on-error", "errorContainer": "error-container", "onErrorContainer": "on-error-container",
             "surface": "surface", "surfaceDim": "surface-dim", "surfaceBright": "surface-bright",
             "surfaceContainerLowest": "surface-container-lowest", "surfaceContainerLow": "surface-container-low", "surfaceContainer": "surface-container",
             "surfaceContainerHigh": "surface-container-high", "surfaceContainerHighest": "surface-container-highest",
             "onSurface": "on-surface", "onSurfaceVariant": "on-surface-variant", "outline": "outline", "outlineVariant": "outline-variant",
             "inverseSurface": "inverse-surface", "inverseOnSurface": "inverse-on-surface", "inversePrimary": "inverse-primary"}
    seed = Hct.from_int(SEED)
    blocks = {}
    for dark in (False, True):
        s = SchemeFidelity(seed, dark, 0.0)
        vals = {css: hexs(getattr(M, k).get_hct(s).to_int()) for k, css in names.items()}
        warn = ("--warn-container: #5a4600; --on-warn-container: #ffe9a8;" if dark else "--warn-container: #ffe9a8; --on-warn-container: #2a2000;")
        blocks[dark] = "  " + "; ".join(f"--{k}: {v}" for k, v in vals.items()) + ";\n  " + warn + "\n"
    light, dark = blocks[False], blocks[True]
    return ("/* Vela-Farbschema (Material 3), erzeugt aus der Markenfarbe #ab6b11 mit tools/make_branding.py.\n"
            "   Wird NACH app.css geladen und überschreibt nur die Farbrollen. Zum Zurücksetzen den <link> entfernen. */\n"
            f":root {{\n{light}  --bubble-mine: var(--secondary-container); --on-bubble-mine: var(--on-secondary-container);\n}}\n"
            f"@media (prefers-color-scheme: dark) {{\n  :root:not([data-theme=\"light\"]) {{\n{dark.replace(chr(10) + '  ', chr(10) + '    ').replace('  --', '    --', 1)}  }}\n}}\n"
            f":root[data-theme=\"dark\"] {{\n{dark}}}\n\n"
            "/* Logo: das App-Icon ersetzt das Schild-Symbol */\n"
            ".boot-logo, .brand-logo, .brand-mini { background: none !important; box-shadow: none; overflow: hidden; animation-duration: 1.8s; }\n"
            ".boot-logo img, .brand-logo img, .brand-mini img { width: 100%; height: 100%; display: block; }\n")


def main() -> None:
    import cairosvg
    (STATIC / "icon.svg").write_text(icon_svg(), "utf-8")
    cairosvg.svg2png(bytestring=icon_svg().encode(), write_to=str(STATIC / "icon-192.png"), output_width=192, output_height=192)
    cairosvg.svg2png(bytestring=icon_svg().encode(), write_to=str(STATIC / "icon-512.png"), output_width=512, output_height=512)
    cairosvg.svg2png(bytestring=icon_svg(0.8, rounded=False).encode(), write_to=str(STATIC / "icon-maskable-512.png"), output_width=512, output_height=512)
    cairosvg.svg2png(bytestring=badge_svg().encode(), write_to=str(STATIC / "badge-96.png"), output_width=96, output_height=96)
    (STATIC / "css").mkdir(exist_ok=True)
    (STATIC / "css" / "theme.css").write_text(theme_css(), "utf-8")
    print("Icon, PNGs, Badge und static/css/theme.css erzeugt")


if __name__ == "__main__":
    main()