#!/usr/bin/env bash
# Build Stroke2VibeAuto and verify its output against precomputed expected values.
# Usage: ./run_tests.sh
set -u
cd "$(dirname "$0")"

BIN=$(mktemp -d /tmp/opencode/s2va.XXXXXX)/Stroke2VibeAuto
g++ -std=c++17 -O2 -Wall -Wextra -I.. -o "$BIN" ../Stroke2VibeAuto.cpp || { echo "BUILD FAILED"; exit 1; }
echo "build ok"

FAIL=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

FIX=fixtures/choke_off_trim.funscript
EXP=fixtures/expected.json
WORK=$(mktemp -d /tmp/opencode/s2vatest.XXXXXX)

run() { "$BIN" "$@" >/dev/null 2>"$WORK/stderr.txt"; echo $?; }

# ---- 1. per-mode output parity -------------------------------------------
python3 - "$BIN" "$FIX" "$EXP" "$WORK" <<'EOF'
import json, subprocess, sys, os
bin_, fix, exp, work = sys.argv[1:5]
expected = json.load(open(exp))
fails = []
for mode in ["travel", "alternate", "layer", "surge"]:
    out = os.path.join(work, mode + ".funscript")
    r = subprocess.run([bin_, fix, "--mode", mode, "--out", out], capture_output=True, text=True)
    if r.returncode != 0:
        fails.append(f"{mode}: exit {r.returncode}"); continue
    doc = json.load(open(out))
    axes = {a["id"]: a["actions"] for a in doc.get("axes", [])}
    for ax, key in (("V0", "v0"), ("V1", "v1")):
        got = [[p["at"], p["pos"]] for p in axes.get(ax, [])]
        want = expected["modes"][mode][key]
        if len(got) != len(want):
            fails.append(f"{mode}/{ax}: length {len(got)} != {len(want)}"); continue
        for (ga, gp), (wa, wp) in zip(got, want):
            if abs(ga - wa) > 0 or abs(gp - wp) > 1:
                fails.append(f"{mode}/{ax}: at {ga}: {gp} != {wp}"); break
if fails:
    print("\n".join(fails)); sys.exit(1)
EOF
[ $? -eq 0 ] && ok "4-mode parity vs expected.json" || bad "4-mode parity vs expected.json"

# also check mode auto == travel
"$BIN" "$FIX" --mode auto --out "$WORK/auto.funscript" >/dev/null
python3 -c "
import json,sys
a=json.load(open('$WORK/auto.funscript')); b=json.load(open('$WORK/travel.funscript'))
ax=lambda d:{x['id']:x['actions'] for x in d['axes']}
sys.exit(0 if ax(a)==ax(b) else 1)" && ok "auto == travel" || bad "auto == travel"

# ---- 2. document preservation --------------------------------------------
"$BIN" "$FIX" --out "$WORK/keep.funscript" >/dev/null
python3 -c "
import json,sys
src=json.load(open('fixtures/choke_off_trim.funscript')); dst=json.load(open('$WORK/keep.funscript'))
assert dst['version']=='1.1', 'version changed'
assert dst['metadata']==src['metadata'], 'metadata changed'
assert dst['actions']==src['actions'], 'L0 actions changed'
ids={a['id'] for a in dst['axes']}
assert 'l2' in ids, 'l2 axis lost'
for a in dst['axes']:
    if a['id']=='l2': assert a['actions']==src['axes'][0]['actions'], 'l2 actions changed'
assert {a['id'] for a in dst['axes']}=={'l2','V0','V1'}, 'unexpected axes'
" && ok "metadata/version/L0/l2 preserved" || bad "document preservation"

# ---- 3. in-place with .bak, refusal, --force ------------------------------
cp "$FIX" "$WORK/inplace.funscript"
"$BIN" "$WORK/inplace.funscript" >/dev/null            # in-place
[ -f "$WORK/inplace.funscript.bak" ] && ok ".bak backup created" || bad ".bak backup"
python3 -c "
import json
a=json.load(open('$WORK/inplace.funscript'))
assert 'axes' in json.load(open('$WORK/inplace.funscript'))" 2>/dev/null
"$BIN" "$WORK/inplace.funscript" --out "$WORK/no.json" >/dev/null 2>&1
[ $? -ne 0 ] && ok "refuses existing V0/V1 without --force" || bad "refusal without --force"
"$BIN" "$WORK/inplace.funscript" --out "$WORK/forced.funscript" --force >/dev/null
[ $? -eq 0 ] && ok "--force replaces axes" || bad "--force"

# ---- 4. split files (companions are written next to the INPUT script) -----
mkdir -p "$WORK/splitdir"
cp "$FIX" "$WORK/splitdir/myscript.funscript"
"$BIN" "$WORK/splitdir/myscript.funscript" --split >/dev/null
[ -f "$WORK/splitdir/myscript.vib.funscript" ] && [ -f "$WORK/splitdir/myscript.vib1.funscript" ] && ok "--split files created" || bad "--split files"
python3 -c "
import json
d=json.load(open('$WORK/splitdir/myscript.vib.funscript'))
assert d['version']=='1.1' and all('at' in p and 'pos' in p for p in d['actions'])
d2=json.load(open('$WORK/splitdir/myscript.vib1.funscript'))
assert len(d['actions'])>0 and len(d2['actions'])>0" && ok "split files valid" || bad "split files valid"

# ---- 5. error handling ----------------------------------------------------
echo '{"version":"1.0","actions":[]}' > "$WORK/empty.funscript"
"$BIN" "$WORK/empty.funscript" >/dev/null 2>&1; [ $? -ne 0 ] && ok "empty script rejected" || bad "empty script"
echo '{"version":"1.0","actions":[{"at":1e999,"pos":5}' > "$WORK/broken.funscript"
"$BIN" "$WORK/broken.funscript" >/dev/null 2>&1; [ $? -ne 0 ] && ok "broken json rejected" || bad "broken json"
"$BIN" "$WORK/does_not_exist.funscript" >/dev/null 2>&1; [ $? -ne 0 ] && ok "missing file rejected" || bad "missing file"

# ---- 6. flag behaviour ----------------------------------------------------
"$BIN" "$FIX" --mode travel --travel-from top --out "$WORK/top.funscript" >/dev/null
python3 -c "
import json
def ax(p):
    d=json.load(open(p)); m={x['id']:dict((q['at'],q['pos']) for q in x['actions']) for x in d['axes']}
    return m
bot=ax('$WORK/travel.funscript'); top=ax('$WORK/top.funscript')
assert bot['V0']==top['V1'] and bot['V1']==top['V0'], 'travel-from did not swap'
" && ok "--travel-from top mirrors V0/V1" || bad "--travel-from top"

"$BIN" "$FIX" --stats --dry-run --out "$WORK/nothing.funscript" >/dev/null 2>&1
[ -f "$WORK/nothing.funscript" ] && bad "--dry-run must not write" || ok "--dry-run writes nothing"

# ---- 7. JSON5 tolerance ---------------------------------------------------
cat > "$WORK/json5.funscript" <<'J5'
{
  // comment
  "version": '1.0',
  "actions": [
    {"at":0,"pos":50},
    {"at":1000,"pos":90},  // trailing comment
    {"at":2000,"pos":20},
  ],
  "inverted": false,
}
J5
"$BIN" "$WORK/json5.funscript" --out "$WORK/json5.out" >/dev/null && python3 -c "
import json
d=json.load(open('$WORK/json5.out'))
assert len(d['actions'])==3 and 'axes' in d" && ok "JSON5 tolerated" || bad "JSON5 tolerated"

echo
[ $FAIL -eq 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit $FAIL
