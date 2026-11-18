import { HttpError } from './errors.ts';
import { MiB } from './limits.ts';

// local: an isolate admits requests by the bytes their buffers hold, not by a count of stores and
// reads. Upstream's 2 stores and 4 reads stood for about 10 MiB a store and 4 MiB a read, the
// buffers each allocated whole before reading a byte. Buffers now grow as bytes arrive, so a store
// of our usual sizes holds about 1.4 MiB, and a count would refuse stores the memory could take.
// 96 MiB of an isolate's 128 MiB leaves 32 MiB for the runtime, the code and garbage not yet
// collected. A store at every limit holds at most about 27 MiB: a 9 MiB metadata buffer, the 9 MiB
// decoding it may copy, and a part buffer growing from 4 to 5 MiB. So 3 such stores fit at once,
// or about 70 of our usual size.
export const BUDGET = 96 * MiB;

// local: what each request holds besides its buffers: its input's 64 KiB window and framing.
export const REQUEST_BYTES = 128 * 1024;

// local: one request's share of the budget. A buffer holds its new capacity before it frees its
// old one, so a copy counts both.
export class Lease {
  private bytes = 0;
  constructor(private admission: Admission) {}
  hold(bytes: number): void {
    this.admission.take(bytes);
    this.bytes += bytes;
  }
  free(bytes: number): void {
    const freed = Math.min(bytes, this.bytes);
    this.admission.give(freed);
    this.bytes -= freed;
  }
  release(): void {
    this.free(this.bytes);
  }
}

// Isolate-wide resource counters contain no request data or I/O promises. Rate
// limiting controls traffic; these counters additionally bound simultaneous buffers.
export class Admission {
  private held = 0;
  constructor(private budget = BUDGET) {}
  acquire(): Lease {
    const lease = new Lease(this);
    lease.hold(REQUEST_BYTES);
    return lease;
  }
  take(bytes: number): void {
    if (this.held + bytes > this.budget) throw new HttpError(503, 'memory_limit');
    this.held += bytes;
  }
  give(bytes: number): void {
    this.held -= bytes;
  }
}
