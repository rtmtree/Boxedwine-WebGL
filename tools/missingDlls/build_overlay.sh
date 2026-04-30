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

echo "=== Staging boxedwine's prebuilt libGL.so.1 ==="
# Boxedwine ships a real libGL.so.1 at tools/opengl/libGL.so.1 (built from
# tools/opengl/gl.c). It exports ~2900 gl*/glX* symbols and routes every
# call through `int 0x99` to the GL bridge in source/opengl/glcommon.cpp,
# which forwards to SDL_GL → WebGL. Use it instead of a stub: dlsyms
# during Wine init_opengl resolve, glXCreateContext actually creates a
# WebGL context, and runtime gl* calls render.
mkdir -p "$WORK/usr/lib" "$WORK/lib/i386-linux-gnu" "$WORK/usr/lib/i386-linux-gnu"

PREBUILT_LIBGL="$REPO_ROOT/tools/opengl/libGL.so.1"
if [[ ! -f "$PREBUILT_LIBGL" ]]; then
    echo "ERROR: $PREBUILT_LIBGL not found." >&2
    echo "Rebuild with: cd tools/opengl && ./buildgl.sh" >&2
    exit 1
fi

cp "$PREBUILT_LIBGL" "$WORK/usr/lib/libGL.so.1"
cp "$PREBUILT_LIBGL" "$WORK/usr/lib/i386-linux-gnu/libGL.so.1"
cp "$PREBUILT_LIBGL" "$WORK/lib/i386-linux-gnu/libGL.so.1"

echo "=== Building $OUT ==="
rm -f "$OUT"
( cd "$WORK" && zip -ry "$OUT" home/ usr/ lib/ )

echo "=== Done ==="
ls -lh "$OUT"
echo
echo "URL to test:"
echo "  /boxedwine.html?app=boxedwine&overlay=missingdlls&p=/home/username/<exe>"
