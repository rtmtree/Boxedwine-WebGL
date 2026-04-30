# Plan: Upgrade Boxedwine-WebGL to 64-bit

Sister to:
- `plan-upgrade-modern.md` (stays 32-bit, pushes the 32-bit path to ~2018-era games)
- `PLAN_64BIT_WASM.md` (abandons Boxedwine, switches to QEMU-Wasm)

**This plan asks the third question:** can we add x86_64 to Boxedwine itself?

It is grounded in what just shipped on the 32-bit path — the AGS Lighthouse
fix lineage (commits e342236e through b23c827e). We now have a working,
*responsive* 32-bit pipeline rendering modern AGS games with text, sprites,
and click input. The components proven in that work are the prerequisites
for any 64-bit attempt: the X server, the GDI/BitBlt path, the Wine prefix,
the SDL audio fallback, the `SDL_RENDER_DRIVER=software` hint, and the
Expose-nudge event-pump.

## Why a third plan exists

`PLAN_64BIT_WASM.md` lists "Boxedwine itself is 32-bit x86 only.
Architectural blocker for 64-bit" as a pre-validated reason to abandon it.
That conclusion is true *as written today* but it is a property of the CPU
emulator, not of the rest of the project. The X server, the GDI bridge, the
SDL backend, the Wine integration, and the WebAssembly build pipeline are
all bitness-agnostic — they operate on byte buffers and FDs. The 32-bit-ness
lives in three concrete places, listed below.

If those three places are addressable, *the rest of the project ports for
free* (or close to it), and we keep the things the 32-bit path proved are
hard to replicate elsewhere: the no-cold-start UX, the zip-drop install
flow, the iPhone-tested input/audio/canvas plumbing, and the rendering
fixes we just shipped.

## Where the 32-bit-ness actually lives

Searched against the current tree:

1. **The CPU emulator** — `source/emulation/cpu/`
   - `decoder.h` / `decoder.cpp` decode 32-bit x86 (no REX prefixes, no
     RIP-relative addressing, no `mov reg, imm64`).
   - `normal/` is a 32-bit interpreter; `dynamic/` and the asmjit-based
     JITs (`x32`, `x64`, `armv8`) translate 32-bit guest insts to host.
   - All registers in `CPU` are `U32`. `EAX/EBX/...` not `RAX/RBX/...`.
   - This is **the only architectural blocker**.

2. **The kernel ABI** — `source/kernel/syscalls.cpp`,
   `source/kernel/syscalls/*`
   - Every linux syscall is wired against `i386` ABI numbers.
   - `kthread.cpp` thread layout assumes `int 0x80` and 32-bit syscall
     argument convention.
   - `KMemory` paging is 4 KB pages × 32-bit linear address (4 GB max).
   - Re-implementable in ~weeks once the CPU is decided.

3. **The Wine prefix bundled in `boxedwine.zip`** — built by
   `tools/buildWine/`
   - Today: 32-bit Wine (`wine`, no `wine64`), 32-bit `winex11.drv`,
     32-bit `wineserver`.
   - For 64-bit guests we need a separate Wine64 prefix.
   - This is a packaging task once the kernel can run 64-bit ELFs.

The X11/X server (`source/x11/`), the SDL screen / audio / input bridges
(`platform/sdl/`, `source/sdl/`), and the emscripten build (`project/emscripten/`)
have **no 32-bit assumptions** beyond passing `U32` for guest pointers in a
few places.

## Definition: "lightweight 64-bit Windows games"

To stay honest with what's actually shippable on iPhone Safari (256–512 MB
practical RAM, no GPU passthrough, no JIT-in-page), v1 targets:

- Indie 64-bit titles, software-rasterizable (pixel-art, 2D, low-poly).
- Wine64-compatible (i.e. don't need DX12, no kernel anti-cheat, no DRM).
- ≤ 1 GB working set in-process, ≤ 4 GB max.
- VC++ 2015–2022 redistributables.
- DirectX9–11 via WineD3D's GL path or DXVK-via-software-Vulkan (later).

Out of scope for v1: AAA titles, AVX-512, Vulkan-only, anything needing
real GPU access.

## Three credible roads

Each road tries to dodge the multi-person-year cost of writing a brand-new
x86_64 emulator from scratch.

### Road 1 — Compile blink's x86_64 interpreter into Boxedwine

[blink](https://github.com/jart/blink) is a small (~5 kLOC) MIT-licensed
x86_64 user-mode emulator written in clean C99. It has no JIT (interpreter
only), which matches our wasm constraints, and it already supports the full
SSE / SSE2 / SSE3 / SSSE3 / SSE4.1 / SSE4.2 ISA we need for 2018-era games.

**The idea**: gut blink's "linux-host" parts (its tiny syscall layer, its
mmap loader) and slot it into Boxedwine as an *alternative* CPU
implementation alongside `normal/`. blink runs the guest instructions; the
existing Boxedwine kernel handles syscalls; the existing Boxedwine X server
+ SDL bridge handles graphics.

**Cost**: 6–10 weeks for a working 64-bit interpreter inside Boxedwine,
**provided** blink's interpreter is callable as a library. PLAN_64BIT_WASM
notes blink "Wine attempts crash at `VfsFcntl`" — but that's blink's *own*
syscall layer, not a CPU bug. We'd be replacing exactly that layer.

**Risk**: medium. We don't know yet whether blink's interpreter is cleanly
factorable from blink's userspace; it might be deeply entangled. Need a
half-day spike to confirm.

**Performance**: blink's interpreter is roughly the same speed as
Boxedwine's `normal/` interpreter — so 32-bit and 64-bit guests would run
at similar fps in the browser. No regression.

### Road 2 — Manual SSE3+ extension on the existing 32-bit path

This is `plan-upgrade-modern.md` Road A taken to completion. It does *not*
get us to 64-bit games — but a meaningful number of titles people *call*
"64-bit" only require SSE3/SSSE3/SSE4.1/SSE4.2 in the CPU and would
actually run on the 32-bit path if Wine has the right DLLs. This road
costs ~2–4 weeks and is well understood.

**Use this as a control variable.** If Road 1 stalls, Road 2 still ships
something useful, and the AGS / SDL2 / Wine event-pump fixes from this
session apply identically.

### Road 3 — Run QEMU-Wasm in parallel as a separate target

This is `PLAN_64BIT_WASM.md`. It abandons Boxedwine for the 64-bit case
but keeps Boxedwine for the 32-bit case. Two binaries, two UXs. Worst-of-
both-worlds for ops, but it's the only road that's already been proven on
real hardware (the maintainer's demo boots Alpine x86_64 to login on
iPhone Safari). Treat this as the **fallback if Road 1 is intractable**.

## Recommended sequencing

1. **Week 0 (this session's wrap-up): freeze the 32-bit baseline.**
   The bpp + Expose + render-driver fixes that just shipped are the
   regression baseline for everything below. Tag the commits, write the
   AGS Lighthouse renders-correctly result into a manual smoke-test list
   (title screen with BEGIN/EXIT visible, hover tooltip "Telescope" fires).

2. **Week 1: Road 1 spike — blink-as-a-library.**
   Half-day question: can `blink/blink/main.c` be reduced to "given a
   buffer of x86_64 bytes and a fake-syscall callback, step it"? If yes
   in a day, Road 1 is on. If we hit a snag, log it and move on.

3. **Weeks 2–10: Road 1 build.**
   Detailed below.

4. **Parallel weeks 2–6: Road 2 (SSE3+ ISA).**
   Independent track. One person can do it solo. Pays off whether or not
   Road 1 succeeds.

5. **Week 11+: integrate or pivot.**
   If Road 1 demoes a 64-bit ELF running through Boxedwine's kernel,
   continue to Wine64 prefix work. If it doesn't, switch the 64-bit
   target to Road 3 (QEMU-Wasm), keeping Road 2 + the Lighthouse fixes
   as the 32-bit-path improvements.

## Road 1 in detail

### Phase A — CPU swap-out (weeks 2–4)

Goal: 64-bit user-mode ELF binaries decode and execute *without* talking
to a kernel. A "hello world" that just exits.

Tasks:

- A1. Add `source/emulation/cpu/blink/` mirroring the existing `normal/`,
  `dynamic/`, etc. layout. One file per blink translation unit.
- A2. Define the abstract CPU interface that `normal/` already implements:
  ```cpp
  class CPU {
      virtual void run() = 0;
      virtual void interrupt(U32 num) = 0;
      virtual void sigret() = 0;
      virtual U64 readReg(...) = 0;
      // ...
  };
  ```
  blink's CPU becomes another concrete implementation.
- A3. Wire `KSystem::isCpu64()` and a build flag `BOXEDWINE_64BIT_GUEST`.
  Both 32-bit and 64-bit guests live in the same binary; the kernel
  dispatches based on the loaded ELF's class.
- A4. Implement the loader: `source/io/elf.cpp` already handles ELF32;
  add `ELF64` branch that allocates an x86_64 process layout (linear
  64-bit address space, but reasonable cap of e.g. 4 GB to fit in wasm32
  memory).

**Gate**: a static x86_64 ELF that does `int 0x80; sys_exit` exits
cleanly through Boxedwine's kernel. ~5 instructions of guest code,
verified end-to-end.

### Phase B — Syscall ABI glue (weeks 5–6)

Goal: 64-bit `syscall`/`sysenter` and the corresponding ABI wired through
Boxedwine's existing syscall handlers.

Tasks:

- B1. Add `source/kernel/syscalls64.cpp` mirroring `syscalls.cpp`. Most
  syscall *handlers* are bitness-independent (they take guest pointers
  and return ints) — only the *dispatch table* and *argument
  marshalling* differ.
- B2. Translate the i386 syscall numbers to the x86_64 numbers (different
  numbering — e.g. `read` is 3 on i386, 0 on x86_64). One static table.
- B3. Update `kthread.cpp`'s syscall entry to read 64-bit registers when
  the calling thread is a 64-bit thread.
- B4. Adjust `KMemory` to allocate guest mappings in a 64-bit virtual
  address space. The host backing store stays as 4 KB pages of host
  memory; only the guest-side address arithmetic changes.

**Gate**: a static x86_64 ELF that calls `write(1, "hello\n", 6)` outputs
to stdout via Boxedwine's TTY.

### Phase C — Dynamic linker + libc (week 7)

Goal: a glibc-linked 64-bit Linux ELF runs.

This is the cheapest phase because Boxedwine's loader already handles
shared objects. The work is:

- C1. Bundle a 64-bit `ld-linux-x86-64.so.2` and a 64-bit glibc into a
  separate 64-bit prefix zip.
- C2. The ELF interpreter path comes from the ELF's `PT_INTERP`; just
  make sure the 64-bit interpreter is on the file system at the path
  the ELF expects.

**Gate**: a glibc-linked `ldd /bin/cat` and `cat /etc/passwd` work.

### Phase D — Wine64 prefix (weeks 8–9)

Goal: `wine64 notepad.exe` opens a window inside Boxedwine.

- D1. Adapt `tools/buildWine/` to build Wine 9.0 with `--enable-win64`
  and produce a 64-bit prefix zip alongside the 32-bit one.
- D2. Pick which DLL set to ship: the same WineD3D / OpenGL path the
  32-bit prefix uses, plus `dxvk` later. Defer DXVK.
- D3. Ship `wine64`, `wineserver64`, `winex11.drv` (64-bit), the Win64
  system32 set.
- D4. URL parameter wiring: `?app64=foo&p=Foo.exe` opt-in. Auto-detect
  by reading PE machine type from the dropped exe is a stretch goal.

**Gate**: notepad.exe window with a typed character visible in the canvas.

### Phase E — First 64-bit game (week 10)

Same shape as `plan-upgrade-modern.md`'s Road A0 work for AGS Lighthouse:
identify the cheapest 64-bit indie that's known to run on Linux Wine64,
get it to render. The BitBlt / X11 / SDL fixes from this session
(SDL_RENDER_DRIVER=software, msctf disable, audio dummy, expose nudge,
bpp fix) all transfer unchanged.

Candidate first targets, ranked easiest → harder:

1. AGS Lighthouse rebuilt as 64-bit (if the AGS toolchain offers it) —
   unlocks the entire `tools/buildWine` smoke-test we already wrote.
2. A small 64-bit DOOM port via Chocolate Doom or Crispy Doom.
3. A 64-bit Unity build of a tiny indie (Unity has solid Wine64 support).

**Ship gate**: at least one 64-bit game playable on iPhone Safari at ≥
10 fps with the same zip-drop UX as the 32-bit path.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| blink's interpreter isn't cleanly factorable | Medium | Week-1 spike. If yes in a day, on. If not, pivot to Road 3 with no work lost. |
| 64-bit Wine prefix bloats `boxedwine.zip` past iOS Safari memory | Medium | Ship as separate zip, lazy-load only when `?app64=` requested. Same trick we already use for game zips. |
| Wine64 has different bug surface than Wine32 — AGS-Lighthouse-style rendering bug returns | Medium | Keep the diagnostic exports (`diagDumpWindows`, `diagDumpWindowLine`, the per-PutImage logger from afffb2f6/0378662d) — they were essential to find the SDL_RENDER_DRIVER fix and will be again. |
| blink interpreter slower than expected — ~3 fps in Safari | Medium-High | Realistic. v1 ships only software-renderable games; AAA is out of scope by design. |
| Two-binary maintenance burden | Low | The 32-bit binary stays. The 64-bit additions are *additive* under a build flag. Day-to-day Lighthouse work doesn't break. |
| Some 64-bit titles need libGL ≥ 3.3 / GLES 3.0 / WebGL2 features Boxedwine doesn't expose | Medium | Same caveat as 32-bit (`plan-upgrade-modern.md` Tier 2). Per-game allow-list. |

## What this plan is NOT

- **Not a hot-rebuild** of Boxedwine. The existing 32-bit path keeps
  working; the AGS Lighthouse fix lineage is the regression baseline,
  not a sacrifice.
- **Not a rejection of `PLAN_64BIT_WASM.md`**. That plan is the right
  fallback if Road 1 stalls. It's not the right *first* attempt because
  it throws away every UX/integration win Boxedwine has.
- **Not a JIT story.** v1 is interpreter-only on 64-bit. WASM JIT is
  Road C in `plan-upgrade-modern.md`, and it applies equally to 32-
  and 64-bit guests; it's an orthogonal track.
- **Not a graphics overhaul.** Every graphics fix from the 32-bit path
  (SDL_RENDER_DRIVER=software, BitBlt bpp handling, expose nudge,
  msctf disable, audio dummy) carries over identically.

## Open questions before committing

1. Is blink's interpreter actually slot-in-able? **Spike day 1.** If no,
   pivot to Road 3.
2. Wine version floor for 64-bit prefix — Wine 9 (current stable), Wine 8
   LTS, or rebuild against Wine staging? Newer = more games, slower under
   emulation.
3. Do we actually need both 32-bit and 64-bit binaries shipped, or do we
   transition entirely to 64-bit once it works? (The 64-bit binary can
   run 32-bit ELFs via the existing CPU — at the cost of carrying both
   CPUs always.)
4. Should the URL UX be `?app64=foo` or auto-detect from PE machine?
   Auto-detect is friendlier but means parsing PE header on the JS side.

## Success metrics

- **Spike day 1**: blink reduces to "step bytes, callback for syscalls"
  in < 100 lines of glue, or doesn't.
- **Phase A gate**: x86_64 `_exit` ELF runs through Boxedwine.
- **Phase C gate**: glibc-linked `cat /etc/passwd` works.
- **Phase D gate**: `wine64 notepad.exe` opens a window.
- **Phase E gate**: one 64-bit indie playable on iPhone Safari at ≥ 10 fps.
- **Ship**: same UX as today (`?app=foo&p=Foo.exe`), 32-bit and 64-bit
  paths live in one tree, no regression on the AGS Lighthouse
  smoke-test.

## Honest timeline

- **Day 1 spike**: half a day.
- **Working 64-bit "hello world"** through Boxedwine: 2–3 weeks
  full-time after a positive spike.
- **`wine64 notepad`** rendering: 8–10 weeks total.
- **One 64-bit game playable**: 10–13 weeks total.
- **Shippable 64-bit path** alongside 32-bit: 4–5 months total.

These numbers assume one engineer. They are 2–3× faster than rolling a
new x86_64 emulator from scratch and 2–3× slower than `PLAN_64BIT_WASM`'s
QEMU-Wasm route — but they preserve the entire Boxedwine UX and all the
debugging infrastructure we just built.

## Day-1 bootstrap

```bash
# spike: figure out if blink is library-able
git clone https://github.com/jart/blink.git
cd blink
# read blink/blink/main.c and blink/blink/cpu.h
# specifically: can RunLoop() be called with a custom syscall callback?
# answer in half a day, log result, move on
```

Then, if positive:

```bash
# in this repo
mkdir -p source/emulation/cpu/blink
# copy blink's runtime files (NOT its userspace / loader / syscalls)
# wire BOXEDWINE_64BIT_GUEST build flag in project/emscripten/makefile
# stub out the 64-bit ELF loader in source/io/elf.cpp
# write the smallest possible x86_64 _exit ELF, run it
```

## Things to avoid

- Do not rewrite Boxedwine's CPU layer from scratch — the architectural
  cost is the same as writing a new x86_64 emulator; pick blink instead.
- Do not invest in box64/FEX/Felix86 WASM backends — multi-person-year,
  same as `PLAN_64BIT_WASM` flagged.
- Do not break the 32-bit path. Every change goes behind a build flag
  until 64-bit is at parity.
- Do not skip the Phase A "hello world" gate. It's 2 days of work and
  the entire rest of the plan rests on it.
- Do not ship 64-bit and 32-bit in two separate URLs / domains. The
  Boxedwine UX (one URL, one canvas, drop-zip-and-go) is the moat.

## If stuck

- blink upstream — https://github.com/jart/blink/issues
- Wine on Wayland / Xvfb FAQ — https://wiki.winehq.org/FAQ
- Existing Boxedwine 32-bit JIT is a useful reference for "swap a CPU
  layer cleanly" — `source/emulation/cpu/x32/`,
  `source/emulation/cpu/x64/`, `source/emulation/cpu/armv8/`.

## Where this plan was written from

- The just-shipped Lighthouse fix lineage (commits e342236e, 921a452f,
  1c104b15, ab5c15d1, 1aa4fe96, afffb2f6, 0378662d, 2c4672b8, b23c827e
  — see `git log --oneline`).
- The two existing planning docs in this repo (`plan-upgrade-modern.md`,
  `PLAN_64BIT_WASM.md`).
- The diagnostic exports we added in this session
  (`diagDumpWindows`, `diagDumpWindowLine`, the per-PutImage logger).

Concrete next step is a half-day spike on blink. Everything else is
contingent on that result.
