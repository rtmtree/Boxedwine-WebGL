/*
 *  Copyright (C) 2012-2025  The BoxedWine Team
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, write to the Free Software
 *  Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA 02111-1307, USA.
 */

#ifndef __CPU64_H__
#define __CPU64_H__

#ifdef BOXEDWINE_64BIT_GUEST

class KMemory;
class KThread;

// 64-bit register file. x86_64 has 16 GPRs (rax, rcx, rdx, rbx, rsp, rbp,
// rsi, rdi, r8..r15), each 64-bit, with 32/16/8-bit aliases. Index map
// matches the standard x86_64 register encoding so ModR/M decode can use
// it directly.
//
// We avoid `u8`/`u16`/`u32`/`u64` field names because the existing 32-bit
// `cpu.h` exposes them as macros (`#define u16 word[0]` etc) — distinct
// names keep the two register files from colliding when both headers end
// up in the same TU.
union Reg64 {
    U64 q;        // full 64-bit value (rax, rcx, ...)
    U32 d;        // low 32 — eax, ... — writes auto-zero-extend per ABI
    U16 w;        // low 16 — ax, ...
    U8  bl_;      // low 8 — al, cl, ... (also r8b..r15b under REX)
    U8  bytes[8];
};

class CPU64 {
public:
    CPU64(KMemory* memory);
    virtual ~CPU64() {}

    // 16 64-bit GPRs. Indices are the standard x86 register codes:
    //   0=RAX 1=RCX 2=RDX 3=RBX 4=RSP 5=RBP 6=RSI 7=RDI
    //   8=R8  9=R9  10=R10 11=R11 12=R12 13=R13 14=R14 15=R15
    Reg64 reg[16];

    // 16 128-bit XMM regs (xmm0..xmm15). Plain byte storage so we don't
    // depend on the existing SSE union's macro-laden field names.
    U8 xmm[16][16];

    // Instruction pointer — RIP. Note: x86_64 has 64-bit RIP, but most
    // programs run within the lower 4 GB / 47-bit canonical region. We
    // keep it U64 for correctness.
    U64 rip = 0;

    // RFLAGS (64-bit; high 32 bits are reserved).
    U64 rflags = 0;

    // SSE control / FPU state — same conceptual content as 32-bit CPU,
    // wider where the ISA dictates. Stub for now.
    U32 mxcsr = 0x1F80;

    KMemory* memory = nullptr;
    KThread* thread = nullptr;

    U64 instructionCount = 0;
    bool yield = false;

    // Subclasses (Normal64CPU, eventual JIT64CPU) implement run().
    // Default semantics: run until yield / halt / signal.
    virtual void run() = 0;

    // Reset to a clean state — called from KThread setup.
    virtual void reset();

    // Convenience accessors. Inline so they cost nothing.
    U64& rax() { return reg[0].q; }
    U64& rcx() { return reg[1].q; }
    U64& rdx() { return reg[2].q; }
    U64& rbx() { return reg[3].q; }
    U64& rsp() { return reg[4].q; }
    U64& rbp() { return reg[5].q; }
    U64& rsi() { return reg[6].q; }
    U64& rdi() { return reg[7].q; }

    static CPU64* allocCPU64(KMemory* memory);
};

#endif // BOXEDWINE_64BIT_GUEST
#endif // __CPU64_H__
