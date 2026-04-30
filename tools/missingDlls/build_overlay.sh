#!/usr/bin/env bash
#
# Build project/emscripten/web/missingdlls.zip — an overlay zip that
# layers on top of boxedwine.zip to provide DLLs / .so files the
# stock Wine 6.0 prefix is missing for some modern games.
#
# Why this exists:
#
#   The stock boxedwine.zip ships a partial Wine 6.0 prefix. Some PE
#   stubs (avrt.dll, dinput8.dll) are present as "Wine placeholder"
#   markers but their .dll.so backing files were stripped from the
#   build, so any .exe that imports them fails LdrInitializeThunk
#   with STATUS_DLL_NOT_FOUND. Likewise libGL.so.1 was never
#   bundled, so any game that calls into Wine's opengl32 dies in
#   wgl:init_opengl.
#
#   This script pulls real PE DLLs from a local Wine install (macOS
#   Wine.app under /Applications) and Linux .so files from a
#   linux/386 Debian Docker image, patches out the "Wine builtin"
#   marker so the Wine 6 loader treats them as native PE, and zips
#   them up at the right paths.
#
# Usage:
#   ./tools/missingDlls/build_overlay.sh
#
# Output:
#   project/emscripten/web/missingdlls.zip   (~1.6 MB)
#
# URL to use the overlay:
#   ?app=boxedwine&overlay=missingdlls&p=/path/to/Game.exe
#
# Status: enough for AVRT-importing games (e.g. Godot) to load past
# the Wine import-DLL check. Does NOT yet make OpenGL work — Mesa's
# libGL would need a working GLX in our X server, which is a
# separate effort.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
OUT="$REPO_ROOT/project/emscripten/web/missingdlls.zip"

WINE_APP="/Applications/Wine Stable.app"
WINE_PE_DIR="$WINE_APP/Contents/Resources/wine/lib/wine/i386-windows"

echo "=== Pulling PE DLLs from $WINE_APP ==="
if [[ ! -d "$WINE_PE_DIR" ]]; then
    echo "ERROR: $WINE_PE_DIR not found. Install Wine.app from winehq.org first." >&2
    exit 1
fi

mkdir -p "$WORK/home/username"
cp "$WINE_PE_DIR/avrt.dll"     "$WORK/home/username/avrt.dll"
cp "$WINE_PE_DIR/dinput8.dll"  "$WORK/home/username/dinput8.dll"

# Strip "Wine builtin DLL" marker. The Wine 6 loader sees this string
# at offset 0x40 and tries to load the (missing) .dll.so backing file
# instead of treating the PE as native.
echo "=== Patching out 'Wine builtin DLL' markers ==="
for f in "$WORK/home/username/avrt.dll" "$WORK/home/username/dinput8.dll"; do
    python3 - <<PY
import sys
p = "$f"
b = bytearray(open(p,'rb').read())
m = b'Wine builtin DLL'
i = b.find(m)
if i >= 0:
    b[i:i+len(m)] = b'\\x00' * len(m)
    open(p,'wb').write(bytes(b))
    print(f"  patched {p}")
else:
    print(f"  marker not found in {p} (already patched?)")
PY
done

echo "=== Building libGL.so.1 stub from Mesa symbol list ==="
# Mesa's libGL has ~3500 gl*/glX* exports. Wine's wgl:init_opengl
# dlsym's every one and bails on the first miss — so we generate a
# zero-returning stub for every name. A handful (glGetString,
# glXCreateContext, ...) get real implementations that satisfy
# Wine's feature checks.
mkdir -p "$WORK/usr/lib" "$WORK/lib/i386-linux-gnu" "$WORK/usr/lib/i386-linux-gnu"

# Step 1: extract every gl/glX symbol Mesa libGL exports
docker run --rm --platform linux/386 i386/debian:11-slim sh -c '
    apt-get -qq update >/dev/null 2>&1
    apt-get -y install libgl1-mesa-glx binutils 2>/dev/null >/dev/null
    nm -D /usr/lib/i386-linux-gnu/libGL.so.1 | awk "/ T (gl|glX|_glapi)/ { print \$3 }"
' > "$WORK/gl_symbols.txt"

echo "  Mesa exports: $(wc -l < "$WORK/gl_symbols.txt")"

# Step 2: generate the stub C file from libGL_stub.c (hand-written
# special cases) plus alias-to-zero stubs for everything else.
python3 - "$WORK/gl_symbols.txt" "$REPO_ROOT/tools/missingDlls/libGL_stub.c" "$WORK/libGL_full.c" <<'PY'
import sys
syms_path, hand_path, out_path = sys.argv[1:4]
with open(syms_path) as f:
    syms = sorted({s.strip() for s in f if s.strip()})
SPECIAL = {
    'glGetString','glGetError','glGetIntegerv','glGetFloatv','glGetBooleanv',
    'glXGetProcAddress','glXGetProcAddressARB','glXChooseVisual',
    'glXCreateContext','glXDestroyContext','glXMakeCurrent','glXSwapBuffers',
    'glXIsDirect','glXGetCurrentContext','glXGetCurrentDrawable',
    'glXQueryExtension','glXQueryVersion','glXQueryExtensionsString',
    'glXQueryServerString','glXGetClientString','glXChooseFBConfig',
    'glXGetVisualFromFBConfig','glXGetFBConfigAttrib',
    'glXCreateContextAttribsARB','glXSwapIntervalEXT','glXSwapIntervalSGI',
    'glXSwapIntervalMESA','glXGetSwapIntervalMESA','glXGetVideoSyncSGI',
    'glXWaitVideoSyncSGI','glXGetCurrentDisplay','glClear','glClearColor',
    'glViewport','glFlush','glFinish','glEnable','glDisable','glIsEnabled',
    'glDrawArrays','glDrawElements',
}
hand_src = open(hand_path).read()
with open(out_path,'w') as o:
    o.write(hand_src)
    o.write("\n// ---- auto-generated mass stubs ----\n")
    o.write("static long _stub_zero(void) { return 0; }\n\n")
    for s in syms:
        if s in SPECIAL: continue
        o.write(f'long {s}(void) __attribute__((alias("_stub_zero")));\n')
PY

# Step 3: cross-compile the stub to an i386 .so
docker run --rm --platform linux/386 -v "$WORK":/work -w /work \
        i386/debian:11-slim bash -c '
    apt-get -qq update >/dev/null 2>&1
    apt-get -y install gcc 2>/dev/null >/dev/null
    gcc -m32 -shared -fPIC -Wl,-soname,libGL.so.1 -o libGL.so.1 libGL_full.c 2>&1
'

# Step 4: stage the stub at the three Linux library paths Wine 6 / ld.so check.
cp "$WORK/libGL.so.1" "$WORK/usr/lib/libGL.so.1"
cp "$WORK/libGL.so.1" "$WORK/usr/lib/i386-linux-gnu/libGL.so.1"
cp "$WORK/libGL.so.1" "$WORK/lib/i386-linux-gnu/libGL.so.1"

echo "=== Building $OUT ==="
rm -f "$OUT"
( cd "$WORK" && zip -ry "$OUT" home/ usr/ lib/ )

echo "=== Done ==="
ls -lh "$OUT"
echo
echo "URL to test:"
echo "  /boxedwine.html?app=boxedwine&overlay=missingdlls&p=/home/username/<exe>"
