# vite-plus-remote-cache-cloudflare, vendored

[voidzero-dev/vite-plus-remote-cache-cloudflare](https://github.com/voidzero-dev/vite-plus-remote-cache-cloudflare) at [`5b06c2c10d84ea441735ba07c46f6d1b7cb2ff3b`](https://github.com/voidzero-dev/vite-plus-remote-cache-cloudflare/tree/5b06c2c10d84ea441735ba07c46f6d1b7cb2ff3b) (22 Oct 2026), MIT, copyright VoidZero Inc. (`LICENSE`). On 6 Nov 2026 upstream's `main` was 18 commits past it, all dependency updates, with no change under `src/` or `migrations/`.

**Copied:** `src/` except `index.ts`, the handler, which `../../src/worker.ts` replaces; both migrations, which are in `../../migrations/` as `0001` and `0002`.

**Left out:** upstream's tests, which `../../src/worker.test.ts` ports; its operator, deploy and benchmark scripts; its workflows and Wrangler config.

**Local changes,** each marked `local:` in the code, in `src/auth.ts`, `src/admission.ts`, `src/streams.ts`, `src/store.ts`, `src/fetch.ts` and `src/limits.ts`. Each was found from real traffic:

- **A private repository writes.** Upstream accepts only a public one, where GitHub never sends a fork's pull request a token that can write. Keep this only if your repository sends fork pull requests no writing token (GitHub's default for private repositories) or allows no forks.
- **Only a *failed* read of GitHub's keys waits 30 s.** Upstream waits after any attempt. On Workers, jose shares no fetch between requests, so runs that arrive together while the keys are stale each fetch them, and the wait refused all but the first with 503: 44 of ~29,000 stores in one day.
- **A run by hand writes,** on any of the repository's branches, when the namespace takes pull requests. Whoever can start one can push that branch and open a pull request from it, which writes already.
- **Buffers grow as bytes arrive,** up to their limits. Upstream's `collect()` allocates its whole limit up front, 5 MiB for a store's metadata, and `uploadBlob()` a 5 MiB part before it reads a byte, so every store held about 10 MiB however small it was. Now a store holds what it brings: in one sample, values averaged 669 KB and blobs 141 KB. A blob of one part or less is one `put` of what was read, and a larger one still uploads in 5 MiB parts. `uploadBlob()` is exported for `../../src/worker.test.ts`, and takes only the R2 methods it calls, so the test can record them.
- **An isolate admits requests by bytes, not by a count.** Upstream takes 2 stores and 4 reads at once, and a count of 2 refused an upload from one full local test run. Each request now holds a lease on a 96 MiB budget inside the 128 MiB isolate: 128 KiB of its own and each buffer's capacity as it grows. A buffer past the budget is refused with 503. Decoding the metadata holds its size too, since a chunked string is joined into a copy. A store at every limit holds at most about 27 MiB, so 3 fit at once, or about 70 of a usual size.
- **Values of 8 MiB, not 4.** A value is Vite+'s record of a task's inputs, which lists every file the task read. A server integration-test task's reached 4.0 MB, within 4% of the old limit. A store past the limit is refused as too large, and **Vite+ says nothing**. Metadata is 9 MiB and a whole store 76 MiB, to match.

Change this folder only that way: a `local:` comment at each change, and a line here.
