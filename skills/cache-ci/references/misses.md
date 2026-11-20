<!--
What: why a CI cache never hits, cause by cause, with how to tell each from the job's log.
Where: read by an agent when a cache's restore step misses on runs that should have hit.
Configure: nothing; the repo's caches and their keys are in `.agents/repo/ci.md`'s Caches.
Reference implementation from a production monorepo; adapt to your repo.
-->

# A cache that never hits

Part of the [`cache-ci`](../SKILL.md) skill. Read the restore step's log in a job that should have hit: it prints the key it looked for and whether it restored. On GitHub Actions, `actions/cache` sets its `cache-hit` output to `true` only on an exact match. Then compare that key with the one the last save wrote.

- **The key moves every run.** A timestamp, the run's ID, the commit, an absolute checkout path, or a hashed file the job itself writes, such as a report or a lockfile the install rewrites, is in the key. Print the hashed file list in both runs and diff it. A per-lane path variable once leaked into the source repo's task keys and made a whole sweep replay nothing.
- **The reading job can't see the cache.** On GitHub Actions, a pull request reads its own caches and its base branch's, never another pull request's. A cache only pull requests write is never shared: have main's push or sweep write it, as [the rules](caches.md#who-may-write-a-cache) say.
- **Nothing was written.** A job saves only when its key missed and, by default, only when the job succeeded. A save step skipped by an `if:`, a job that always fails, or a key another job's save already took leaves nothing new. Check the save step ran and what it printed.
- **It was evicted.** Providers cap a repo's cache storage and drop entries unused for a while; on GitHub Actions, the oldest go once the repo passes its limit, and entries unread for a week. Many large keys, such as one per branch or per lockfile, push out the one every run needs. Keep one snapshot of main's newest, as [the rules](caches.md#a-warm-install-keyed-by-the-manifests) say.
- **Save and restore differ.** The path, the OS or architecture, or the compression differs between the job that saved and the one that restores, so the entry exists but isn't this job's. Key by OS and architecture, and use one path.
- **A partial match is counted as a hit.** A `restore-keys` prefix restores an older entry, and the job reports a restore but still installs. Count exact hits apart from partial ones, and time the install that followed.
- **Two caches hide each other.** Duplicating a remote task cache in the Actions cache hid whether remote reuse worked at all, in the source repo; remove the duplicate to see the real hits.

After the fix, read the restore line in the next two runs that should hit, and in one that should miss: a cache that never misses is a stale one.
