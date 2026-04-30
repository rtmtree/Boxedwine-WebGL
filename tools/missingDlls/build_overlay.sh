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

echo "=== Pulling i386 Linux GL libraries from Docker ==="
mkdir -p "$WORK/usr/lib" "$WORK/lib/i386-linux-gnu" "$WORK/usr/lib/i386-linux-gnu"
GL_LIBS=(
    libGL.so.1
    libGLX.so.0
    libGLdispatch.so.0
    libglapi.so.0
    libGLX_mesa.so.0
    libdrm.so.2
    libxshmfence.so.1
)

# Tar from the container, dereferencing symlinks (-h) so the zip has
# real files at the well-known names rather than symlink files (which
# Wine reads as "file too short").
TARGS=()
for lib in "${GL_LIBS[@]}"; do
    TARGS+=("usr/lib/i386-linux-gnu/$lib")
done
docker run --rm --platform linux/386 i386/debian:11-slim sh -c "
    apt-get update -qq 2>/dev/null
    apt-get install -y libgl1-mesa-glx 2>/dev/null >/dev/null
    cd /
    tar -czhf - ${TARGS[@]} 2>/dev/null
" | tar -xzf - -C "$WORK"

# Mirror the Debian-multiarch path's contents to the simpler names
# Wine and ld.so check first.
for lib in "${GL_LIBS[@]}"; do
    cp "$WORK/usr/lib/i386-linux-gnu/$lib" "$WORK/usr/lib/$lib"
    cp "$WORK/usr/lib/i386-linux-gnu/$lib" "$WORK/lib/i386-linux-gnu/$lib"
done

echo "=== Building $OUT ==="
rm -f "$OUT"
( cd "$WORK" && zip -ry "$OUT" home/ usr/ lib/ )

echo "=== Done ==="
ls -lh "$OUT"
echo
echo "URL to test:"
echo "  /boxedwine.html?app=boxedwine&overlay=missingdlls&p=/home/username/<exe>"
