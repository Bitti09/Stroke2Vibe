# Stroke2VibeAuto

Converts a stroke (L0) funscript into a **coherent dual-vibration (V0/V1) script** — built for
vibration-only masturbators with two motors (e.g. Leo FS1v3) driven via Intiface/buttplug.io.
Standalone, dependency-free C++17; builds with MSVC, g++ or clang.

## What it does

1. Parses the input script (strict JSON + tolerant of JSON5-style comments, trailing commas,
   single quotes and unquoted keys). Top-level `actions` are the L0 stroke axis; **everything
   else is preserved untouched** — metadata, `version`, existing axes, unknown fields.
2. Derives **one intensity envelope** E(t) from the stroke speed |Δpos/Δt|
   (robust p99-normalisation → noise gate → optional smoothing → gamma lift).
3. Splits E(t) onto two axes energy-preservingly (`w0 + w1 = 1`) using a split mode (below).
4. Applies motor physics: dead-zone/off below half of `--floor`, floor at `--floor`,
   rate cap (`--min-gap`) per axis, guaranteed stop at the end.
5. Embeds the result as a standard single-file multi-axis `axes` array:

```json
{
  "version": "1.1",
  "actions": [ ... original L0, untouched ... ],
  "axes": [
    { "id": "V0", "actions": [ {"at":118000,"pos":34}, ... ] },
    { "id": "V1", "actions": [ {"at":118000,"pos":9},  ... ] }
  ]
}
```

Players without multi-axis support simply ignore `axes` and keep playing the original L0.

## Split modes

| Mode        | Behaviour |
|-------------|-----------|
| `auto`      | `travel` with automatic fallback (default) |
| `travel`    | Wave travels base↔tip in sync with the real stroke; below `--dwell` half-stroke duration it degrades to a 50/50 balance (too fast to localise) |
| `alternate` | Tempo-locked ping-pong: motors swap per half-stroke (active gets `--duty`, passive the rest); above `--max-switch` Hz it widens to full-stroke beats, then balance |
| `layer`     | Both motors always on, slowly breathing against each other (subharmonic of the stroke tempo, `--layer-ratio`/`--depth`) |
| `surge`     | Both motors full; V1 delayed by `--echo` ms (not energy-preserving, by design) |

## Usage

```
Stroke2VibeAuto video.funscript                 # in-place, adds V0/V1 (creates video.funscript.bak)
Stroke2VibeAuto video.funscript --stats         # analysis report, then convert
Stroke2VibeAuto video.funscript --mode alternate --duty 0.75
Stroke2VibeAuto video.funscript --split         # also writes video.vib.funscript / video.vib1.funscript
Stroke2VibeAuto video.funscript --out converted.funscript
```

Options (see `--help` for all): `--mode auto|travel|alternate|layer|surge`,
`--travel-from top|bottom`, `--duty`, `--layer-ratio`, `--depth`, `--echo`, `--gamma`,
`--gate`, `--target`, `--smooth`, `--gap`, `--min-gap`, `--floor`, `--dwell`, `--max-switch`,
`--axes V0,V1`, `--force`, `--dry-run`, `--stats`.

If the script already contains V0/V1 axes the tool refuses to overwrite them unless
`--force` is given.

## Build

```
g++ -std=c++17 -O2 -o Stroke2VibeAuto Stroke2VibeAuto.cpp     # Linux/macOS/MinGW
cl /O2 /EHsc /std:c++17 Stroke2VibeAuto.cpp                   # MSVC
```

or CMake: `cmake -B build -S auto && cmake --build build`.

## Tests

```
cd tests && ./run_tests.sh
```

Runs 14 functional checks: 4-mode parity against precomputed reference values
(`fixtures/expected.json`, generated from a reference simulation of the real
ReflectiveDesire example script), document preservation, in-place + `.bak`,
`--force` handling, split files, error cases, JSON5 tolerance, `--travel-from`,
`--dry-run`.

## Notes

- Default mode `auto` keeps spatial patterns (travel wave) where they are perceivable and
  degrades to a balanced texture where strokes are too fast — reported under `degraded`
  in `--stats`.
- Intensity values are 0–100 integers, timestamps in ms — plain funscript semantics on
  every axis.
