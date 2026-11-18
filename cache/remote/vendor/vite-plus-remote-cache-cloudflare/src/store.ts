import { cborResponse, decodeEnvelope, type StoreMetadata } from './cbor.ts';
import {
  abandon,
  publish,
  recordMultipart,
  reserve,
  type Generation,
  type Scope,
} from './database.ts';
import { badRequest, tooLarge, unavailable } from './errors.ts';
import { PART_SIZE, type Limits } from './limits.ts';
import { boundaryFrom, multipart } from './multipart.ts';
import { collect, contentLength, Deadline, grow, Input } from './streams.ts';
import type { Lease } from './admission.ts';
import type { WriteIdentity } from './auth.ts';
import type { Observations } from './observations.ts';

// local: decodes a store's metadata with what decoding copies held on `lease`. A chunked string is
// joined into a copy of its own, and every copy's bytes come from `body`, so `body`'s size is held
// before decoding, and freed when every field is a view of `body`.
export function decodeMetadata(
  body: Uint8Array<ArrayBuffer>,
  limits: Limits,
  lease: Lease,
): StoreMetadata {
  lease.hold(body.length);
  const metadata = decodeEnvelope(body, true, limits);
  const fields = [metadata.key, metadata.secondary_key, metadata.value];
  if (fields.every((field) => field.buffer === body.buffer)) lease.free(body.length);
  return metadata;
}

// local: what `uploadBlob` uses of R2, so `../../../src/worker.test.ts` can record its calls.
interface Artifacts {
  put(key: string, value: Uint8Array): Promise<object | null>;
  createMultipartUpload(key: string): Promise<{
    uploadId: string;
    uploadPart(part: number, value: Uint8Array): Promise<R2UploadedPart>;
    complete(parts: R2UploadedPart[]): Promise<object>;
    abort(): Promise<void>;
  }>;
}

// local: exported for `../../../src/worker.test.ts`.
export async function uploadBlob(
  env: { ARTIFACTS: Artifacts; INDEX: D1Database },
  generation: Generation,
  source: AsyncIterable<Uint8Array>,
  limit: number,
  deadline: Deadline,
  stats: Observations,
  lease: Lease,
): Promise<void> {
  // local: the part buffer starts empty and grows to `PART_SIZE` only for a blob that gets that far,
  // where upstream allocated `PART_SIZE` before reading a byte. A smaller blob is one `put`.
  let buffer = new Uint8Array(0);
  let used = 0;
  let upload: Awaited<ReturnType<Artifacts['createMultipartUpload']>> | undefined;
  const parts: R2UploadedPart[] = [];
  for await (const chunk of source) {
    generation.blob_size += chunk.length;
    if (generation.blob_size > limit) tooLarge();
    let offset = 0;
    while (offset < chunk.length) {
      if (used === PART_SIZE) {
        if (!upload) {
          stats.r2_operations++;
          upload = await deadline.run(env.ARTIFACTS.createMultipartUpload(generation.blob_object));
          try {
            await deadline.run(recordMultipart(env.INDEX, generation, upload.uploadId, stats));
          } catch (error) {
            // Also cover creation succeeding but D1 failing to record its ID.
            try {
              await deadline.run(upload.abort());
            } catch {
              /* Lifecycle is the final backstop. */
            }
            throw error;
          }
        }
        stats.r2_operations++;
        parts.push(await deadline.run(upload.uploadPart(parts.length + 1, buffer)));
        buffer = new Uint8Array(PART_SIZE);
        used = 0;
      }
      if (used === buffer.length)
        buffer = grow(buffer, used, used + chunk.length - offset, PART_SIZE, lease);
      const size = Math.min(buffer.length - used, chunk.length - offset);
      buffer.set(chunk.subarray(offset, offset + size), used);
      used += size;
      offset += size;
    }
  }
  if (upload) {
    stats.r2_operations += Number(used > 0) + 1;
    if (used)
      parts.push(await deadline.run(upload.uploadPart(parts.length + 1, buffer.subarray(0, used))));
    await deadline.run(upload.complete(parts));
  } else {
    stats.r2_operations++;
    const result = await deadline.run(
      env.ARTIFACTS.put(generation.blob_object, buffer.subarray(0, used)),
    );
    if (!result) unavailable();
  }
  generation.blob_id = crypto.randomUUID();
}

export async function store(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  scope: Scope,
  identity: WriteIdentity,
  limits: Limits,
  deadline: Deadline,
  stats: Observations,
  lease: Lease,
): Promise<Response> {
  const boundary = boundaryFrom(request.headers.get('Content-Type'));
  const length = contentLength(request, limits.store);
  const generation = await deadline.run(
    reserve(env.INDEX, scope, identity.exp, length ?? limits.store, stats),
  );
  let input: Input | undefined;
  try {
    input = new Input(request.body, Math.min(length ?? limits.store, limits.store), deadline);
    let metadata: StoreMetadata | undefined;
    for await (const part of multipart(input, boundary, limits.headers)) {
      if (part.name === 'metadata') {
        metadata = decodeMetadata(await collect(part.body, limits.metadata, lease), limits, lease);
        generation.value_size = metadata.value.length;
        stats.r2_operations++;
        const result = await deadline.run(
          env.ARTIFACTS.put(generation.value_object, metadata.value),
        );
        if (!result) unavailable();
      } else {
        await uploadBlob(env, generation, part.body, limits.blob, deadline, stats, lease);
      }
    }
    if (!metadata || (length !== null && input.bytes !== length)) badRequest();
    deadline.check();
    await deadline.run(publish(env.INDEX, generation, metadata.key, metadata.secondary_key, stats));
    return cborResponse({ blob_id: generation.blob_id });
  } catch (error) {
    // Publication is never deferred. Only cleanup can continue after the response.
    ctx.waitUntil(
      abandon(env.INDEX, generation.generation_id).catch(() => {
        console.warn(
          JSON.stringify({
            operation: 'cleanup',
            error: 'abandon_failed',
            generation: generation.generation_id,
          }),
        );
      }),
    );
    throw error;
  } finally {
    stats.request_bytes = input?.bytes ?? 0;
    input?.close();
  }
}
