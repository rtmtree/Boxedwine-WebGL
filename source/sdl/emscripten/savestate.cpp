/*
 *  Save/Load State for BoxedWine Emscripten
 *
 *  Approach: snapshot the *entire wasm linear memory* (minus the transient
 *  stack region) so that every C++ kernel object — KThread, KProcess,
 *  KTimer/KTimerCallback, BoxedWineCondition, XServer/XWindow, shared_ptr
 *  control blocks, JIT'd code pages, and the emulated RAM alike — is
 *  captured bit-for-bit. The restored image maps pointer-for-pointer onto
 *  the identical wasm module, so function-table indices and vtable slots
 *  still resolve correctly even after a full page reload.
 *
 *  The save stream is (addr, flag, [data]) triples where flag indicates:
 *      0 = zero page (no data follows)
 *      1 = raw page (4KB follows)
 *      2 = deduplicated reference (U32 reference-addr follows)
 *
 *  Dedup uses a fixed-size open-addressed hash table kept in BSS so nothing
 *  is allocated during save/load — any malloc during save would reshape the
 *  heap we're busy copying.
 *
 *  Chunks live on the JS heap (outside wasm memory) for both save and load,
 *  so the wasm heap doesn't have to double-buffer the multi-GB image.
 */

#ifdef __EMSCRIPTEN__

#include "boxedwine.h"
#include <emscripten.h>

#ifndef BOXEDWINE_MULTI_THREADED

#include <cstring>

// emscripten stack API — provided by the emscripten runtime
extern "C" {
    U32 emscripten_stack_get_base();
    U32 emscripten_stack_get_end();
}

#define STATE_MAGIC 0x53584242 // "BXWS"
// Version 5: full wasm-heap snapshot. Earlier versions only captured
// emulated RAM + thread CPU state, which left Wine's native C++ kernel
// objects dangling after a page reload. A v5 image is a superset — all of
// v4's data is implicitly covered because every KThread / KTimer /
// BoxedWineCondition lives inside the wasm heap too.
#define STATE_VERSION 5

#define CHUNK_SIZE 4096 // must divide every address emitted

// Chunk kind tags.
#define CHUNK_ZERO  0
#define CHUNK_RAW   1
#define CHUNK_DEDUP 2

// Fixed-capacity dedup hash table — lives in BSS so it does not disturb the
// dynamic heap while we're snapshotting it. 128K slots × 12 bytes each.
#define DEDUP_SLOTS (1u << 17)
struct DedupSlot {
    U32 hash;
    U32 addr;
    U32 used;
};
static DedupSlot dedupTable[DEDUP_SLOTS];

static volatile bool saveStateRequested = false;
static volatile bool loadStateRequested = false;
static volatile bool stateOpDone = false;
static volatile bool stateOpSuccess = false;

#pragma pack(push, 1)
struct StateHeader {
    U32 magic;
    U32 version;
    U32 heapSize;   // HEAPU8.length at save time
    U32 stackEnd;   // lower bound of skipped stack range (inclusive)
    U32 stackBase;  // upper bound of skipped stack range (exclusive)
};
#pragma pack(pop)

// ---------- JS streaming bridge (unchanged from earlier versions) ----------

static void saveBegin() {
    EM_ASM({ window.__boxedwineSaveBegin && window.__boxedwineSaveBegin(); });
}
static void saveChunk(const void* data, U32 len) {
    EM_ASM({ window.__boxedwineSaveChunk && window.__boxedwineSaveChunk($0, $1); }, (U32)data, len);
}
static bool saveEnd() {
    int ok = EM_ASM_INT({ return (window.__boxedwineSaveEnd && window.__boxedwineSaveEnd()) ? 1 : 0; });
    return ok != 0;
}

static int loadReadBytes(void* dst, U32 len) {
    return EM_ASM_INT({ return (window.__boxedwineLoadRead && window.__boxedwineLoadRead($0, $1)) || 0; }, (U32)dst, len);
}
static bool loadRead(void* dst, U32 len) {
    return (U32)loadReadBytes(dst, len) == len;
}

// ---------- helpers ----------

static bool chunkIsZero(const U8* p) {
    const U64* q = reinterpret_cast<const U64*>(p);
    for (U32 i = 0; i < CHUNK_SIZE / sizeof(U64); i++) {
        if (q[i]) return false;
    }
    return true;
}

// Cheap 32-bit FNV-1a-ish mix over a 4KB chunk.
static U32 chunkHash(const U8* p) {
    const U32* q = reinterpret_cast<const U32*>(p);
    U32 h = 0x811C9DC5u;
    for (U32 i = 0; i < CHUNK_SIZE / sizeof(U32); i++) {
        h ^= q[i];
        h *= 0x01000193u;
    }
    return h ? h : 1; // reserve 0 for "empty slot"
}

static bool rangeOverlapsStack(U32 addr, U32 stackEnd, U32 stackBase) {
    // chunk covers [addr, addr+CHUNK_SIZE)
    U32 chunkEnd = addr + CHUNK_SIZE;
    return !(chunkEnd <= stackEnd || addr >= stackBase);
}

// Dedup insert: returns true and fills outFirstAddr if we've seen identical
// content at an earlier address; otherwise records this address and returns
// false.
static bool dedupLookupOrInsert(const U8* content, U32 addr, U32* outFirstAddr) {
    U32 h = chunkHash(content);
    U32 slot = h & (DEDUP_SLOTS - 1);
    for (U32 probe = 0; probe < DEDUP_SLOTS; probe++) {
        U32 i = (slot + probe) & (DEDUP_SLOTS - 1);
        if (!dedupTable[i].used) {
            dedupTable[i].hash = h;
            dedupTable[i].addr = addr;
            dedupTable[i].used = 1;
            return false;
        }
        if (dedupTable[i].hash == h) {
            // Verify by memcmp against the already-stored chunk.
            U8* existing = reinterpret_cast<U8*>((uintptr_t)dedupTable[i].addr);
            if (memcmp(existing, content, CHUNK_SIZE) == 0) {
                *outFirstAddr = dedupTable[i].addr;
                return true;
            }
        }
    }
    // Table completely full — fall back to raw emission.
    return false;
}

// ---------- save ----------

static void doSaveState() {
    stateOpSuccess = false;

    // Find the real wasm heap size at save time via JS (could have grown).
    U32 heapSize = EM_ASM_INT({ return HEAPU8.length; });
    U32 stackEnd = emscripten_stack_get_end();
    U32 stackBase = emscripten_stack_get_base();
    // Defensive — some emscripten variants swap the names.
    if (stackEnd > stackBase) {
        U32 t = stackEnd; stackEnd = stackBase; stackBase = t;
    }

    memset(dedupTable, 0, sizeof(dedupTable));

    klog_fmt("BoxedWine: snapshot start heap=%uMB stack=[0x%x,0x%x)",
             heapSize / (1024 * 1024), stackEnd, stackBase);

    saveBegin();

    StateHeader header;
    header.magic = STATE_MAGIC;
    header.version = STATE_VERSION;
    header.heapSize = heapSize;
    header.stackEnd = stackEnd;
    header.stackBase = stackBase;
    saveChunk(&header, sizeof(header));

    U32 rawCount = 0, zeroCount = 0, dedupCount = 0;

    for (U32 addr = 0; addr + CHUNK_SIZE <= heapSize; addr += CHUNK_SIZE) {
        if (rangeOverlapsStack(addr, stackEnd, stackBase)) continue;
        const U8* ptr = reinterpret_cast<const U8*>((uintptr_t)addr);

        if (chunkIsZero(ptr)) {
            U8 hdr[5];
            hdr[0] = CHUNK_ZERO;
            memcpy(hdr + 1, &addr, 4);
            saveChunk(hdr, 5);
            zeroCount++;
            continue;
        }

        U32 firstAddr = 0;
        if (dedupLookupOrInsert(ptr, addr, &firstAddr)) {
            U8 hdr[9];
            hdr[0] = CHUNK_DEDUP;
            memcpy(hdr + 1, &addr, 4);
            memcpy(hdr + 5, &firstAddr, 4);
            saveChunk(hdr, 9);
            dedupCount++;
            continue;
        }

        U8 hdr[5];
        hdr[0] = CHUNK_RAW;
        memcpy(hdr + 1, &addr, 4);
        saveChunk(hdr, 5);
        saveChunk(ptr, CHUNK_SIZE);
        rawCount++;
    }

    // Terminator so the reader knows the stream is complete.
    {
        U8 term = 0xFF;
        saveChunk(&term, 1);
    }

    bool ok = saveEnd();
    stateOpSuccess = ok;
    klog_fmt("BoxedWine: snapshot done raw=%u zero=%u dedup=%u total=%uMB_raw",
             rawCount, zeroCount, dedupCount, (rawCount * CHUNK_SIZE) / (1024 * 1024));
    stateOpDone = true;
}

// ---------- load ----------

static void doLoadState() {
    stateOpSuccess = false;

    StateHeader header;
    if (!loadRead(&header, sizeof(header))) {
        klog("BoxedWine: load - short read on header");
        stateOpDone = true;
        return;
    }
    if (header.magic != STATE_MAGIC || header.version != STATE_VERSION) {
        klog_fmt("BoxedWine: load - bad header magic=0x%x version=%d (want v%d)",
                 header.magic, header.version, STATE_VERSION);
        stateOpDone = true;
        return;
    }

    U32 heapSize = EM_ASM_INT({ return HEAPU8.length; });
    if (heapSize < header.heapSize) {
        klog_fmt("BoxedWine: load - heap too small (%u < %u)", heapSize, header.heapSize);
        stateOpDone = true;
        return;
    }

    U32 liveStackEnd = emscripten_stack_get_end();
    U32 liveStackBase = emscripten_stack_get_base();
    if (liveStackEnd > liveStackBase) {
        U32 t = liveStackEnd; liveStackEnd = liveStackBase; liveStackBase = t;
    }

    U32 rawCount = 0, zeroCount = 0, dedupCount = 0, skippedStack = 0;

    while (true) {
        U8 kind = 0;
        if (!loadRead(&kind, 1)) {
            klog("BoxedWine: load - short read on chunk kind");
            stateOpDone = true;
            return;
        }
        if (kind == 0xFF) break; // terminator

        U32 addr = 0;
        if (!loadRead(&addr, 4)) {
            klog("BoxedWine: load - short read on chunk addr");
            stateOpDone = true;
            return;
        }

        bool overlapsLiveStack = rangeOverlapsStack(addr, liveStackEnd, liveStackBase);
        U8* dst = reinterpret_cast<U8*>((uintptr_t)addr);

        if (kind == CHUNK_ZERO) {
            if (!overlapsLiveStack) memset(dst, 0, CHUNK_SIZE);
            else skippedStack++;
            zeroCount++;
        } else if (kind == CHUNK_RAW) {
            if (!overlapsLiveStack) {
                if (!loadRead(dst, CHUNK_SIZE)) {
                    klog("BoxedWine: load - short read on raw chunk body");
                    stateOpDone = true;
                    return;
                }
            } else {
                // Drain without writing
                U8 junk[256];
                U32 left = CHUNK_SIZE;
                while (left > 0) {
                    U32 n = left > sizeof(junk) ? (U32)sizeof(junk) : left;
                    if (!loadRead(junk, n)) {
                        klog("BoxedWine: load - drain failed on raw chunk");
                        stateOpDone = true;
                        return;
                    }
                    left -= n;
                }
                skippedStack++;
            }
            rawCount++;
        } else if (kind == CHUNK_DEDUP) {
            U32 refAddr = 0;
            if (!loadRead(&refAddr, 4)) {
                klog("BoxedWine: load - short read on dedup ref");
                stateOpDone = true;
                return;
            }
            if (!overlapsLiveStack) {
                const U8* src = reinterpret_cast<const U8*>((uintptr_t)refAddr);
                memmove(dst, src, CHUNK_SIZE);
            } else {
                skippedStack++;
            }
            dedupCount++;
        } else {
            klog_fmt("BoxedWine: load - unknown chunk kind %d", (int)kind);
            stateOpDone = true;
            return;
        }
    }

    klog_fmt("BoxedWine: restore done raw=%u zero=%u dedup=%u stackSkipped=%u",
             rawCount, zeroCount, dedupCount, skippedStack);
    stateOpSuccess = true;
    stateOpDone = true;
}

// ---------- entry points / mainloop hook ----------

void checkSaveLoadState() {
    if (saveStateRequested) {
        saveStateRequested = false;
        stateOpDone = false;
        doSaveState();
    }
    if (loadStateRequested) {
        loadStateRequested = false;
        stateOpDone = false;
        doLoadState();
    }
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void requestSaveState() {
    stateOpDone = false;
    stateOpSuccess = false;
    saveStateRequested = true;
}

EMSCRIPTEN_KEEPALIVE
int isStateReady() {
    return stateOpDone ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int isStateSuccess() {
    return stateOpSuccess ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void requestLoadState() {
    stateOpDone = false;
    stateOpSuccess = false;
    loadStateRequested = true;
}

// Diagnostic helpers for scheduler inspection. Expose as ccall-able exports
// so JS side can poll scheduler state when investigating deadlocks.
extern KList<KThread*> scheduledThreads;
extern KList<KThread*> waitThreads;

EMSCRIPTEN_KEEPALIVE
U32 diagScheduledCount() {
    U32 n = 0;
    scheduledThreads.for_each([&n](KListNode<KThread*>*) { n++; });
    return n;
}

EMSCRIPTEN_KEEPALIVE
U32 diagTimerCount() { return 0; }

EMSCRIPTEN_KEEPALIVE
void diagDumpThreads() {
    KSystem::dumpAllThreads();
}

} // extern "C"

#else // BOXEDWINE_MULTI_THREADED -- stub out the single-threaded-only exports

#include <emscripten.h>
#include <emscripten/emscripten.h>

extern "C" {
EMSCRIPTEN_KEEPALIVE void requestSaveState() {}
EMSCRIPTEN_KEEPALIVE int isStateReady() { return 1; }
EMSCRIPTEN_KEEPALIVE int isStateSuccess() { return 0; }
EMSCRIPTEN_KEEPALIVE void requestLoadState() {}
EMSCRIPTEN_KEEPALIVE unsigned int diagScheduledCount() { return 0; }
EMSCRIPTEN_KEEPALIVE unsigned int diagTimerCount() { return 0; }
EMSCRIPTEN_KEEPALIVE void diagDumpThreads() { KSystem::dumpAllThreads(); }
}

#endif // BOXEDWINE_MULTI_THREADED
#endif // __EMSCRIPTEN__
