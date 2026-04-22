#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSCRIPTEN_DIR="$SCRIPT_DIR"
WEB_DIR="$SCRIPT_DIR/web"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== BoxedWine WASM Build Script ===${NC}"

# Check for emcc
if ! command -v emcc &> /dev/null; then
    echo -e "${RED}Error: emcc not found. Make sure Emscripten is installed and in your PATH.${NC}"
    exit 1
fi

echo -e "${YELLOW}Emscripten version:${NC} $(emcc --version | head -1)"

# Build the WASM
echo -e "${YELLOW}Building WASM (release)...${NC}"
cd "$EMSCRIPTEN_DIR"
make release

BUILD_OUTPUT="$EMSCRIPTEN_DIR/Build/Release"

# Verify build output exists
if [ ! -f "$BUILD_OUTPUT/boxedwine.html" ]; then
    echo -e "${RED}Error: Build failed - boxedwine.html not found in $BUILD_OUTPUT${NC}"
    exit 1
fi

echo -e "${GREEN}Build successful!${NC}"

# List built files
echo -e "${YELLOW}Built files:${NC}"
ls -lh "$BUILD_OUTPUT/"

# Create web directory if it doesn't exist
if [ ! -d "$WEB_DIR" ]; then
    echo -e "${YELLOW}Creating web directory: $WEB_DIR${NC}"
    mkdir -p "$WEB_DIR"
else
    echo -e "${YELLOW}Web directory already exists: $WEB_DIR${NC}"
fi

# Copy build output to web directory
echo -e "${YELLOW}Copying build output to web directory...${NC}"
cp "$BUILD_OUTPUT/boxedwine.html" "$WEB_DIR/"
cp "$BUILD_OUTPUT/boxedwine.js" "$WEB_DIR/"
cp "$BUILD_OUTPUT/boxedwine.wasm" "$WEB_DIR/"

# Copy supporting files
if [ -f "$BUILD_OUTPUT/boxedwine.data" ]; then
    cp "$BUILD_OUTPUT/boxedwine.data" "$WEB_DIR/"
fi
if [ -f "$BUILD_OUTPUT/boxedwine.worker.js" ]; then
    cp "$BUILD_OUTPUT/boxedwine.worker.js" "$WEB_DIR/"
fi

# Copy static assets (shell JS and CSS) if they exist in build output or source
if [ -f "$EMSCRIPTEN_DIR/boxedwine-shell.js" ]; then
    cp "$EMSCRIPTEN_DIR/boxedwine-shell.js" "$WEB_DIR/"
fi
if [ -f "$EMSCRIPTEN_DIR/boxedwine.css" ]; then
    cp "$EMSCRIPTEN_DIR/boxedwine.css" "$WEB_DIR/"
fi

# Copy zip files (root filesystem, app zips) if present
for zipfile in "$EMSCRIPTEN_DIR"/*.zip; do
    if [ -f "$zipfile" ]; then
        cp "$zipfile" "$WEB_DIR/"
        echo -e "${YELLOW}Copied $(basename "$zipfile") to web directory${NC}"
    fi
done

echo -e "${GREEN}=== Build and copy complete! ===${NC}"
echo -e "${GREEN}Web directory: $WEB_DIR${NC}"
echo -e "${YELLOW}Files in web directory:${NC}"
ls -lh "$WEB_DIR/"
echo ""
echo -e "To serve locally, run: ${YELLOW}cd $WEB_DIR && python3 -m http.server 8080${NC}"
