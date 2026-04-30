# 64-bit CPU layer

Parallel to `source/emulation/cpu/` (the 32-bit x86 CPU). Built only when
`BOXEDWINE_64BIT_GUEST` is defined. The 32-bit path is untouched.

## Files

- `cpu64.h` / `cpu64.cpp` — abstract `CPU64` base class + register state.
- `normal64CPU.h` / `normal64CPU.cpp` — interpreter implementation.
- `decoder64.h` / `decoder64.cpp` — x86_64 instruction decoder
  (REX prefix, RIP-relative addressing, 64-bit operand size).
- `instructions64.h` — opcode tables (currently stub).
- `elf64.h` / `elf64.cpp` — ELF64 loader (separate from `source/io/elf.cpp`'s
  ELF32 path; eventually consolidate).

## Status (this commit)

Scaffolding only. `CPU64::run()` panics with "not implemented" so we can
verify the build wires up before any guest code actually executes.

## Phased rollout (per PLAN_BOXEDWINE_64BIT.md Phase A)

1. ☐ Class hierarchy + build flag (this commit).
2. ☐ ELF64 loader: detect ELFCLASS64, set up 64-bit memory map, jump to entry.
3. ☐ Decoder64: handle REX, ModR/M with R8-R15, 64-bit displacement.
4. ☐ Three-instruction interpreter: `mov rax, imm32` (sign-extended),
   `mov rdi, 0`, `syscall`. Enough to run a static `_exit(0)` ELF.
5. ☐ Syscall ABI bridge: x86_64 `syscall` → Boxedwine's existing
   `KSystem::call` (translating syscall numbers from x86_64 to the
   existing i386 dispatch table; see `syscalls.cpp`).

## Why a separate tree, not a refactor of `cpu/`

- Zero risk to the 32-bit path. The Lighthouse fix lineage (commits
  e342236e..b23c827e) is the regression baseline.
- 64-bit registers are 16 × 8 bytes = 128 bytes vs. 9 × 4 = 36 bytes for
  32-bit — different memory layout, different ModR/M tables, different
  ABI. Keeping them separate is cheaper than parameterizing.
- When 64-bit reaches parity, we can choose to merge or keep parallel.

## Why blink isn't directly imported here

`PLAN_BOXEDWINE_64BIT.md` proposes blink as the interpreter. The day-1
spike confirmed `ExecuteInstruction(struct Machine *m)` is a clean
per-instruction entry point and JIT is optional (`HAVE_JIT`).

But blink is ~58k LOC and is built around its own `struct Machine` and
`struct System` that duplicate Boxedwine's `CPU` + `KSystem`. Importing
the whole thing would inflate the wasm by ~500 KB and force us to
maintain a parallel runtime.

The pragmatic plan: keep this directory as the integration point, port
blink's instruction implementations file-by-file as needed (alu, sse,
strings, fpu, etc.), translating their `Machine *m` accesses to
`CPU64 *cpu`. Each ported instruction is ~50 lines; we'll cherry-pick.
