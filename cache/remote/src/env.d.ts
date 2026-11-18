/**
 * The Worker's bindings, as `wrangler.jsonc` declares them, global because the vendored protocol
 * names `Env` as upstream's generated types do. Keep it in step with `wrangler.jsonc`.
 */
interface Env {
  readonly INDEX: D1Database;
  readonly ARTIFACTS: R2Bucket;
  readonly READ_LIMITER: RateLimit;
  readonly STORE_LIMITER: RateLimit;
  /** The one namespace, as `migrations/0003_project.sql` registers it: the URL's `/projects/<project>`. */
  readonly NAMESPACE: string;
  /** How many expired or replaced results one cleanup deletes. */
  readonly GC_BATCH_SIZE: string;
  /** Each writer's name, to the SHA-256 of its token in hex. */
  readonly WRITERS: Readonly<Record<string, string>>;
  /** Each reader's name, to the SHA-256 of its token in hex. */
  readonly READERS: Readonly<Record<string, string>>;
}
