# Feuerwerk-Einkauf (iPhone-App)

Einkaufsliste für den Feuerwerkskauf im Laden (z. B. Tschechien) mit Grenz-Check – als Web-App (PWA),
die auf dem iPhone wie eine normale App vom Home-Bildschirm startet und offline funktioniert.
Gehört zur Chrome-Erweiterung `../feuerwerk-einkaufsliste`.

## Was sie kann

- Artikel mit Foto, Art.-Nr., Gefahrgut, Kategorie, NEM und brutto; **abhaken** = liegt im Korb
- Oben immer sichtbar: **1.3G brutto / 5 kg**, **1.4 brutto / 50 kg**, **ADR-Punkte / 1000** (antippen = Details mit NEM, Preis, Budget)
- Balken: kräftig = abgehakt, hell = ganze Liste. Im Menü wählbar, womit „Passt noch N×“ und der Status rechnen.
- **＋** → Suche im mitgelieferten **Klásek-Katalog 2026** (671 Artikel, Fotos, NEM, brutto, Kč-Preis) oder eigener Artikel
  mit Handyfoto. Brutto lässt sich aus Kartongewicht ÷ Stück berechnen. Vorschau zeigt den Stand *nach* dem Hinzufügen.
- F3/F4, 1.1G/1.2G werden rot markiert und nicht mitgezählt; Artikel ohne Angaben stehen unter „Nicht mitgezählt“.
- Daten bleiben nur auf dem iPhone (IndexedDB). Menü → **Liste teilen / sichern** speichert eine Kopie als `.fwliste.json`.

## Liste aus Chrome übernehmen

1. In der Erweiterung (Seitenleiste, unten) **📱 Für iPhone** → speichert `Listenname.fwliste.json`
2. Datei aufs iPhone: iCloud Drive, AirDrop oder per Mail an dich selbst (in „Dateien“ sichern)
3. In der App: **⋯** → **Liste importieren** → Datei auswählen

Die CSV der Erweiterung geht auch (Fotos werden dann über die Art.-Nr. aus dem Katalog ergänzt).

## Veröffentlichen (GitHub Pages, kostenlos)

1. Auf github.com anmelden → **New repository** → Name z. B. `feuerwerk-einkauf`, **Public** → Create
2. **uploading an existing file** → den *Inhalt* dieses Ordners hineinziehen (index.html, app.js, app.css, sw.js,
   manifest.webmanifest, katalog.json, Ordner icons) → **Commit changes**
3. **Settings → Pages** → Source „Deploy from a branch“, Branch `main`, Ordner `/ (root)` → Save
4. Nach 1–2 Minuten erreichbar unter `https://<name>.github.io/feuerwerk-einkauf/`
5. Auf dem iPhone in **Safari** öffnen → **Teilen** → **Zum Home-Bildschirm**

Wichtig: Die installierte App hat ihren eigenen Speicher (getrennt von Safari) – Listen in der App importieren, nicht im Safari-Tab.

## Aktualisieren

- Geänderte Dateien erneut hochladen und in `sw.js` die Zahl in `CACHE = 'fw-einkauf-v1'` erhöhen.
- Katalog neu bauen: `python -I tools/build_catalog.py <download-ordner> katalog.json`
- Icons: `python -I tools/make_icons.py icons`

Grenzwerte (wie Erweiterung, `app.js` → `BORDER`): GGVSEB Anlage 2 Privat-Freigrenze, ADR 1.1.3.6 1000-Punkte-Regel.
Richtwerte, keine Rechtsberatung.
