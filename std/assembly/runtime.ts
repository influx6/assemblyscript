import {
  AL_MASK,
  MAX_SIZE_32
} from "./internal/allocator";

@builtin export declare const HEAP_BASE: usize;

/** Common runtime header of all objects. */
@unmanaged export class HEADER {
  /** Unique id of the respective class or a magic value if not yet registered.*/
  classId: u32;
  /** Size of the allocated payload. */
  payloadSize: u32;
  /** Reserved field for use by GC. Only present if GC is. */
  gc1: usize; // itcm: tagged next
  /** Reserved field for use by GC. Only present if GC is. */
  gc2: usize; // itcm: prev
}

// Note that header data and layout isn't quite optimal depending on which allocator one
// decides to use, but it's done this way for maximum flexibility. Also remember that the
// runtime will most likely change significantly once reftypes and WASM GC are a thing.

/** Whether a GC is present or not. */
@inline export const GC = isImplemented(gc.register) && isImplemented(gc.link);

/** Size of the common runtime header. */
@inline export const HEADER_SIZE: usize = GC
  ? (offsetof<HEADER>(     ) + AL_MASK) & ~AL_MASK  // full header if GC is present
  : (offsetof<HEADER>("gc1") + AL_MASK) & ~AL_MASK; // half header if GC is absent

/** Magic value used to validate common runtime headers. */
@inline export const HEADER_MAGIC: u32 = 0xA55E4B17;

/** Adjusts an allocation to actual block size. Primarily targets TLSF. */
export function ADJUST(payloadSize: usize): usize {
  // round up to power of 2, e.g. with HEADER_SIZE=8:
  // 0            -> 2^3  = 8
  // 1..8         -> 2^4  = 16
  // 9..24        -> 2^5  = 32
  // ...
  // MAX_LENGTH   -> 2^30 = 0x40000000 (MAX_SIZE_32)
  return <usize>1 << <usize>(<u32>32 - clz<u32>(payloadSize + HEADER_SIZE - 1));
}

/** Allocates a new object and returns a pointer to its payload. */
@unsafe export function ALLOC(payloadSize: u32): usize {
  var header = changetype<HEADER>(memory.allocate(ADJUST(payloadSize)));
  header.classId = HEADER_MAGIC;
  header.payloadSize = payloadSize;
  if (GC) {
    header.gc1 = 0;
    header.gc2 = 0;
  }
  var ref = changetype<usize>(header) + HEADER_SIZE;
  memory.fill(ref, 0, payloadSize);
  return ref;
}

/** Reallocates an object if necessary. Returns a pointer to its (moved) payload. */
@unsafe export function REALLOC(ref: usize, newPayloadSize: u32): usize {
  // Background: When managed objects are allocated these aren't immediately registered with GC
  // but can be used as scratch objects while unregistered. This is useful in situations where
  // the object must be reallocated multiple times because its final size isn't known beforehand,
  // e.g. in Array#filter, with only the final object making it into GC'ed userland.
  var header = changetype<HEADER>(ref - HEADER_SIZE);
  var payloadSize = header.payloadSize;
  if (payloadSize < newPayloadSize) {
    let newAdjustedSize = ADJUST(newPayloadSize);
    if (select(ADJUST(payloadSize), 0, ref > HEAP_BASE) < newAdjustedSize) {
      // move if the allocation isn't large enough or not a heap object
      let newHeader = changetype<HEADER>(memory.allocate(newAdjustedSize));
      newHeader.classId = HEADER_MAGIC;
      if (GC) {
        newHeader.gc1 = 0;
        newHeader.gc2 = 0;
      }
      let newRef = changetype<usize>(newHeader) + HEADER_SIZE;
      memory.copy(newRef, ref, payloadSize);
      memory.fill(newRef + payloadSize, 0, newPayloadSize - payloadSize);
      if (header.classId == HEADER_MAGIC) {
        // free right away if not registered yet
        assert(ref > HEAP_BASE); // static objects aren't scratch objects
        memory.free(changetype<usize>(header));
      }
      header = newHeader;
      ref = newRef;
    } else {
      // otherwise just clear additional memory within this block
      memory.fill(ref + payloadSize, 0, newPayloadSize - payloadSize);
    }
  } else {
    // if the size is the same or less, just update the header accordingly.
    // unused space is cleared when grown, so no need to do this here.
  }
  header.payloadSize = newPayloadSize;
  return ref;
}

function unref(ref: usize): HEADER {
  assert(ref >= HEAP_BASE + HEADER_SIZE); // must be a heap object
  var header = changetype<HEADER>(ref - HEADER_SIZE);
  assert(header.classId == HEADER_MAGIC); // must be unregistered
  return header;
}

/** Frees an object. Must not have been registered with GC yet. */
@unsafe export function FREE(ref: usize): void {
  memory.free(changetype<usize>(unref(ref)));
}

/** Registers a managed object. Cannot be free'd anymore afterwards. */
@unsafe @inline export function REGISTER<T>(ref: usize): T {
  // see comment in REALLOC why this is useful. also inline this because
  // it's generic so we don't get a bunch of functions.
  unref(ref).classId = gc.classId<T>();
  if (GC) gc.register(ref);
  return changetype<T>(ref);
}

/** Links a managed object with its managed parent. */
@unsafe export function LINK(ref: usize, parentRef: usize): void {
  assert(ref >= HEAP_BASE + HEADER_SIZE); // must be a heap object
  var header = changetype<HEADER>(ref - HEADER_SIZE);
  assert(header.classId != HEADER_MAGIC && header.gc1 != 0 && header.gc2 != 0); // must be registered
  if (GC) gc.link(ref, parentRef); // tslint:disable-line
}

/** ArrayBuffer base class.  */
export abstract class ArrayBufferBase {
  @lazy static readonly MAX_BYTELENGTH: i32 = MAX_SIZE_32 - HEADER_SIZE;
  get byteLength(): i32 {
    return changetype<HEADER>(changetype<usize>(this) - HEADER_SIZE).payloadSize;
  }
}

/** String base class. */
export abstract class StringBase {
  @lazy static readonly MAX_LENGTH: i32 = (MAX_SIZE_32 - HEADER_SIZE) >> 1;
  get length(): i32 {
    return changetype<HEADER>(changetype<usize>(this) - HEADER_SIZE).payloadSize >> 1;
  }
}

import { memcmp, memmove, memset } from "./internal/memory";

/** Memory manager interface. */
export namespace memory {
  @builtin export declare function size(): i32;
  @builtin @unsafe export declare function grow(pages: i32): i32;
  @builtin @unsafe @inline export function fill(dst: usize, c: u8, n: usize): void {
    memset(dst, c, n); // fallback if "bulk-memory" isn't enabled
  }
  @builtin @unsafe @inline export function copy(dst: usize, src: usize, n: usize): void {
    memmove(dst, src, n); // fallback if "bulk-memory" isn't enabled
  }
  @unsafe export function init(segmentIndex: u32, srcOffset: usize, dstOffset: usize, n: usize): void {
    ERROR("not implemented");
  }
  @unsafe export function drop(segmentIndex: u32): void {
    ERROR("not implemented");
  }
  @stub @inline export function allocate(size: usize): usize {
    ERROR("stub: missing memory manager");
    return <usize>unreachable();
  }
  @stub @unsafe @inline export function free(ptr: usize): void {
    ERROR("stub: missing memory manager");
  }
  @stub @unsafe @inline export function reset(): void {
    ERROR("stub: not supported by memory manager");
  }
  @inline export function compare(vl: usize, vr: usize, n: usize): i32 {
    return memcmp(vl, vr, n);
  }
  @unsafe export function repeat(dst: usize, src: usize, srcLength: usize, count: usize): void {
    var index: usize = 0;
    var total = srcLength * count;
    while (index < total) {
      memory.copy(dst + index, src, srcLength);
      index += srcLength;
    }
  }
}

/** Garbage collector interface. */
export namespace gc {
  @builtin @unsafe export declare function classId<T>(): u32;
  @builtin @unsafe export declare function iterateRoots(fn: (ref: usize) => void): void;
  @stub @unsafe export function register(ref: usize): void {
    ERROR("stub: missing garbage collector");
  }
  @stub @unsafe export function link(ref: usize, parentRef: usize): void {
    ERROR("stub: missing garbage collector");
  }
  @stub export function collect(): void {}
}