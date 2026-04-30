# Plan: 64-bit Windows-games-in-Safari with Boxedwine-style UX

Self-contained plan for a fresh session. Nothing here depends on prior chat context.

## Goal

Run **lightweight 64-bit Windows games in Safari on iPhone**, preserving the
Boxedwine user experience:

```
your-static-site/
├── index.html           # opens boxedwine-style: ?app=game&p=Game.exe
├── loader.js
├── qemu.wasm            # ~40 MB, cached forever
├── base-image.img.gz    # Alpine + Wine64 + Xvfb + llvmpipe, cached
└── games/
    ├── dino-walk.zip    # user drops zips here
    └── anything.zip
```

User opens `index.html?app=dino-walk&p=DinoWalkSim.exe` → game plays.

## What has already been validated (do not re-verify)

1. **CheerpX/WebVM** is 32-bit only today (per cheerpx-meta README).
2. **Boxedwine** itself is 32-bit x86 only. Architectural blocker for 64-bit.
3. **Blink (jart/blink)** x86_64 emulator compiles to WASM but is
   interpreter-only in-browser, has no `fork()`/threads/networking, Wine
   attempts crash at `VfsFcntl`. Wrong tool for games.
4. **box64 / FEX / felix86** have no WASM backends. Building one is a
   multi-person-year project.
5. **JSLinux (Bellard)** supports x86_64 but is closed-source and prohibits
   redistribution. Licensing dead end unless Bellard grants permission.
6. **ktock/qemu-wasm** — full-system QEMU with a Wasm TCG JIT backend. v3
   patchset (Sep 2025) supports x86_64 guests. Being upstreamed to QEMU.
   GPL-2.0.
   - **Tested live**: boots Alpine x86_64 to a login prompt **in Safari on
     iOS 26 Simulator (iPhone 17 Pro)**. Wall-clock ~40 s to login, kernel
     timestamp 34.99 s. 40 MB wasm + 1.2 MB rootfs loader.
   - Untested on real iPhone silicon — that's step 1 of this plan.
7. **ktock/container2wasm** — sister project, same author. Its
   `--external-bundle` mode bridges external filesystem content into a
   browser-hosted QEMU guest via **9P2000.L over TCP** (not virtio-9p).
   This is the mechanism to reuse for zip-drop UX.

## Architecture

```
┌─── Browser tab (Safari iOS 26+) ────────────────────────────────┐
│                                                                 │
│  Main thread                                                    │
│   ├── loader.js — reads ?app=X&p=Y.exe, fetches X.zip           │
│   ├── Canvas / WebGL (your new graphics bridge)                 │
│   ├── WebAudio / touch input bridges                            │
│   └── QEMU-wasm Emscripten module                               │
│          guest NIC → mock WebSocket → SharedArrayBuffer rings   │
│                                │                                │
│  Web Worker                    ▼                                │
│   └── Go WASI: userspace TCP stack (gvisor-tap-vsock)           │
│        ├── 192.168.127.252:80  → 9P server (zip-backed)         │
│        ├── 192.168.127.253:80  → HTTP(S) proxy (optional)       │
│        └── 192.168.127.254:80  → 9P server (OPFS overlay)       │
│                                                                 │
│  Guest (Alpine x86_64):                                         │
│     mount -t 9p 192.168.127.252 /mnt/app      # zip, read-only  │
│     mount -t 9p 192.168.127.254 /home         # OPFS, writable  │
│     init: DISPLAY=:0 exec wine64 /mnt/app/$P  # from cmdline    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Repos to clone

```bash
# Primary — the CPU+VM foundation
git clone https://github.com/ktock/qemu-wasm.git

# Reference — the filesystem bridge you'll adapt
git clone https://github.com/ktock/container2wasm.git

# Demo source (working reference site)
git clone https://github.com/ktock/qemu-wasm-demo.git

# Networking stack used by the bridge (read-only reference)
# https://github.com/containers/gvisor-tap-vsock
# 9P server library
# https://github.com/hugelgupf/p9
```

## Phased plan with go/no-go gates

### Phase 0 — Foundation and real-iPhone baseline (week 1)

**Goal**: prove the stack works on a physical iPhone; get the toolchain
running locally.

Tasks:
1. On your physical iPhone, open Safari →
   `https://ktock.github.io/qemu-wasm-demo/alpine-x86_64.html`.
   Wait for `demo login:` prompt. Log in as `root`. Record:
   - Wall-clock time to login prompt.
   - `cat /proc/cpuinfo | grep bogomips`
   - `time dd if=/dev/zero of=/dev/null bs=1M count=100`
   - Peak memory (Safari devtools via macOS Safari + USB cable to iPhone).
   - Whether Safari kills the tab under load.
2. Clone qemu-wasm. Follow its build docs. Reproduce the Alpine x86_64
   demo locally from source. Host it yourself with COOP/COEP headers
   (`cross-origin-opener-policy: same-origin`,
   `cross-origin-embedder-policy: require-corp`). Confirm SharedArrayBuffer
   works in your hosted copy.
3. Email the maintainer (@ktock on GitHub). Ask:
   - Known iOS Safari 26 issues.
   - Roadmap for graphics / display device.
   - Would he accept upstream patches for a browser-canvas display backend.

**Gate to Phase 1**: real iPhone boots Alpine to login in ≤ 2 min without
tab crash. If it crashes → stop, investigate memory before proceeding.

### Phase 1 — Graphics pipeline (weeks 2-5) — HIGHEST RISK

**Goal**: QEMU guest's framebuffer visible in a browser `<canvas>`.

qemu-wasm's current demo is **terminal-only** (`-nographic`). Games need a
framebuffer. Two viable routes:

- **Route A (preferred)**: enable QEMU's SDL display backend, compile
  through emscripten. Emscripten natively maps SDL to a canvas. Requires
  adjusting `config/qemu/args-*.json.template` in the qemu-wasm build and
  patching the QEMU configure to not disable SDL.
- **Route B (fallback)**: enable QEMU's built-in VNC server, connect
  noVNC in the browser. Extra overhead, simpler to wire.

In-guest: run `Xvfb :0 -screen 0 1280x720x24` (or `Xwayland`), use **Mesa
llvmpipe** for OpenGL (software rasterizer — no GPU passthrough exists
for WebGPU yet).

**Gate to Phase 2**: Alpine boots into an X session, something renders in
the canvas (e.g., `xeyes`). If blocked > 6 weeks → project is infeasible
on current infrastructure; escalate with @ktock or pivot.

### Phase 2 — Generic base image (weeks 6-7)

**Goal**: one reusable disk image containing Alpine + Wine64 + Xvfb +
llvmpipe + fonts. No game baked in.

Tasks:
- Build process: start from Alpine minirootfs, `apk add xvfb wine
  mesa-gl font-noto`, trim locales/docs.
- Target size: ≤ 250 MB compressed.
- `/sbin/launch-wine` script that reads a target exe path and runs:
  ```sh
  Xvfb :0 -screen 0 1280x720x24 &
  export DISPLAY=:0
  exec wine64 "$1"
  ```
- Ship the image as a separately-downloadable `.img.gz` (not baked into
  the wasm module).

**Gate to Phase 3**: image boots in QEMU, `wine64 --version` works in guest.

### Phase 3 — Zip-drop UX (weeks 8-11) — the Boxedwine layer

This is where you adapt container2wasm's bridge.

#### 3a. Fork `extras/imagemounter/main.go` from container2wasm (1 week)

- Delete OCI layer reader (`fsFromImage`, `generateSpec`, stargz deps —
  lines ~620-1273).
- Add `fsFromZip(buf []byte) p9.Attacher` using Go's `archive/zip`.
- Wire main thread drop handler → `postMessage({zip: arrayBuffer},
  [arrayBuffer])` → worker stores the buffer and exposes it via 9P.
- Keep: gvisor-tap-vsock setup, `hugelgupf/p9` server shell, ring-buffer
  protocol (`extras/runcontainerjs/src/web/runcontainer.js`,
  `stack-worker.js`) — **use verbatim**, do not modify.

Files to read first:
- `extras/imagemounter/main.go` L443-L594 (net+9P setup)
- `extras/imagemounter/main.go` L620-L1273 (the OCI reader you'll
  replace)

#### 3b. Simplify guest init (2 days)

- Fork `cmd/init/main.go` from container2wasm.
- Keep the 9P-over-TCP mount block (L231-L256).
- Replace runc exec with direct `wine64` invocation:
  ```go
  cmd := exec.Command("/sbin/launch-wine", targetExe)
  ```
- Read `targetExe` from `/proc/cmdline` (`app.p=Foo.exe`).
- Drop the runc binary from the image (~10 MB saved).

#### 3c. URL params plumbing (2 days)

- `loader.js` parses `?app=foo&p=game.exe`.
- Fetches `games/foo.zip` as ArrayBuffer.
- Passes `p=game.exe` as kernel cmdline `app.p=game.exe`.
- Transfers zip ArrayBuffer to worker.

#### 3d. OPFS-backed writable overlay (2 weeks) — trickiest bit

- Second 9P server on `192.168.127.254:80`, backed by an OPFS file,
  keyed by `sha256(zip)`.
- In-guest: bind-mount over `/root/.wine` (or `/home/user`) so save files
  persist per-game.
- **OPFS is async-only; p9 server expects sync.** Bridge: buffer writes
  in-memory, async-flush to OPFS on a timer or on `unmount` hook.

**Gate to Phase 4**: drop a zip containing a static x86_64 Linux binary
(`hello-world`), URL-open, binary runs, output visible. Save state
survives reload.

### Phase 4 — First Windows game end-to-end (weeks 12-13)

**Goal**: one trivially simple, 64-bit, portable Windows program runs.

Candidates for first target (ranked easiest → harder):
1. `notepad.exe` from Wine itself — graphics-only smoke test.
2. A 64-bit DOOM port — classic, well-understood, low-poly.
3. A tiny SDL-based indie (need to find one that's 64-bit AND portable
   AND doesn't need DX11+).

**Gate to Phase 5**: the game window appears in the canvas.

### Phase 5 — Input and audio (weeks 14-15)

- `touchstart/move/end` → QEMU `virtio-input` → guest X server events.
- On-screen keyboard mapping.
- Touch-to-mouse with long-press for right-click.
- QEMU audio backend → Web Audio API.

**Gate to Phase 6**: game is interactive and audible.

### Phase 6 — Cold-start UX (weeks 16-17)

Cold-booting Linux every session is user-hostile.

- Use QEMU's `-loadvm` with a pre-made snapshot: on your dev machine,
  boot Wine+game, save state, ship the saved state.
- User resumes in ~5 s instead of cold-booting in 1-2 min.
- Persistent snapshots in OPFS keyed by (base-image-hash, zip-hash).

### Phase 7 — Optimization (ongoing)

- Strip guest kernel (drop unused drivers).
- Trim Alpine rootfs further.
- Cache compiled Wasm modules across sessions.
- Profile TCG hot paths in Safari.

## First-day bootstrap checklist

After cloning qemu-wasm, in a fresh session:

1. Read `README.md` and `docs/` in qemu-wasm.
2. Identify the build script / Dockerfile for the Alpine x86_64 demo
   (likely `examples/alpine-x86_64/`).
3. Build it locally using their documented toolchain (emscripten + Docker
   probably).
4. Host the build output on `localhost` with COOP/COEP headers. One-liner:
   ```bash
   # save as serve-coi.py
   python3 -c "
   import http.server, socketserver
   class H(http.server.SimpleHTTPRequestHandler):
       def end_headers(self):
           self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
           self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
           super().end_headers()
   socketserver.TCPServer(('', 8080), H).serve_forever()"
   ```
5. Open `http://localhost:8080/` in Safari on macOS. Confirm Alpine boots.
6. Connect iPhone via USB. Enable Web Inspector. Open Safari on iPhone,
   point to your Mac's IP. Confirm boot on real device.
7. Record the Phase 0 metrics listed above.

## Major risks (flagged honestly)

| Risk | Likelihood | Mitigation |
|---|---|---|
| Real iPhone OOMs before login | Medium | Strip rootfs, cap guest RAM at 256 MB |
| Phase 1 graphics takes 3-6 months | **High** | Start with VNC/noVNC — ugly but unblocks everything |
| Wine-over-llvmpipe-over-qemu-wasm unplayable slow | **High** | Target only software-renderable games (pixel art, low-poly, pre-2005) |
| `-loadvm` broken in qemu-wasm | Medium | Test early in Phase 0 step 2 |
| OPFS async ↔ 9P sync bridge causes corruption | Medium | Write-through + CRC check on load |
| Upstream qemu-wasm bug nobody's fixed | Medium | Fork, patch, upstream |
| Safari iOS memory cap too low for full VM | Medium | Snapshot-resume avoids cold-boot peak; aggressive Alpine trim |

## Key reference URLs

- **qemu-wasm** — https://github.com/ktock/qemu-wasm
- **qemu-wasm demo** (working reference) — https://ktock.github.io/qemu-wasm-demo/
- **container2wasm** — https://github.com/ktock/container2wasm
- **imagemounter** (the bridge to fork) —
  https://github.com/ktock/container2wasm/tree/main/extras/imagemounter
- **runcontainer.js** (SAB ring protocol — keep verbatim) —
  https://github.com/ktock/container2wasm/blob/main/extras/runcontainerjs/src/web/runcontainer.js
- **9P2000.L server lib** — https://github.com/hugelgupf/p9
- **gvisor-tap-vsock** — https://github.com/containers/gvisor-tap-vsock
- **FOSDEM 2025 talk** (QEMU Wasm overview) —
  https://archive.fosdem.org/2025/schedule/event/fosdem-2025-6290-running-qemu-inside-browser/
- **Safari 26 WebKit features** —
  https://webkit.org/blog/17333/webkit-features-in-safari-26-0/

## Success metrics

- **Phase 0**: iPhone boots Alpine in ≤ 2 min.
- **Phase 1**: canvas shows guest X session.
- **Phase 3**: drop-in zip boots a Linux binary.
- **Phase 4**: Windows `notepad.exe` window visible.
- **Phase 5**: game is interactive + audible.
- **Phase 6**: cold-start ≤ 10 s via snapshot resume.
- **Ship**: one 64-bit indie game playable on iPhone Safari at ≥ 10 fps.

## Honest timeline

- **Working prototype** (one game, ugly UX, ~10 fps): **3-4 months** full-time solo.
- **Shippable** (polish, persistence, multiple games): **7-10 months** full-time solo.

## Things to avoid

- Do not invest in Blink for 64-bit games — wrong tool (no JIT in WASM,
  no fork/threads/networking, Wine crashes on it).
- Do not wait for CheerpX 64-bit — no timeline, closed-source core.
- Do not try to add a WASM backend to box64/Felix86 — multi-person-year.
- Do not skip Phase 0 iPhone test — the whole plan is predicated on it.
- Do not pre-bake games into the wasm module — breaks the Boxedwine UX.
- Do not attempt non-portable (installer-based) games in v1 — that needs
  a separate desktop-side tool (same split Boxedwine has today).

## If stuck

- qemu-wasm issues / discussions: https://github.com/ktock/qemu-wasm/issues
- container2wasm issues: https://github.com/ktock/container2wasm/issues
- Maintainer (@ktock) has given KVM Forum / FOSDEM talks — he is
  reachable and responsive.
