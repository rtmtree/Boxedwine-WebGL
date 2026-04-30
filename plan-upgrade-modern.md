# Plan: Upgrade Boxedwine to Run Modern 32-bit Games

Companion to `PLAN_64BIT_WASM.md`. That plan abandons Boxedwine for QEMU-WASM
to reach 64-bit games. **This plan stays inside Boxedwine** and asks: what
would it take to push the 32-bit path forward to ~2010–2018 era titles?

This is a *scoping* document, not a commitment. It lists what is missing,
what each gap costs, and what a phased rollout would look like.

## Update — second pass on Lighthouse (post bpp + Expose-nudge fixes)

After landing the bpp fix (e342236e) and the Expose-nudge (1aa4fe96), AGS
Software no longer freezes after the first paint and instead pushes
frames continuously to its X11 window. But the *visible* content is
still wrong: a 5-bar Win32-themed pattern (face d4d0c8, highlight
ffffff, mid-shadow 808080, dark-shadow 404040) confined to the leftmost
~80 columns of an otherwise black 328×227 window — no BEGIN/EXIT menu
text. Diagnostics added in 0378662d/afffb2f6 show:

* `XPutImage` reaches `XDrawable::copyImageData` with `bpp=32, bpl=1408,
  width=328, height=227` — the source bitmap is 352 px wide internally
  (1408 = 352 × 4) even though the window is 328 wide. Wine seems to
  pad the DIB section width up to 32-pixel alignment.
* The first ~80 columns of the source bitmap contain the bevel pattern;
  the remaining 248 columns contain solid black. Our copy logic is
  correct (1408-byte src step, 1312-byte dst step, 1312 bytes per row),
  so the bars-on-black is genuinely what AGS / Wine GDI wrote into the
  source bitmap before BitBlt'ing.

That points to one of three upstream culprits, in priority order:

1. **AGS / SDL2 backbuffer width clamped to ~80 px.** If SDL2's
   software renderer creates a backbuffer one quarter of the requested
   width (320 → 80), AGS would draw normally into 80 columns and
   everything past that would be the post-memset zero of Wine's DIB.
   Hypothesis: SDL2's `SDL_RenderCopy` source/dest rectangles are being
   computed against a wrong client-area size in our Wine.
2. **Wine `GetClientRect` returns wrong width.** SDL2 sizes its
   software backbuffer from `GetClientRect`. If Wine's user32 thinks
   the AGS client area is 80 × 227 (instead of 320 × 200), SDL2's
   backbuffer would be 80 wide and we'd see exactly this symptom.
3. **Our X server isn't telling Wine the right window dimensions.**
   Wine queries the X11 attributes when creating its HWND. If our
   `XGetWindowAttributes` returns stale/zero dims, Wine falls back to
   defaults that may be much smaller than the actual window.

Recommended next step: instrument `GetClientRect` / `GetWindowRect` /
`XGetWindowAttributes` reply on the boot-time AGS path, compare to the
328×227 we know the X server has. If the numbers diverge, the fix is
on the X-attributes-reply side.

## Update — Lighthouse (AGS 3.6) shakedown findings

Concrete results from running `project/emscripten/web/lighthouse/` (a
Ludum Dare 59 AGS game, AGS engine v3.6.0, bundled SDL2.dll Oct 2022)
against the existing single-threaded WASM build:

1. **D3D9 driver crashes immediately.** `acsetup.cfg` shipped with
   `driver=D3D9`. The game's first call to a D3D9 vtable returns NULL
   (`Direct3DCreate9` → wined3d → opengl32 → libGL stub fails) and the
   game segfaults with `[seg_access@NULL addr=00000000] eip=...`. This
   matches plan Tier 1 expectations for D3D9 path on WASM.
2. **AGS Software driver doesn't crash but pushes only one frame.**
   Switching `driver=Software` lets the game start, log "Showing Window",
   and emit exactly one `XPutImage` reaching the boxedwine X server.
   After that, the guest's main thread spins in Wine code (eip ≈
   0xD27225BB, a Wine kernel DLL address) without ever pushing another
   frame. The shape of the stall — log line "0024:err:ole:com_get_class_object
   no class object {529a9e6b-…}" appearing repeatedly, plus a thread
   sleeping on a 1ms futex timer — strongly suggests Wine's GDI/SDL2
   path is gated on a Win32 message that never arrives.
3. **Per-frame redraw scheduling regression.** Independent of the above,
   the single-threaded WASM mainloop had REMOVED a per-tick
   `isDisplayDirty=true` force that the multi-threaded build still
   keeps (`source/sdl/multiThreaded/threadedMainloop.cpp:82`). The
   removal was justified by "pushing 1.9MB of pixels to WebGL per tick,
   FPS pinned to ~10," but the side effect is that any game whose
   render loop emits XPutImage at lower frequency than the X server's
   own dirty heuristic samples — including Basstour-style popups — gets
   a frozen canvas. **Patch in this commit:** restore the force-dirty +
   draw at the top of `source/sdl/emscripten/mainloop.cpp` once per
   emscripten frame, with `drawNow=true` to bypass the 16ms throttle.
   This makes the X server re-blit the cached window texture every
   requestAnimationFrame even if the guest hasn't pushed new content.
   Verified: Diablo (`?sw=1`) renders at ~60fps unchanged
   (3032 forced / 2960 putBits over 24s). The patch fixes the
   redraw-scheduling part of the AGS problem but does NOT fix the
   underlying "guest never pushes more frames" issue — that needs work
   inside Wine's SDL2/GDI/X11 chain.
4. **Disabling wined3d / opengl32 doesn't help AGS Software.**
   `&env="WINEDLLOVERRIDES:wined3d=disabled;opengl32=disabled"` changes
   nothing for Lighthouse — it stalls in the same place. So the SDL2 →
   GDI → Wine X11 path is calling something other than wined3d that
   doesn't return.
5. **Removing the bundled SDL2.dll is a non-starter.** Wine's prefix in
   `boxedwine.zip` does not ship `SDL2.dll`, so the game fails at the
   loader (`err:module:import_dll Library SDL2.dll not found`).

### What this means for the plan's priorities

Lighthouse confirms the plan's diagnosis that **Tier 1 graphics
blockers dominate the web target**, but adds a specific shape: the
"force per-frame redraw" hack from the multi-threaded build needs to
come back to single-threaded WASM (now done). Beyond that, modern
SDL2-based games on Wine require a working Wine→host event/expose
pipeline; the boxedwine X server appears to deliver fewer events than
real Wine expects, and games that gate rendering on those events
(AGS-style render loops, Win32 WM_PAINT-driven UIs) freeze even though
the CPU emulator runs fine. This is a separate effort from the SSE3+
ISA work in Road A and the DXVK/D3D11 work in Road B — it's a Wine
event-pump bug that should be added as a new line item.

### Add to the plan: "Road A0 — Fix per-frame redraw + Wine event pump"

Cheap and high-leverage, must land before Road B/C are useful on web:

- Restore force-dirty per emscripten frame in single-thread mainloop
  ([source/sdl/emscripten/mainloop.cpp](source/sdl/emscripten/mainloop.cpp))
  — done in this commit.
- Audit which Win32/X11 messages Wine actually delivers under boxedwine
  for an AGS game. Compare against a real Linux Wine trace.
  Typical suspects: `WM_PAINT`, `WM_ACTIVATE`, `SDL_WINDOWEVENT_EXPOSED`,
  IMM/COM init failures (`msctf.dll` was missing in the prefix).
- Add `msctf.dll` (or a stub) to the Wine prefix so OLE class-object
  lookup for `{529a9e6b-…}` doesn't fail; that GUID is `ITfThreadMgr`,
  used by SDL2 IME init. Repeated failure here may be what gates AGS
  past `SDL_StartTextInput`.
- Effort: 1–2 weeks. Low risk; everything is additive.

## Definition: "modern 32-bit game"

A pragmatic target window — games that shipped 32-bit binaries and ran on
Windows 7/8/10. Concretely:

- **CPU**: SSE3 / SSSE3 / SSE4.1 / SSE4.2, sometimes AVX, often >2 threads.
- **Graphics**: Direct3D 9Ex, Direct3D 10/11 (feature level 10_0 / 11_0),
  shader model 3.0–5.0, OpenGL 3.x core.
- **Audio**: XAudio2, occasionally WASAPI in shared mode.
- **Runtime**: VC++ 2010–2019 redistributables, .NET Framework 4.x
  (sometimes 4.7+), DirectX June 2010 redist.
- **Memory**: 1–3 GB working set in-process (LARGEADDRESSAWARE common).
- **Input**: XInput (Xbox controllers), DirectInput.

Examples in scope: Skyrim 32-bit, Portal 2, Bastion, FTL, Hotline Miami,
Don't Starve, indie Unity 32-bit builds, mid-2010s RPG Maker games.

Out of scope (stays under `PLAN_64BIT_WASM.md`): native 64-bit-only titles,
Vulkan-only titles, anything requiring kernel anti-cheat or DRM that
phones home.

## Current state (snapshot from this repo)

| Area | Today | Source of truth |
|---|---|---|
| Guest CPU | 32-bit x86 only, interpreter on WASM, JIT on native hosts | `source/emulation/cpu/` |
| ISA | x87, MMX, SSE1, SSE2 | `source/emulation/cpu/decoder.h` |
| ISA *missing* | SSE3, SSSE3, SSE4.1, SSE4.2, AVX, AVX2, FMA, BMI, POPCNT | grep returns nothing |
| Wine | 3.1 → 11.0 supported via `tools/buildWine/` | `tools/buildWine/` |
| Graphics | OpenGL (host-translated), Vulkan marshalling, DirectDraw | `source/opengl/`, `source/vulkan/` |
| D3D9/10/11 | **None natively** — relies entirely on Wine's WineD3D → OpenGL | `grep d3d11/d3d10` finds 0 hits in `source/` |
| Audio | SDL2 backend (host-side); Wine emulates DSound/WinMM | `lib/sdl2/src/audio/` |
| XInput | No mapping; controllers unsupported | `docs/Roadmap-Features.md` |
| Threading | Single-thread default; multi-thread mode causes audio stutter on WASM | README known issues |
| Memory | 32-bit address space; WASM build 512 MB initial → 4 GB max | `project/emscripten/makefile` |
| WASM JIT | None (interpreter only) | `project/emscripten/makefile` |

## Gap analysis — what blocks modern 32-bit games

### Tier 1 (hard blockers — game won't even start)

1. **SSE3 / SSSE3 / SSE4.1 / SSE4.2**
   VC++ 2012+ compilers and most Steam-era engines unconditionally emit
   `pshufb`, `palignr`, `roundps`, `pcmpgtq`, `popcnt`. App crashes with
   `#UD` (illegal instruction) on first hit.
   - Effort: medium. Pure decoder work in `decoder.cpp` + interpreter ops
     in `source/emulation/cpu/normal/`. Each instruction is small but
     there are ~150 of them. JIT backends (`x32/`, `x64/`, `armv8/`) need
     parallel additions or fall through to interpreter for new opcodes.

2. **VC++ 2015–2019 redistributables actually working under bundled Wine**
   Most depend on UCRT (`api-ms-win-crt-*.dll`). Wine 6+ ships these but
   needs the right prefix bring-up.
   - Effort: low–medium. Mostly a packaging/docs task in `tools/buildWine/`.

3. **D3D9Ex + D3D10/11 path**
   WineD3D translates to OpenGL, but:
   - host needs OpenGL 3.3+ core (fine on desktop, **WebGL2 ≈ GL ES 3.0**
     in browser — missing geometry shaders, compute, UBOs partially);
   - DXVK (D3D9/10/11 → Vulkan) is the modern path Wine itself uses on
     Linux/macOS. Boxedwine has Vulkan marshalling — wiring DXVK in is
     the highest-leverage single change for graphics.
   - Effort: high on WASM (no Vulkan in browser yet), medium on native.

### Tier 2 (compatibility blockers — game starts then misbehaves)

4. **AVX / AVX2 / FMA**
   Less common in 32-bit binaries but appears in Unity IL2CPP output and
   newer middleware. Often guarded by CPUID checks — easiest mitigation
   is to **lie in CPUID** so the game picks the SSE2 path. Real
   implementation is a separate, larger project.

5. **XAudio2**
   Wine has a working `xaudio2_*.dll` since ~6.0. Surface-level: needs
   the right Wine version and SDL2 audio backend latency tuned.

6. **Multi-threaded scheduler quality**
   Modern engines spawn 4–16 threads. Current scheduler is documented as
   stuttery on WASM-MT. Worth profiling before assuming it's a rewrite.

7. **XInput / gamepad**
   SDL2 has gamepad support; needs glue from SDL events into the guest's
   XInput DLL surface. Listed as TODO in `docs/Roadmap-Features.md`.

### Tier 3 (performance blockers — game runs but unplayably slow)

8. **WASM JIT**
   Interpreter-only WASM is the dominant cost on the web target. Options,
   roughly ordered by feasibility:
   - **Tier the interpreter**: bigger basic blocks, threaded dispatch,
     register caching. Realistic, single-digit-x speedup.
   - **AOT translate hot blocks to WASM at runtime**: WebAssembly does
     not allow runtime codegen in the same module, but the host JS can
     build a new `WebAssembly.Module` and import it. Complex; precedent
     exists (CheerpX, qemu-wasm v3).
   - **Ship pre-translated WASM per game**: fragile, breaks the
     "drop-in zip" UX. Not recommended.

9. **OpenGL → WebGL2 gap**
   WebGL2 ≈ GLES 3.0 with extensions. Geometry shaders, tessellation,
   and compute aren't there. Many D3D11 games will degrade. WebGPU is
   the long-term answer; right now it's a per-game caveat.

## Three credible roads forward

### Road A — "Tier 1 only, ship fast"
Add SSE3/SSSE3/SSE4.1/SSE4.2 to the decoder + normal-CPU interpreter,
update bundled Wine to a version with solid UCRT, document the WASAPI
caveat. Don't touch JIT, don't touch graphics.
- **Unlocks**: a meaningful slice of indie 2D / low-end 3D titles that
  currently `#UD` on launch.
- **Cost estimate**: 2–4 weeks of focused work for the ISA additions
  (interpreter only); validation against a target list is the long tail.
- **Risk**: medium. Each new opcode is small; the surface area is the
  cost.

### Road B — "Tier 1 + DXVK"
Road A plus replacing the WineD3D path with DXVK on the native build,
using the existing Vulkan marshalling. Browser stays on the WineD3D
path until WebGPU.
- **Unlocks**: D3D9Ex/10/11 games on desktop builds; web build still
  capped at D3D9-via-GL.
- **Cost**: add 4–8 weeks for DXVK integration and per-title shakedown.
- **Risk**: medium-high. DXVK assumes Vulkan 1.1+ and a real driver;
  on macOS this funnels through MoltenVK with its own gaps.

### Road C — "Tier 1 + WASM JIT"
Road A plus a real WASM JIT for the guest CPU. Highest-leverage change
for the *web* target specifically.
- **Unlocks**: the difference between "Quake 2 at 5 fps" and "Quake 2
  at 30+ fps" on iPhone, which is the whole point of the web build.
- **Cost**: 3–6 months, prototype to ship. Look at qemu-wasm v3's TCG
  backend before designing — it solves the same problem for x86_64
  and may be partially portable.
- **Risk**: high. Browser JIT-of-JIT is a known-hard problem.

## What this plan is *not*

- Not a path to 64-bit games — that's `PLAN_64BIT_WASM.md`.
- Not a Vulkan-on-the-web story — that needs WebGPU and is upstream of us.
- Not a rewrite. Every item above is additive to the existing tree.

## Recommended first move

Start with **Road A**, scoped to a concrete game list (pick 5–10 titles
that currently fail at launch). The decoder/interpreter work is the
cheapest high-confidence win and *every* later road needs it anyway.
Treat Road B and Road C as independent follow-ups gated on whether the
desktop or the web build is the priority.

## Open questions before committing

1. Which target — desktop builds, web build, or both? They diverge at
   Road B vs Road C.
2. Acceptable Wine version floor? Newer Wine = better D3D, more memory,
   slower under emulation.
3. Is "lie in CPUID to hide AVX" acceptable as a permanent mitigation,
   or do we want real AVX someday?
4. Is the test set Steam-installed games (DRM, requires login) or
   GOG/standalone? Affects the validation harness.
