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

#include "boxedwine.h"

#ifdef BOXEDWINE_64BIT_GUEST

#include "normal64CPU.h"
#include "kmemory.h"

Normal64CPU::Normal64CPU(KMemory* memory) : CPU64(memory) {
}

U8 Normal64CPU::fetch8(U64 addr) {
    // KMemory's read API is U32 today (32-bit guest address space). For
    // a first-pass 64-bit guest we cap the linear address at 4 GB by
    // truncating; that's enough to load + run a static ELF whose entry
    // point is in the canonical low 4 GB. Long-term we widen KMemory.
    return memory->readb((U32)addr);
}

U16 Normal64CPU::fetch16(U64 addr) {
    return memory->readw((U32)addr);
}

U32 Normal64CPU::fetch32(U64 addr) {
    return memory->readd((U32)addr);
}

U64 Normal64CPU::fetch64(U64 addr) {
    return memory->readq((U32)addr);
}

// Step a single x86_64 instruction. Returns the new RIP.
//
// This implementation handles only the *minimum* set required to run a
// hand-rolled `_exit(0)` ELF — phase A4 of PLAN_BOXEDWINE_64BIT.md:
//
//   48 c7 c0 3c 00 00 00      mov rax, 60       ; sys_exit on x86_64
//   48 c7 c7 00 00 00 00      mov rdi, 0        ; status code
//   0f 05                      syscall
//
// Each subsequent session will widen this dispatcher one opcode at a
// time. Anything we don't yet decode raises kpanic_fmt with the offending
// bytes — better a fast clear failure than a silent wrong-result.
U64 Normal64CPU::stepOne() {
    U64 ip = rip;
    U8 b0 = fetch8(ip);
    U8 rex = 0;

    // Optional REX prefix: 0x40..0x4F. Captures W (operand size = 64),
    // R (extends ModR/M reg), X (extends SIB index), B (extends ModR/M
    // r/m or opcode reg).
    if ((b0 & 0xF0) == 0x40) {
        rex = b0;
        ip++;
        b0 = fetch8(ip);
    }

    bool rexW = (rex & 0x08) != 0;
    bool rexB = (rex & 0x01) != 0;

    // Opcode dispatch — only the three instructions we need today.
    switch (b0) {
        case 0xC7: {
            // C7 /0 imm32  → mov r/m32, imm32 (sign-extended to 64 if REX.W)
            U8 modrm = fetch8(ip + 1);
            U8 mod = modrm >> 6;
            U8 reg_op = (modrm >> 3) & 7;     // /0 means reg field == 0
            U8 rm = modrm & 7;
            if (mod != 0xC0 >> 6 /* 11b: register direct */) {
                kpanic_fmt("Normal64CPU: C7 with mod=%d not implemented", mod);
            }
            if (reg_op != 0) {
                kpanic_fmt("Normal64CPU: C7 /%d not implemented", reg_op);
            }
            U32 imm = fetch32(ip + 2);
            U8 dst = rm | (rexB ? 8 : 0);
            if (rexW) {
                // Sign-extend imm32 to 64 bits.
                reg[dst].q = (U64)(S64)(S32)imm;
            } else {
                // Without REX.W: 32-bit write zero-extends to 64 bits per
                // x86_64 semantics.
                reg[dst].q = (U64)imm;
            }
            return ip + 6; // 1 opcode + 1 modrm + 4 imm
        }

        case 0x0F: {
            U8 b1 = fetch8(ip + 1);
            if (b1 == 0x05) {
                // syscall — Linux x86_64 ABI: rax=number, args in rdi,
                // rsi, rdx, r10, r8, r9. Result in rax. Phase B will
                // wire this to KSystem; for now panic so we know we
                // got here.
                kpanic_fmt("Normal64CPU: syscall reached, rax=%llu rdi=%llu rsi=%llu",
                           (unsigned long long)reg[0].q,
                           (unsigned long long)reg[7].q,
                           (unsigned long long)reg[6].q);
                return ip + 2;
            }
            kpanic_fmt("Normal64CPU: 0F %02X not implemented", (int)b1);
            return ip + 2;
        }

        default:
            kpanic_fmt("Normal64CPU: opcode %02X at rip=%llx not implemented",
                       (int)b0, (unsigned long long)ip);
            return ip + 1;
    }
}

void Normal64CPU::run() {
    while (!yield) {
        rip = stepOne();
        instructionCount++;
    }
}

#endif // BOXEDWINE_64BIT_GUEST
