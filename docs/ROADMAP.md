# Stroke2Vibe — Zukunftspläne & Roadmap

Stand: 2026-10-05

## Geplanter Meilenstein (nächste Ausbaustufe)

### M1 — Audio-zu-Funscript-Generierung (V0/V1 aus Audio als EINZIGER Quelle)

**Ziel:** Stroker-Videos ohne vorhandenes Funscript — Audio-Spur als einzige Quelle —
bekommen automatisch eine stimmige V0/V1-Spur (und optional A0).

**Status:** GEPLANT (nicht begonnen). Geschätzter Aufwand: 2–3 Arbeitstage.
**Priorität:** hoch — deckt den häufigsten Use-Case ab (Scripte-lose Videos).

#### Teil 1 — Dekodierer + Analyse (web/src/lib/audio/analyze.ts)
- Video-Datei (bereits im Player geladen) ODER separates Audio-File via
  FileReader + decodeAudioData (offline, kompletter Puffer im RAM).
- Mono-Mixdown, 22 kHz reicht.
- FFT-Fenster 2048, Hop 10 ms → Energie-Hüllkurven pro Band:
  - Bass 20–150 Hz (Punch/Beats)
  - Mid 150–2 kHz (Schleif-/Stroke-Geräusche)
  - High 2–8 kHz (Textur)
- RMS-Hüllkurve je Band, 10-ms-Auflösung.

#### Teil 2 — Rhythmus + Envelope
- Onset-Detection: Spectral Flux (Mid/High) + adaptiver Schwellwert (Median ± k·MAD)
  + Peak-Picking mit Mindestabstand 150 ms → „Stroke-Ticks".
- Tempo/Periodik: Autokorrelation über Onset-Intervalle und Hüllkurve; nur über
  aktive Segmente (robust gegen Dialog). Median der Intervalle = Halb-Stroke T.
- Dialog-/Stillen-Gate: High-Band-Flachheit + geringe Mid-Energie → Abschnitte
  werden still (kein Fake-Hämmern während Speech).
- Envelope: Mid-Band-RMS → p99-Normalisierung (target) → Perzentil-Gate →
  Slow-Swell + Ripple-Komposition (gleiche Bauform wie der L0-Pfad).
- Rhythmus-Kopplung: Onsets erzeugen ein revs-Array (Äquivalent zu
  L0-Umkehrpunkten) → Modi travel/alternate/layer/surge + Auto-Profile funktionieren
  UNVERÄNDERT (nur eine neue Quellklasse „virtuelles L0").
- Modus-Wahl: travel bei klarem Tempo (0,4–1,5 Hz), layer als Fallback bei
  unklarem Tempo, alternate bei schnellen Twitch-Bursts — analog zur L0-Logik.

#### Teil 3 — UI-Integration
- Mapping-Panel: neue Quelle „Audio (generiert)" neben L0/l2/r0 — erzeugt intern
  einen normalen AxisSource (virtueller Trace) → Engine/Player/Intiface-Sendepfad
  bleibt unberührt.
- Audio-Panel: Audio aus dem geladenen Video extrahieren (kein zweites File nötig)
  oder separates Audio-File laden; Fortschrittsanzeige während Dekodierung;
  Energie-/Onset-Vorschau (SVG); Offset-Regler ±5 s (Audio↔Video-Sync);
  Sensitivity-Regler (Onset-Schwelle); Band-Gewichtung Bass/Mid/High.
- Waveform-Panel zeigt die generierte Spur wie jede andere (Playhead/Zoom/Seek).

#### Tests
- Synthetische Audio-Signale (Sine-Bursts bei 1 Hz / 0,5 Hz, Noise-Segmente,
  Dialog-Simulation) → erwartete Onsets/Tempo/Envelope asserten.
- End-to-End: Audio → generierte Spur → convertScript-Parität mit L0-Referenzpfad.

#### Grenzen (bewusst akzeptiert)
- Kein „echtes" Stroke-Verständnis — Qualität schwankt nach Video-Audio
  (70–85 % „richtig wirkend" bei klaren Stroker-Audios, schwächer bei musik-lastigen).
- Kein Streaming-FFT im Browser (kompletter Dekod-Puffer nötig; 15–45-min-Videos ok).
- Release-Offsets zwischen Audio und Video → Offset-Regler Pflicht.

---

## Weitere geplante Ideen (Backlog, unsortiert)

- **Additive Quell-Mixes:** mehrere Spuren (z. B. L0 + r0) mit Gewichtungen auf EIN
  Ziel-Axis mischen (aktuell 1:1 pro Ziel). Engine-Erweiterung, überschaubar.
- **Profil-System für Geräte:** Geräteeigenschaften (Motorenzahl, Floor, Rate-Limit,
  Steps-Quantisierung) als JSON-Profil statt fixer Flags — für künftige Vibe-Devices.
- **Vacuum-Modus „audio-coupled":** A0-Pump-Pulse direkt an Audio-Onsets koppeln.
- **CLI-Port des Auto-Tools (auto/):** gleiche PostProcessing-Verbesserungen
  (postProcess, Baseline+Swell-Envelope, Auto-Profile) wie im Web nachziehen.
- **Metadaten-Sync:** Script-Metadaten beim Export vollständig erhalten.

---

## Code-Base-Optimierungen (Stand 2026-10-05 geprüft)

### A. Hohe Priorität (Korrektheit/Robustheit)
1. **Duplikatlogik gekoppelt/independent:** finalizeShape/shapeTrackFrom und der
   coupled-Pfad in convertMapped teilen sich ~80 % Code; auf eine gemeinsame
   Funktion reduzieren — weniger Drift-Risiko (Beweis: der autoTravel-Bug).
2. **postProcess-Komplexität:** bei sehr langen Skripten O(n²)-Risiko im
   Smoothing-Loop → Prefix-Summen oder gleitendes Fenster nutzen.
3. **Output-Dokumentation:** 50-ms-Raster erzeugt bis zu 20k Actions pro Achse bei
   langen Skripten — Rate-Limit/Quantisierung aus Gerätesicht konfigurierbar machen.

### B. Mittlere Priorität (Performance)
4. **Auto-Apply-Throttling:** convertMapped läuft bei jeder Slider-Bewegung
   ($derived.by); bei 5k+ Actions ruckelig → Debounce (150 ms) oder rAF-Throttle.
5. **dedupe/normalizeActions-Allokationen:** mehrfache Array-Kopien pro Apply →
   In-Place-Mutation wo möglich.
6. **Waveform-Pfad-Caching:** buildPath bei jeder Playhead-Bewegung neu →
   Memoize nach winStart/winLen; Playhead-Update (DOM) von Pfad-Neubau trennen.

### C. Niedrige Priorität (Code-Qualität)
7. **sync.ts:** Ramp/Deadband/Clamp in eigene Pure-Functions extrahieren →
   unit-testbar ohne Driver.
8. **Fixtures-Regenerator:** expected.json-Generator (regen-Skript) ins Repo
   legen (web/tools/regen-expected.mjs), damit Paritätstests reproduzierbar sind.
9. **CSS-Duplikate** zwischen Panels (.row, .panel, Badges) → globales
   app.css ausbauen.
10. **CLI/Web-Pipeline-Parität:** auto/Stroke2VibeAuto.cpp hat die neuen
    Envelope-/PostProcessing-Schritte (Baseline+Swell, postProcess, Auto-Profile)
    noch nicht — dokumentieren oder portieren.

---

## M2 — Generierungs-Erlebnis (Gefühlsoptimierung) — UMGESETZT 2026-10-05 (Punkte 1,2,3,5,6,7; 4 = M1-Abhängigkeit)

Ziel: Die generierten V0/V1-Spuren fühlen sich weniger „berechnet" und mehr
„handgescriptet" an. Alles baut auf der bestehenden Pipeline auf (Envelope →
Split → DevicePass); die Punkte sind unabhängig umsetzbar.

### 1. Sektions-Dynamik („Scripter-Wissen")
- Skript in Abschnitte clustern (Energie/Tempo-Ähnlichkeit, ~10–20 s Fenster):
  Intro / Build / Peak / Cool-down / Pause.
- Jede Sektion bekommt ihr eigenes Profilmix (z. B. Intro=softer, Peak=stronger,
  Cool-down=softer mit tieferem Floor) — sanfte Crossfades (3–5 s) an den Grenzen.
- Nutzt die existierende Auto-Profile-Maschinerie pro Sektion statt global.

### 2. Stroke-Accentierung statt konstanter Ripple
- Ripple-Delta Richtung knüpfen an L0-Richtung: positive Δpos (Eindringen) =
  leichter Boost, Rückweg = normales Niveau — führt zu „Stoß-Gegenwelle"
  statt symmetrischem Zitter.
- Accent-Tiefe als Profilparameter (balanced/stronger/extreme skalieren).

### 3. Tempo-Lock-Verfeinerung bei alternate/travel
- Handover-Zeitpunkte leicht an den echten Umkehrpunkten ausrichten
  (±10 % jitter im Auto-Modus deaktivierbar), damit die Welle nie „daneben tickt".

### 4. Beat/Onset-Unterstützung als Quelle (Teil von M1)
- audioOnsets als optionales revs-Array in die bestehenden Modi einspeisen —
 enthält M1 bereits, hier als Verbesserung der Kopplung (Confidence-Gewichtung:
  schwache Onsets nur als Modulation, starke als Taktgeber).

### 5. Gerätetechnische Feinheiten
- Umkehrpunkt-„Kick": am Ende jedes Strokes ein kurzer +5–8 % Impuls (30 ms),
  um tote Zonen an Richtungswechseln zu überbrücken (als Profil-Option).
- Floor-Rampen statt hartem Floor-Sprung (weiche 50 ms Anhebung) — verhindert
  klacken beiGate-Eintritten.

### 6. Ergebnisfeedback („feel score")
- Waveform-Panel: Marker der Sektionsgrenzen + Schwellwert-Bänder anzeigen,
  damit Nutzer sofort sehen, wo Profile greifen.
- `--explain`-Artikulation im Report: warum welcher Wert gewählt wurde
  (bereits ansatzweise in den Recommendations vorhanden).

### 7. QualityPanel-Erweiterung
- Sektionskarte visualisieren (Farbbänder unter der Waveform),
  sofern M2.1 umgesetzt.

---

## M3 — Waveform-Darstellung der Lines — UMGESETZT 2026-10-05

Ziel: Die Waveform zeigt ALLE verfügbaren Lines (L0/l2/r0/v0/v1/…) wählbar und
vergleichbar, nicht nur die aktiven Playback-Achsen. Playhead/Zoom bleibt gemeinsam.

### 1. Datenmodell
- `Waveform.svelte` nimmt zusätzlich `allSources: AxisSource[]` (alle Traces des
  Skripts inkl. „audio (generiert)" und vacuum) und `activeIds: string[]` ( Playback).
- Sichtbarkeits-Set `visible: Set<string>` — Default: die aktiven Playback-Achsen.

### 2. UI
- Über den Lanes eine schmale „Trace-Leiste": je Trace ein Toggle-Chip
  (Farbe = Lane-Farbe, Klick = an/aus, Doppelklick = solo). Reihenfolge:
  Playback-Achsen zuerst (V0, V1), dann Motion-Spuren (L0, l2, r0), dann
  Generierte (v0 audio, A0).
- Lanes stapeln sich dynamisch; Höhe je Lane 34–46 px, global scrollbar wenn >4.

### 3. Darstellungs-Modi je Lane
- **pos** (default): gefüllte Kurve wie heute.
- **speed** (optional): |Δpos/Δt|-Kurve der Spur — hilfreich, um Stroke-Tempo
  gegen Vibe-Intensität zu vergleichen (Toggle je Lane im Chip-Menü).
- Motion-Spuren (L0 etc.) standardmäßig als Outline statt gefüllt, damit die
  Vibe-Spuren visuell dominieren.

### 4. Koppeln mit M2 (Sektionen/Accents)
- Sektionsbänder (M2.1) und Accent-Marker (M2.5) als optionale Overlays
  hinter allen Lanes.

### 5. Interaktion (existiert, erweitern)
- Zoom/Seek/auto-follow wie heute — gilt global über alle sichtbaren Lanes.
- Klick auf Lane-Label = solo, Shift-Klick = mute der Lane (ohne Playback-Änderung).

### 6. Performance (aus Code-Base-Check übernommen)
- `buildPath` nach winStart/winLen memoizen; nur sichtbare Lanes zeichnen;
  Offline-Path-Datenstruktur (Punkt-Array) einmal pro Trace bauen und nur
  transformieren statt neu sampeln.

---

## Umgesetzt (2026-10-05): Auto-Drive & Manual-Modus

- **Auto drive** (Mapping-Panel): Profile softer/balanced/stronger/extreme leiten
  ALLE Knobs ab (Target, Gamma, Gate, Smooth, Floor, MinGap, Baseline, Ripple,
  Duty, Layer-Depth, Layer-Rate) — abgeleitete Werte werden live an den Slidern
  angezeigt. Slider anfassen = pinnen; Profilwechsel = Reset auf Auto.
- **Manual-Modus**: kompletter Knob-Grid (11 Regler, obige Bereiche), inkl.
  Baseline/Ripple (Wellenform-Direkteinfluss) und Duty/Layer-Depth/Layer-Rate
  (Modus-Gewichte). "reset to auto" kehrt ins Auto-Drive zurück.
- **Engine-Fix**: profileWeights respektiert jetzt o.duty/o.depth/o.layerRatio
  (vorher hardgecoded auf Profilnamen — Overrides wirkten nicht; numerisch
  verifiziert: alternate range 15 (balanced) vs 28 (duty 0.9)).
- baseline/ripple wirken direkt in buildEnvelope (baselineKnob/rippleKnob).
- Alles auto-applied (Signatur-Guard), kein Apply-Button nötig.

### Nachtrag (2026-10-05): UI-Kontextualisierung (Vorschläge 1–3 umgesetzt)
- **Kontextsensitive Anzeige:** Manual-Modus zeigt nur noch Knob-Gruppen, die im
  gewählten Modus wirken (Duty nur bei alternate/auto-PingPong, Layer-*/ bei layer/auto,
  Accent/Kick bei travel/layer/surge/auto).
- **Gruppierung:** Manual-Grid in 3 Klappen: „Wave shape" (Target/Gamma/Baseline/Ripple),
  „Noise & timing" (Gate/Smooth/Floor/Floor-Ramp/MinGap), „Mode specifics" (rest).
- **Strength-Makro:** ein Regler (-100 %…+100 %), der Target/Baseline/Ripple
  proportional gemeinsam verschiebt — „etwas leiser/bitte voller" ohne 5 Slider
  (numerisch verifiziert: Range 32 → 47 → 54 bei -1/0/+1).
