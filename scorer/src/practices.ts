// The practices: what a repo's files, and the pull requests it merged in the window, say about how it runs CI. Each is
// true (in place), false (missing) or null (couldn't tell, with the reason in `unknown`). False means every place the
// practice can live was read and nothing there hinted at it: a wrong "missing" is worse than an honest "couldn't tell".
// A strict detector takes the forms a tool documents. Beside it, a loose one takes words that suggest the practice in a
// form the strict one doesn't know: that makes the practice null, and `hints` names the practice, the file and which
// loose rule fired, never the text it matched, since a private repo's files can hold anything. Text after a `#` comment
// counts for neither.
import { parseYaml, uncomment, type Yaml } from './job-graph.ts';
import type { Source } from './source.ts';

/** Workflow files read. Past this, a practice found in none of them is unknown. */
export const MAX_WORKFLOWS = 40;
/** Local actions read with the workflows: each `.github/actions/**​/action.yml`, and any other a workflow calls with `uses: ./`. Past this, a practice a step can hold is unknown when it isn't found. */
export const MAX_ACTIONS = 50;
/** Which loose rule fired: words in a CI file, a tool's config that doesn't say the practice is on, a job named for changes whose outputs gate others, or bots' pull-request titles. */
export const HINT_KINDS = ['word', 'config', 'job', 'title'] as const;
export type HintKind = (typeof HINT_KINDS)[number];
export interface Hint {
  practice: string;
  path: string;
  kind: HintKind;
}
/** The window's merged pull requests by title and author, as the search answered them, and whether its one page held them all. */
export interface History {
  prs: { title: string; login: string }[];
  complete: boolean;
}
/** What `practices` takes from the merged pull requests' search answer: nothing else of it is kept. */
export const historyOf = (merged: { total_count?: number; items?: { title?: string; user?: { login?: string } }[] } | undefined): History | undefined =>
  merged
    ? { prs: (merged.items ?? []).map((i) => ({ title: String(i.title ?? ''), login: String(i.user?.login ?? '') })), complete: (merged.total_count ?? Infinity) <= (merged.items ?? []).length }
    : undefined;

interface File {
  path: string;
  text: string;
}
const isMap = (x: unknown): x is Record<string, Yaml> => !!x && typeof x === 'object' && !Array.isArray(x);
const decomment = (text: string) => text.split('\n').map(uncomment).join('\n');
/** A config's YAML, or undefined when this reader can't take it. */
const yaml = (text: string) => {
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The default branch's workflow files, up to MAX_WORKFLOWS, and whether every one was read. */
export const workflowFiles = (source: Source) => {
  const all = source.tree.blobs.map((b) => b.path).filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  const read = all.slice(0, MAX_WORKFLOWS).map((path) => ({ path, text: source.read(path) }));
  const files = read.filter((r): r is File => r.text !== undefined);
  const unknown: string[] = [];
  if (all.length > MAX_WORKFLOWS) unknown.push(`Read the first ${MAX_WORKFLOWS} of ${all.length} workflow files`);
  for (const r of read) if (r.text === undefined) unknown.push(`${r.path} is in the tree but couldn't be found`);
  return { all, files, texts: files.map((f) => f.text), complete: !source.tree.truncated && all.length <= MAX_WORKFLOWS && files.length === read.length, unknown };
};

/** Found is true; not found where everything was read is false (absent); not found otherwise is null (unknown). */
const named = <T>(found: T | undefined, complete: boolean): T | false | null => (found !== undefined ? found : complete ? false : null);

// Where each tool reads its config, from its own docs, checked 25 Nov 2026. Renovate and Mergify take the first they find.
const DEPENDABOT = ['.github/dependabot.yml', '.github/dependabot.yaml'];
// docs.renovatebot.com/configuration-options, "Locations for configuration filenames", less GitLab's; then package.json's `renovate`.
const RENOVATE = ['renovate.json', 'renovate.jsonc', 'renovate.json5', '.github/renovate.json', '.github/renovate.jsonc', '.github/renovate.json5', '.renovaterc', '.renovaterc.json', '.renovaterc.jsonc', '.renovaterc.json5'];
const RENOVATE_BATCHES = /groupName|\bgroup:|config:(recommended|base|best-practices)|schedule/;
// A schedule for lock-file maintenance alone doesn't batch the updates themselves.
const LOCK_FILE_MAINTENANCE = /"?lockFileMaintenance"?\s*:\s*\{[^{}]*\}/g;
// A preset kept in another repo or an npm package: what it sets can't be read from here.
const RENOVATE_SHARED_PRESET = /\b(github|gitlab|bitbucket|gitea|local)>|["']@[\w-]+\/[\w-]*renovate|["']renovate-config-/;
const MERGIFY = ['.mergify.yml', '.mergify.yaml', '.mergify/config.yml', '.mergify/config.yaml', '.github/mergify.yml', '.github/mergify.yaml'];
const KODIAK = ['.kodiak.toml', '.github/.kodiak.toml'];
const VITE_CONFIG = ['vite.config.ts', 'vite.config.mts', 'vite.config.cts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
const CACHE_CONFIGS = ['turbo.json', 'turbo.jsonc', '.bazelrc', 'settings.gradle', 'settings.gradle.kts', 'pants.toml', '.moon/workspace.yml', ...VITE_CONFIG];
const CONFIGS = [...DEPENDABOT, ...RENOVATE, ...MERGIFY, ...KODIAK, ...CACHE_CONFIGS, 'bors.toml', '.aviator/config.yml', '.cargo/config.toml', '.cargo/config', '.yarnrc.yml'];

// A remote cache in CI files: each runner's token, server or flag. `VP_REMOTE_CACHE` is Vite+'s, which its public docs
// don't cover yet (viteplus.dev/config/run, 25 Nov 2026); ci-doctor's cache/remote/ runs it. A switch set off doesn't count.
const REMOTE_CACHE = /TURBO_TOKEN|TURBO_REMOTE|NX_CLOUD|nx-cloud|NX_SELF_HOSTED_REMOTE_CACHE_SERVER|--remote_cache=(?!["']{2})\S|--remote_executor=(?!["']{2})\S|buildbuddy|VP_REMOTE|gradle-enterprise|develocity/i;
const SET_OFF = /\b[\w-]*REMOTE[\w-]*\s*[:=]\s*['"]?(off|false|0|no|disabled?)\b['"]?/gi;
const REMOTE_WORDS = /remote[-_ ]?cache|cache[-_ ]?(token|url|server|endpoint|bucket)|shared[-_ ]cache|task[-_ ]cache/i;
/** Each runner's own switch outside CI files, from its docs, checked 25 Nov 2026. */
const remoteInConfig = (path: string, text: string) => {
  // nx.dev: Nx Cloud's id or token in nx.json, or the nx-cloud tasks runner.
  if (path === 'nx.json') return /nxCloud|"runner"\s*:\s*"(@nrwl\/)?nx-cloud"/.test(text);
  // bazel.build/remote/caching: `--remote_cache=<url>`; an empty value turns it off.
  if (path === '.bazelrc') return /--remote_(cache|executor)=(?!["']{2})\S/.test(decomment(text));
  // docs.gradle.org build_cache: `buildCache { remote(HttpBuildCache) { … } }`, or `remote<…>` in Kotlin.
  if (/^settings\.gradle/.test(path)) return /\bbuildCache\b[\s\S]*\bremote\s*[(<]/.test(text);
  // pantsbuild.org remote-caching: `remote_cache_read = true` under [GLOBAL].
  if (path === 'pants.toml') return /^\s*remote_cache_read\s*=\s*true\b/m.test(decomment(text));
  // moonrepo.dev/docs/config/workspace: `remote.host`, since v1.30.
  if (path === '.moon/workspace.yml') {
    const doc = yaml(text);
    return isMap(doc) && isMap(doc.remote) && typeof doc.remote.host === 'string' && doc.remote.host !== '';
  }
  return false;
};
// Turborepo's `remoteCache.apiUrl` or team still needs a token in CI (turborepo.dev/docs/reference/configuration);
// Vite+'s `run.cache.remote` and Nx's self-hosted cache packages aren't documented as a switch on their own.
const REMOTE_CONFIG_WORDS = /"(apiUrl|teamId|teamSlug)"|@nx\/(s3|gcs|azure|shared-fs)-cache|\bcache\b[\s\S]{0,400}\bremote\b/;

// Each runner's documented selection by what changed: Nx, Turborepo and pnpm's `[<since>]` filters, Jest, Vitest, Pants,
// Lerna, Yarn's `workspaces foreach --since`, Rush's `git:` selector, moon's `ci` (affected by default), pytest's
// testmon and picked plugins, and Bazel's diff tools. Checked 25 Nov 2026.
const AFFECTED =
  /--affected\b|\bnx affected\b|(--filter|-F)[= ]['"]?[^\s'"]*\[[^\]\s]+\]|\b(vitest|vp test)\b[^\n]*--changed\b|--changedSince\b|--onlyChanged\b|--changedFilesWithAncestor\b|--changed-since\b|\blerna (run|exec)\b[^\n]*--since\b|\blerna changed\b|workspaces foreach\b[^\n]*--since\b|--(impacted-by|to|from|only)[= ]git:|bazel-diff|target-determinator|turbo-ignore|\bmoon ci\b|--testmon\b|--picked\b/;
const AFFECTED_WORDS = /\baffected\b|--since\b|--changed\b|changed[-_ ]?(packages|projects|workspaces)/i;
// What works from the changed files: a paths-filter or changed-files action, `git diff --name-only`, or the compare or
// pull-request files API.
const CHANGED_FILES = /paths-filter|changed-files|get-diff-action|file-changes-action|git diff\b[^\n"]*--name-(only|status)|\/compare\/|pulls\/[^\s/]+\/files|gh pr diff\b[^\n"]*--name-only/i;
const NAMED_FOR_CHANGES = /chang|affect|diff|impact/i;
const SCRIPT_FOR_CHANGES = /[\w./-]*(chang|affect|diff|impact)[\w.-]*\.(m?[jt]s|cjs|py|sh|rb)\b/i;

// GitHub's queue triggers `merge_group`; Mergify's `queue_rules` is its merge queue (docs.mergify.com/configuration/file-format);
// bors' `status` must pass on the merge commit before it's pushed (bors.tech/documentation); Aviator's parallel mode builds
// on top of the queue (docs.aviator.co/mergequeue/configuration-file). Kodiak and Aviator's default mode update a branch
// only as GitHub's settings ask, so they don't say. A queue set only in a service's settings, such as Graphite's or
// Trunk's, is in no file: it can't be seen here.
const QUEUE_WORDS = /merge[-_ ]?queue|gh-readonly-queue|\bbors\b|mergify|kodiak|aviator|graphite|trunk[-_ ]merge/i;

const DEP_BOT = /^(dependabot|renovate|depfu|pyup|snyk|mend|whitesource)/i;
// Grouped updates, by the titles the bots give them: Dependabot's "Bump the <group> group …", and Renovate's built-in
// groups' "Update all non-major dependencies" and "… monorepo …".
const GROUPED_TITLE = /\bthe [\w.|-]+ group\b|\bupdate all (non-?major |minor |patch )?dependencies\b|\bmonorepo\b/i;
const GROUP_WORDS = /\bgroups?\b|\b\d+ updates\b|\band \d+ (more|others)\b|\bdependencies\b/i;

/** The directories whose action a workflow or action calls with `uses: ./dir`. */
const localUses = (text: string) => [...text.matchAll(/uses:\s*['"]?\.\/([^\s'"@]+?)\/?['"]?\s*$/gm)].map((m) => m[1]!);

/**
 * A job whose outputs another job reads, in its `if:`, a step's `run`, `env` or `with`, or its matrix, and whether it
 * works from the changed files: a paths-filter or changed-files action, `git diff --name-only`, the compare API, or a
 * local action or script named for changes, or whose text works from them.
 */
const changesJob = (parsed: { path: string; doc: Yaml }[], actions: Map<string, string>) => {
  let named: string | undefined;
  for (const { path, doc } of parsed) {
    const jobs = isMap(doc) && isMap(doc.jobs) ? doc.jobs : {};
    for (const [id, def] of Object.entries(jobs)) {
      if (!isMap(def) || !isMap(def.outputs)) continue;
      const reads = new RegExp(`needs\\.${escape(id)}\\.outputs\\.`);
      if (!Object.entries(jobs).some(([other, d]) => other !== id && reads.test(JSON.stringify(d)))) continue;

      const steps = JSON.stringify(def.steps ?? []);
      const local = (Array.isArray(def.steps) ? def.steps : []).flatMap((s) => (isMap(s) && typeof s.uses === 'string' && s.uses.startsWith('./') ? [s.uses.slice(2).replace(/\/$/, '')] : []));
      const fromChanges =
        CHANGED_FILES.test(steps) || SCRIPT_FOR_CHANGES.test(steps) || local.some((dir) => NAMED_FOR_CHANGES.test(dir) || CHANGED_FILES.test(actions.get(dir) ?? ''));
      if (fromChanges) return { strict: path };
      if (NAMED_FOR_CHANGES.test(id) || /filter|detect/i.test(id) || NAMED_FOR_CHANGES.test(String(def.name ?? ''))) named ??= path;
    }
  }
  return { named };
};

export const practices = (source: Source, history?: History) => {
  const paths = source.tree.blobs.map((b) => b.path);
  const tree = new Set(paths);
  const treeComplete = !source.tree.truncated;
  const find = (p: string | RegExp) => (typeof p === 'string' ? (tree.has(p) ? p : undefined) : paths.find((x) => p.test(x)));
  const has = (p: string | RegExp) => find(p) !== undefined;
  const unknown: string[] = [];
  const hints: Hint[] = [];
  /** For each practice that's true, the path that showed it, or `pull requests` for history. */
  const where: Record<string, string> = {};
  if (!treeComplete) unknown.push("GitHub cut the file tree short, so a file past the cut can't be checked");

  const wf = workflowFiles(source);
  unknown.push(...wf.unknown);
  const called = new Set(wf.files.flatMap((f) => localUses(f.text)));
  const allActions = paths.filter((p) => /^(.+)\/action\.ya?ml$/.test(p) && (p.startsWith('.github/actions/') || called.has(p.replace(/\/action\.ya?ml$/, ''))));
  const actionPaths = allActions.slice(0, MAX_ACTIONS);
  if (allActions.length > MAX_ACTIONS) unknown.push(`Read the first ${MAX_ACTIONS} of ${allActions.length} local actions`);

  // The actions and every tool's config, in one batch: a GraphQL query for up to 100 files, none when there are none.
  const wanted = [...actionPaths, ...CONFIGS.filter((p) => tree.has(p))];
  const got = source.readMany(wanted);
  for (const p of wanted) if (!got.texts.has(p)) unknown.push(got.failed.has(p) ? `${p} couldn't be read: ${got.failed.get(p)}` : `${p} is in the tree but couldn't be found`);
  /** The first of these the tree has: its text, '' when none is there, undefined when that's unknown. */
  const config = (...ps: string[]) => {
    const path = ps.find((p) => tree.has(p));
    if (path === undefined) return treeComplete ? { path, text: '' } : undefined;
    return got.texts.has(path) ? { path, text: got.texts.get(path)! } : undefined;
  };
  // A file read only if the tree has it: '' when it's known to be absent, undefined when that's unknown.
  const optional = (p: string) => {
    if (!has(p)) return treeComplete ? '' : undefined;
    const text = source.read(p);
    if (text === undefined) unknown.push(`${p} is in the tree but couldn't be found`);
    return text;
  };
  const pkg = optional('package.json');
  const nx = optional('nx.json');
  const pkgKnown = pkg !== undefined;
  const inPkg = (re: RegExp) => re.test(pkg ?? '');

  const workflows: File[] = wf.files.map((f) => ({ path: f.path, text: decomment(f.text) }));
  const actions: File[] = actionPaths.filter((p) => got.texts.has(p)).map((p) => ({ path: p, text: decomment(got.texts.get(p)!) }));
  const ci = [...workflows, ...actions];
  const onPr = [...workflows.filter((w) => /pull_request|workflow_call/.test(w.text)), ...actions];
  // A practice set only in a workflow file is known once every workflow is read; one a step can hold, once every local action is too.
  const inWorkflows = wf.complete;
  const inSteps = wf.complete && treeComplete && allActions.length <= MAX_ACTIONS && actions.length === actionPaths.length;
  const parsed = wf.files.flatMap(({ path, text }) => {
    try {
      return [{ path, doc: parseYaml(text) }];
    } catch (e) {
      unknown.push(`${path} couldn't be read as YAML: ${(e as Error).message}`);
      return [];
    }
  });
  const parsedAll = parsed.length === wf.files.length;

  const firstIn = (files: File[], re: RegExp | ((f: File) => boolean)) => files.find((f) => (typeof re === 'function' ? re(f) : re.test(f.text)))?.path;
  const word = (files: File[], re: RegExp) => {
    const path = firstIn(files, re);
    return path === undefined ? undefined : ({ path, kind: 'word' } as const);
  };
  const decide = (practice: string, strict: string | undefined, hint: { path: string; kind: HintKind } | undefined, complete: boolean): boolean | null => {
    if (strict !== undefined) {
      where[practice] = strict;
      return true;
    }
    if (!hint) return complete ? false : null;
    hints.push({ practice, ...hint });
    unknown.push(`${practice}: ${hint.path} hints at it, in a form the scorer doesn't check (${hint.kind})`);
    return null;
  };

  // Vite+ bundles Vitest and Oxlint, so a Vite+ repo names neither in its package.json.
  const vitePlus = inPkg(/"vite-plus"/);
  const all = ci.map((f) => f.text).join('\n');
  const testRunner =
    inPkg(/"vitest"/) || has(/^vitest\.(config|workspace)\./)
      ? 'vitest'
      : inPkg(/"jest"/) || has(/^jest\.config\./)
        ? 'jest'
        : vitePlus
          ? 'vitest'
          : /cargo nextest/.test(all) || has('.config/nextest.toml')
            ? 'nextest'
            : /pytest[^\n]*-n\s/.test(all)
              ? 'pytest-xdist'
              : undefined;
  const agentsMd = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'].filter((p) => has(p));

  // Path filters: `paths` on a pull-request trigger, never on `push` alone, or a paths-filter or changed-files action.
  const prPaths = parsed.find(({ doc }) => {
    const on = isMap(doc) ? doc.on : undefined;
    return isMap(on) && ['pull_request', 'pull_request_target'].some((e) => isMap(on[e]) && (on[e]['paths'] !== undefined || on[e]['paths-ignore'] !== undefined));
  })?.path;
  const changes = changesJob(parsed, new Map(actions.map((a) => [a.path.replace(/\/action\.ya?ml$/, ''), a.text])));

  // Remote cache: CI files, then each runner's own config.
  const cacheConfigs = [{ path: 'nx.json', text: nx }, ...CACHE_CONFIGS.map((p) => ({ path: p, text: tree.has(p) ? got.texts.get(p) : treeComplete ? '' : undefined }))];
  const remoteStrict = firstIn(ci, (f) => REMOTE_CACHE.test(f.text.replace(SET_OFF, ''))) ?? cacheConfigs.find((c) => c.text && remoteInConfig(c.path, c.text))?.path;
  const remoteConfigHint = cacheConfigs.find((c) => !!c.text && /^(nx\.json|turbo|vite\.config)/.test(c.path) && REMOTE_CONFIG_WORDS.test(c.text))?.path;
  const remoteHint = firstIn(ci, (f) => REMOTE_WORDS.test(f.text.replace(SET_OFF, '')));

  // Merge queue.
  const mergify = config(...MERGIFY);
  const kodiak = config(...KODIAK);
  const bors = config('bors.toml');
  const aviator = config('.aviator/config.yml');
  const aviatorDoc = aviator?.text ? yaml(aviator.text) : undefined;
  const aviatorParallel = isMap(aviatorDoc) && isMap(aviatorDoc.merge_rules) && isMap(aviatorDoc.merge_rules.merge_mode) && aviatorDoc.merge_rules.merge_mode.type === 'parallel';
  const queueStrict =
    firstIn(workflows, /\bmerge_group\b/) ??
    (mergify?.text && /^queue_rules\s*:/m.test(mergify.text) ? mergify.path : undefined) ??
    (bors?.text && /^\s*status\s*=/m.test(decomment(bors.text)) ? bors.path : undefined) ??
    (aviatorParallel ? aviator!.path : undefined);
  const queueConfig = (kodiak?.text ? kodiak.path : undefined) ?? (aviator?.text ? aviator.path : undefined) ?? (mergify?.text && /^extends\s*:/m.test(mergify.text) ? mergify.path : undefined);
  const queueKnown = mergify !== undefined && kodiak !== undefined && bors !== undefined && aviator !== undefined;

  // Frozen installs: pnpm fails an install in CI when the lockfile needs an update (pnpm.io/cli/install), and Yarn 2+
  // turns on enableImmutableInstalls on CI (yarnpkg.com/configuration/yarnrc), unless it's turned off.
  const yarnrc = config('.yarnrc.yml');
  const yarnImmutable = !!yarnrc?.path && !/enableImmutableInstalls:\s*false/.test(yarnrc.text) && !/YARN_ENABLE_IMMUTABLE_INSTALLS:\s*['"]?(false|0)/.test(all);
  const frozen = firstIn(ci, (f) =>
    /--frozen-lockfile|npm ci\b|--immutable|--locked|--frozen\b/.test(f.text) ||
    /\bpnpm (install|i)\b(?![^\n]*(--no-frozen-lockfile|\s-g\b|--global))|run_install:\s*(?!false)\S/.test(f.text) ||
    (yarnImmutable && /\byarn( install)?\s*($|&&|;)/m.test(f.text)),
  );

  // Dependency caches: any `…/cache` action, setup actions' cache inputs, and setup-go, which caches by default since v4.
  const depCache = firstIn(ci, (f) =>
    /actions\/cache|cache:\s*['"]?(npm|pnpm|yarn|pip|pipenv|poetry|gradle|maven|bun|sbt)|enable-cache|cache-dependency-path|rust-cache|setup-gradle|bundler-cache:\s*true/.test(f.text) ||
    /uses:\s*['"]?[\w.-]+\/(?![\w.-]*sccache)[\w.-]*cache[\w.-]*(\/[\w.-]+)*@/i.test(f.text) ||
    (/actions\/setup-go@v([4-9]|\d{2})/.test(f.text) && !/cache:\s*false/.test(f.text)),
  );
  const cargo = config('.cargo/config.toml', '.cargo/config');

  // Dependency updates batched: each bot's config, then the bots' merged pull requests.
  const dependabot = config(...DEPENDABOT);
  const renovateFile = config(...RENOVATE);
  const renovateInPkg = (() => {
    try {
      const r = pkg ? JSON.parse(pkg).renovate : undefined;
      return r === undefined ? undefined : JSON.stringify(r);
    } catch {
      return undefined;
    }
  })();
  const renovate = renovateFile?.path || !renovateInPkg ? renovateFile : { path: 'package.json', text: renovateInPkg };
  const sharedPreset = RENOVATE_SHARED_PRESET.test(renovate?.text ?? '');
  const configGroups = RENOVATE_BATCHES.test((renovate?.text ?? '').replace(LOCK_FILE_MAINTENANCE, '')) ? renovate!.path : /groups:/.test(decomment(dependabot?.text ?? '')) ? dependabot!.path : undefined;
  const botPrs = (history?.prs ?? []).filter((p) => DEP_BOT.test(p.login));
  const depStrict = configGroups ?? (botPrs.some((p) => GROUPED_TITLE.test(p.title)) ? 'pull requests' : undefined);
  const depHint = !depStrict && botPrs.some((p) => GROUP_WORDS.test(p.title)) ? ({ path: 'pull requests', kind: 'title' } as const) : undefined;
  const depConfigs = !!(dependabot?.path || renovate?.path);
  const depKnown = dependabot !== undefined && renovate !== undefined && pkgKnown && !sharedPreset;
  if (!depStrict && !depHint && depKnown && !depConfigs) {
    if (!history) unknown.push("A checkout has no pull requests to show a bot's grouped updates, and holds no dependency bot config, so batching can't be told");
    else if (!botPrs.length) unknown.push('No dependency bot config and no bot pull requests merged in the window, so there are no updates to batch');
    else if (!history.complete) unknown.push("The window's merged pull requests run past one page of search, and no config says whether bots group updates");
  }
  if (!depStrict && sharedPreset) unknown.push(`${renovate!.path} extends a preset kept in another repo, so whether it batches updates can't be read here`);

  return {
    workflows: wf.all.length,
    // B. Running less
    cancelInProgress: decide('cancelInProgress', firstIn(onPr, /cancel-in-progress:\s*(true|\$\{\{)|styfle\/cancel-workflow-action/), word(onPr, /cancel[-_ ]?(previous|superseded|outdated|redundant|duplicate|others)\b|skip-duplicate-actions/i), inSteps),
    pathFilters: decide('pathFilters', prPaths ?? firstIn(onPr, /dorny\/paths-filter|changed-files/), word(onPr, CHANGED_FILES), inSteps && parsedAll),
    affected: decide('affected', firstIn(ci, AFFECTED) ?? changes.strict, changes.named ? { path: changes.named, kind: 'job' } : word(ci, AFFECTED_WORDS), inSteps && parsedAll),
    draftSkip: decide('draftSkip', firstIn(onPr, /draft\s*==\s*'?false'?|draft\s*!=\s*'?true'?|!\s*\(?\s*github\.event\.pull_request\.draft|ready_for_review/), word(onPr, /^\s*(-\s*)?if:[^\n]*\bdraft\b/im), inWorkflows),
    mergeQueue: decide('mergeQueue', queueStrict, queueConfig ? { path: queueConfig, kind: 'config' } : word(ci, QUEUE_WORDS), inWorkflows && queueKnown),
    scheduled: decide('scheduled', firstIn(workflows, /^\s*schedule:/m), word(workflows, /^name:[^\n]*\b(nightly|weekly|daily|cron|sweep)\b/im), inWorkflows),
    // C. Reusing work
    depCache: decide('depCache', depCache, word(ci, /\bcache\b/i), inSteps),
    remoteCache: decide('remoteCache', remoteStrict, remoteConfigHint ? { path: remoteConfigHint, kind: 'config' } : remoteHint ? { path: remoteHint, kind: 'word' } : undefined, inSteps && cacheConfigs.every((c) => c.text !== undefined)),
    compilerCache: decide(
      'compilerCache',
      firstIn(ci, /rust-cache|sccache|ccache/) ?? (cargo?.text && /rustc-wrapper\s*=\s*["'][^"']*cache/.test(cargo.text) ? cargo.path : undefined),
      word(ci, /cachix|buildcache|compil\w*[-_ ]?cache|\btarget\b[^\n]{0,60}\bcache\b|\bcache\b[^\n]{0,60}\btarget\b/i),
      inSteps && cargo !== undefined,
    ),
    frozenInstall: decide('frozenInstall', frozen, word(ci, /\bvp (install|i)\b|\bnci\b|\bbun ci\b/), inSteps && yarnrc !== undefined),
    // D. Shards and runners
    shardsConfigured: decide('shardsConfigured', firstIn(ci, /--shard|shardIndex|shard_index|total-shards|split-tests|knapsack|--partition|--splits?\b|CI_NODE_(INDEX|TOTAL)|matrix\.shard\b/i), word(ci, /\b(shards?|chunks?|partitions?|slices?)\b/i), inSteps),
    // `timeout-minutes` is GitHub's one form, and a local action can't set a job's: there's nothing looser to take.
    timeouts: decide('timeouts', firstIn(workflows, /timeout-minutes/), undefined, inWorkflows),
    // E. Workspace tooling
    taskRunner: named(['turbo.json', 'nx.json', 'MODULE.bazel', 'WORKSPACE', 'moon.yml', '.moon/workspace.yml', 'pants.toml'].find((p) => has(p)) ?? (vitePlus ? 'vite-plus' : undefined), treeComplete && pkgKnown),
    packageManager: named(
      has('pnpm-lock.yaml') ? 'pnpm' : has(/^bun\.lockb?$/) ? 'bun' : has('yarn.lock') ? (has('.yarnrc.yml') ? 'yarn berry' : 'yarn 1') : has('package-lock.json') ? 'npm' : undefined,
      treeComplete,
    ),
    fastLint: decide('fastLint', find(/^biome\.jsonc?$/) ?? find(/^(\.?oxlintrc\.json|oxlint\.config\.[cm]?[jt]s)$/) ?? (inPkg(/"(oxlint|@biomejs\/biome|vite-plus)"/) ? 'package.json' : undefined), undefined, treeComplete && pkgKnown),
    eslint: decide('eslint', (inPkg(/"eslint"/) ? 'package.json' : undefined) ?? find(/^(\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]s)$/), undefined, treeComplete && pkgKnown),
    testRunner: named(testRunner, treeComplete && pkgKnown && inSteps),
    // F. Tests and flakes
    testResults: decide('testResults', firstIn(ci, /junit|buildpulse|trunk-io|test-results|test-reporter|codecov\/test-results-action|ctrf|allure|xunit|\.trx\b|publish-unit-test-result/i), word(ci, /--reporters?[= ]|test[-_ ]?reports?/i), inSteps),
    // G. Health
    depBotsBatched: decide('depBotsBatched', depStrict, depHint, depKnown && (depConfigs || (!!history && botPrs.length > 0 && history.complete))),
    // H. Ready for agents
    agentsMd: agentsMd.length || treeComplete ? agentsMd : null,
    agentRules: decide('agentRules', find(/^\.cursor\/rules\/|^\.cursorrules$|^\.(agents|claude)\/(skills|agents|commands)\/|^\.github\/instructions\/|^\.windsurf\/rules\/|^\.clinerules/), undefined, treeComplete),
    preCommit: decide(
      'preCommit',
      find(/^\.?lefthook\.ya?ml$|^\.husky\/|^\.pre-commit-config\.yaml$|^\.simple-git-hooks\.(c?js|json)$/) ?? (inPkg(/"simple-git-hooks"/) ? 'package.json' : undefined),
      find(/^\.githooks\//) ? { path: find(/^\.githooks\//)!, kind: 'config' } : undefined,
      treeComplete && pkgKnown,
    ),
    /** Each loose rule that fired where no strict one did, which left that practice null: the practice, the file and the rule, never the text. */
    hints,
    /** For each practice that's true, the path that showed it, or `pull requests` for history. */
    where,
    /** Why any practice above is null. */
    unknown,
  };
};

export type Practices = ReturnType<typeof practices>;
