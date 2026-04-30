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

#ifndef __NORMAL64_CPU_H__
#define __NORMAL64_CPU_H__

#ifdef BOXEDWINE_64BIT_GUEST

#include "cpu64.h"

// Pure-interpreter implementation of CPU64. Decodes one x86_64 instruction
// at a time, executes it, advances RIP. No JIT — the wasm target is
// interpreter-only by necessity.
class Normal64CPU : public CPU64 {
public:
    Normal64CPU(KMemory* memory);

    // From CPU64.
    void run() override;

    // Decode + execute a single instruction starting at RIP. Returns the
    // new RIP. Used by run() and (later) by per-instruction debugging.
    U64 stepOne();

private:
    // Read one instruction byte from guest memory at the given linear addr.
    U8 fetch8(U64 addr);
    U16 fetch16(U64 addr);
    U32 fetch32(U64 addr);
    U64 fetch64(U64 addr);
};

#endif // BOXEDWINE_64BIT_GUEST
#endif // __NORMAL64_CPU_H__
