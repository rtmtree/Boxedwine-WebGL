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

#include "cpu64.h"
#include "normal64CPU.h"

CPU64::CPU64(KMemory* m) {
    this->memory = m;
    reset();
}

void CPU64::reset() {
    for (int i = 0; i < 16; i++) {
        reg[i].q = 0;
        for (int j = 0; j < 16; j++) xmm[i][j] = 0;
    }
    rip = 0;
    // x86_64 default RFLAGS: bit 1 reserved-and-set, others 0.
    rflags = 0x2;
    mxcsr = 0x1F80;
    instructionCount = 0;
    yield = false;
}

CPU64* CPU64::allocCPU64(KMemory* memory) {
    return new Normal64CPU(memory);
}

#endif // BOXEDWINE_64BIT_GUEST
