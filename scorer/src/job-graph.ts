// The job graph: which jobs wait on which, from the workflow files, joined with a run's job times. It names the chain
// of jobs that sets a PR's wait, each job's blocked, queue and work time, and the job most others wait on. Guide
// sections 1 and 7 ask for this critical path, section 3 for waiting on a step instead of a whole job, and section 21
// treats it as one of the graphs to measure.
// It reads no more of GitHub than the scorer already has: the workflow files `practices` read and the jobs of the
// sampled runs, both remembered by Gh.

/** Steps that prepare a job rather than do its work. */
export const SETUP_STEP =
  /^(set up job|complete job|post |checkout|run actions\/checkout)|checkout|setup|set up|install|cache|restore|download|toolchain|login|docker pull|pnpm i\b|npm ci|yarn( install)?$|bun install|uv sync|pip install/i;

// ---------- a small YAML reader: the part of YAML workflow files use ----------

type Yaml = string | Yaml[] | { [key: string]: Yaml } | null;
interface Line { indent: number; text: string; raw: string }

/** The text before a comment: a # at the start or after a space, outside quotes. */
const uncomment = (s: string) => {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"') i++;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,-]/.test(s[i - 1]!)) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
};

/** Where a `key:` ends, or -1 when the text isn't a mapping entry. */
const keyColon = (s: string) => {
  let i = 0;
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    for (i = 1; i < s.length; i++) {
      if (s[i] === '\\' && q === '"') i++;
      else if (s[i] === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else break;
      }
    }
    const rest = s.slice(i + 1);
    const m = rest.match(/^\s*:(\s|$)/);
    return m ? i + 1 + rest.indexOf(':') : -1;
  }
  if (/^[[{|>&*!%@`-]/.test(s) && !/^-[^\s]/.test(s)) return -1;
  for (; i < s.length; i++) if (s[i] === ':' && (i + 1 === s.length || s[i + 1] === ' ')) return i;
  return -1;
};

const unquote = (s: string): string => {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2)
    return t.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[c] ?? c);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
};

/** A flow collection, such as `[a, b]` or `{ os: linux }`. */
const flow = (s: string): Yaml => {
  let i = 0;
  const ws = () => {
    while (/\s/.test(s[i] ?? '')) i++;
  };
  const value = (): Yaml => {
    ws();
    if (s[i] === '[') {
      i++;
      const xs: Yaml[] = [];
      for (ws(); s[i] !== ']' && i < s.length; ws()) {
        xs.push(value());
        ws();
        if (s[i] === ',') i++;
      }
      i++;
      return xs;
    }
    if (s[i] === '{') {
      i++;
      const o: Record<string, Yaml> = {};
      for (ws(); s[i] !== '}' && i < s.length; ws()) {
        const k = scalar(true);
        ws();
        let v: Yaml = null;
        if (s[i] === ':') {
          i++;
          v = value();
        }
        o[k] = v;
        ws();
        if (s[i] === ',') i++;
      }
      i++;
      return o;
    }
    return scalar(false);
  };
  const scalar = (isKey: boolean) => {
    const start = i;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      for (; i < s.length && s[i] !== q; i++) if (s[i] === '\\' && q === '"') i++;
      i++;
      return unquote(s.slice(start, i));
    }
    for (; i < s.length; i++) {
      if (s[i] === ',' || s[i] === ']' || s[i] === '}') break;
      if (isKey && s[i] === ':' && /[\s,}]/.test(s[i + 1] ?? ' ')) break;
      if (s.startsWith('${{', i)) {
        const end = s.indexOf('}}', i);
        if (end > 0) i = end + 1;
      }
    }
    return s.slice(start, i).trim();
  };
  return value();
};

const balanced = (s: string) => {
  let depth = 0;
  let quote = '';
  for (const c of s) {
    if (quote) quote = c === quote ? '' : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
};

/** Reads the YAML a workflow file holds: block and flow collections, quoted, plain and block scalars, anchors. */
export const parseYaml = (text: string): Yaml => {
  // A byte-order mark isn't indentation: left in, it would put the first key a column past the rest.
  const lines: Line[] = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => {
      const indent = raw.length - raw.trimStart().length;
      return { indent, raw, text: uncomment(raw).trim() };
    });
  const anchors = new Map<string, Yaml>();
  const next = (i: number) => {
    while (i < lines.length && (lines[i]!.text === '' || lines[i]!.text === '---' || lines[i]!.text.startsWith('%'))) i++;
    return i;
  };

  /** The value written after `key:` or `- `, which may go on over the lines indented past `indent`. */
  const inline = (rest: string, i: number, indent: number): [Yaml, number] => {
    let anchor: string | undefined;
    const a = rest.match(/^&(\S+)\s*(.*)$/);
    if (a) {
      anchor = a[1];
      rest = a[2]!;
    }
    let value: Yaml;
    let j = i + 1;
    if (rest === '') {
      const k = next(j);
      const child = lines[k];
      // A sequence may sit at its key's own indent.
      if (child && (child.indent > indent || (child.indent === indent && /^-(\s|$)/.test(child.text)))) [value, j] = node(k, child.indent);
      else value = null;
    } else if (rest.startsWith('*')) {
      value = anchors.get(rest.slice(1).trim()) ?? null;
    } else if (/^[|>]/.test(rest)) {
      const body: string[] = [];
      for (; j < lines.length && (lines[j]!.raw.trim() === '' || lines[j]!.indent > indent); j++) body.push(lines[j]!.raw.trim());
      value = body.join(rest.startsWith('|') ? '\n' : ' ').trim();
    } else if (rest.startsWith('[') || rest.startsWith('{')) {
      let s = rest;
      while (!balanced(s) && j < lines.length) s += ' ' + lines[j++]!.text;
      value = flow(s);
    } else {
      // A plain or quoted scalar can go on over more-indented lines.
      let s = rest;
      for (let k = next(j); k < lines.length && lines[k]!.indent > indent && keyColon(lines[k]!.text) < 0 && !/^-(\s|$)/.test(lines[k]!.text); k = next(k + 1)) {
        s += ' ' + lines[k]!.text;
        j = k + 1;
      }
      value = unquote(s);
    }
    if (anchor) anchors.set(anchor, value);
    return [value, j];
  };

  const node = (i: number, indent: number): [Yaml, number] => {
    i = next(i);
    const line = lines[i];
    if (!line || line.indent < indent) return [null, i];

    if (/^-(\s|$)/.test(line.text)) {
      const xs: Yaml[] = [];
      while ((i = next(i)) < lines.length && lines[i]!.indent === line.indent && /^-(\s|$)/.test(lines[i]!.text)) {
        const cur = lines[i]!;
        const rest = cur.text.slice(1).trimStart();
        if (rest === '' || keyColon(rest) < 0) {
          const [v, j] = inline(rest, i, cur.indent);
          xs.push(v);
          i = j;
          continue;
        }
        // `- key: value` starts a mapping at the column after the dash.
        const col = cur.indent + cur.text.length - rest.length;
        lines[i] = { indent: col, text: rest, raw: ' '.repeat(col) + rest };
        const [v, j] = node(i, col);
        lines[i] = cur;
        xs.push(v);
        i = j;
      }
      return [xs, i];
    }

    if (keyColon(line.text) >= 0) {
      const o: Record<string, Yaml> = {};
      while ((i = next(i)) < lines.length && lines[i]!.indent === line.indent) {
        const cur = lines[i]!;
        const at = keyColon(cur.text);
        if (at < 0) break;
        const key = unquote(cur.text.slice(0, at));
        const [v, j] = inline(cur.text.slice(at + 1).trim(), i, cur.indent);
        if (key === '<<' && v && typeof v === 'object' && !Array.isArray(v)) Object.assign(o, { ...v, ...o });
        else o[key] = v;
        i = j;
      }
      return [o, i];
    }

    return inline(line.text, i, line.indent - 1);
  };

  return node(0, 0)[0];
};

// ---------- the graph, from the workflow files ----------

export interface GraphJob {
  /** The job's id, or `caller/inner` for a job inside a reusable workflow. */
  key: string;
  /** The name GitHub shows, with expressions such as `${{ matrix.os }}` left in. */
  label: string;
  needs: string[];
  if?: string;
  matrix: boolean;
  /** A reusable workflow this job calls. */
  uses?: string;
  /** A caller of a workflow read here: it runs no job of its own, and finishes when its workflow's jobs do. */
  virtual: boolean;
  /** A caller of a workflow in another repo: its jobs are taken as one, their order inside unknown. */
  opaque: boolean;
  /** Matches the names of the API's jobs that are this job. */
  pattern: RegExp;
  /** How much of the name is fixed text, so the most specific pattern wins. */
  fixed: number;
}

export interface Graph {
  path: string;
  jobs: GraphJob[];
  /** What the YAML couldn't tell, such as a reusable workflow in another repo. */
  unknown: string[];
}

const EXPR = /\$\{\{[\s\S]*?\}\}/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A name as a pattern: expressions match anything, and a matrix job without one gets GitHub's ` (values)` suffix. */
const namePattern = (label: string, matrix: boolean) => {
  const parts = label.split(EXPR).map(escape);
  const body = parts.join('.*?');
  return { source: matrix && !EXPR.test(label) ? `${body}(?: \\(.*\\))?` : body, fixed: parts.join('').length };
};
const asList = (x: Yaml | undefined): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : typeof x === 'string' ? [x] : []);
const isMap = (x: Yaml | undefined): x is Record<string, Yaml> => !!x && typeof x === 'object' && !Array.isArray(x);

/** One workflow file's jobs and their `needs`, with local reusable workflows read through `read` and expanded. */
export const workflowGraph = (path: string, text: string, read: (path: string) => string | undefined): Graph => {
  const unknown: string[] = [];
  const jobs: GraphJob[] = [];

  const add = (doc: Yaml, prefix: { key: string; label: string; source: string; fixed: number; needs: string[] } | undefined, depth: number, file: string) => {
    const defs = isMap(doc) && isMap(doc.jobs) ? doc.jobs : undefined;
    if (!defs) {
      unknown.push(`${file} has no jobs this reader could find`);
      return [];
    }
    const keys: string[] = [];
    for (const [id, def] of Object.entries(defs)) {
      if (!isMap(def)) continue;
      const strategy = isMap(def.strategy) ? def.strategy : undefined;
      const matrix = !!strategy && strategy.matrix !== undefined && strategy.matrix !== null;
      const label = typeof def.name === 'string' && def.name ? def.name : id;
      const own = namePattern(label, matrix);
      const key = prefix ? `${prefix.key}/${id}` : id;
      const needs = asList(def.needs).map((n) => (prefix ? `${prefix.key}/${n}` : n));
      const source = prefix ? `${prefix.source} / ${own.source}` : own.source;
      const fixed = (prefix?.fixed ?? 0) + own.fixed;
      const uses = typeof def.uses === 'string' ? def.uses : undefined;
      const job: GraphJob = {
        key,
        label: prefix ? `${prefix.label} / ${label}` : label,
        needs: needs.length || !prefix ? needs : prefix.needs,
        ...(typeof def.if === 'string' ? { if: def.if } : {}),
        matrix,
        ...(uses ? { uses } : {}),
        virtual: false,
        opaque: false,
        pattern: new RegExp(`^${source}$`),
        fixed,
      };
      keys.push(key);
      jobs.push(job);
      if (!uses) continue;

      // A reusable workflow: its jobs show in the API as `caller / inner`.
      const local = uses.match(/^\.\/(\.github\/workflows\/[^@\s]+\.ya?ml)$/)?.[1];
      const called = local && depth < 4 ? read(local) : undefined;
      if (called === undefined) {
        if (!local) unknown.push(`"${label}" calls ${uses.split('@')[0]}, in another repo, so the jobs inside it are taken as one`);
        else if (depth >= 4) unknown.push(`"${label}" calls workflows nested past GitHub's limit`);
        else unknown.push(`"${label}" calls ${local}, which couldn't be read`);
        // GitHub shows a skipped caller under its own name, and the called jobs as `caller / inner`.
        job.pattern = new RegExp(`^${source}(?: / .+)?$`);
        job.matrix = true;
        job.opaque = true;
        continue;
      }
      const inner = add(parseYaml(called), { key, label: job.label, source, fixed, needs: job.needs }, depth + 1, local!);
      // The caller finishes when every job of its workflow has; jobs that need it wait for all of them.
      job.virtual = true;
      job.needs = inner;
    }
    return keys;
  };

  try {
    add(parseYaml(text), undefined, 1, path);
  } catch (e) {
    unknown.push(`${path} couldn't be read as YAML: ${(e as Error).message}`);
  }
  const known = new Set(jobs.map((j) => j.key));
  for (const j of jobs) j.needs = j.needs.filter((n) => known.has(n));
  return { path, jobs, unknown };
};

// ---------- one run: the graph joined with the jobs' times ----------

export interface ApiJob {
  id: number;
  name: string;
  conclusion: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  steps?: { name: string; started_at: string | null; completed_at: string | null; conclusion: string | null }[];
}

export interface RunJob {
  id: number;
  name: string;
  /** The graph's job this is, or undefined when no job in the YAML matched its name. */
  key: string | undefined;
  needs: string[];
  /** Minutes from the run's start: when its last `needs` finished, when a runner took it, when it ended. */
  readyMin: number;
  startMin: number;
  endMin: number;
  blockedMin: number;
  /** From when GitHub could have queued it, by its known needs, to when it did: a wait the YAML doesn't show. */
  hiddenMin: number;
  queueMin: number;
  workMin: number;
  setupMin: number;
}

export interface Link {
  name: string;
  key: string | undefined;
  blockedMin: number;
  hiddenMin: number;
  queueMin: number;
  workMin: number;
  setupMin: number;
  /** This link's part of the run's wait: from the job before it finishing to this one finishing. */
  share: number;
}

const mins = (a: number, b: number) => (b - a) / 60e3;
/** A job's name for people: each expression, such as a matrix value, as `…`. */
const shownName = (label: string) => label.replace(EXPR, '…');
const ms = (s: string) => Date.parse(s);
const LATE_MIN = 2;
const PRODUCES = /upload|publish|push|save|pack|artifact|snapshot|build/i;
const CONSUMES = /download|restore|fetch|pull|artifact|wait/i;
const WAIT_STEP = /\bwait|poll|sleep/i;

/** One run: when each job could start, the chain that ended last, the job most others waited on, and odd waits. */
export const runGraph = (graph: Graph | undefined, all: ApiJob[]) => {
  const ran = all.filter((j) => j.conclusion !== 'skipped' && j.started_at && j.completed_at);
  if (!ran.length) return undefined;
  const nodes = new Map((graph?.jobs ?? []).map((j) => [j.key, j]));

  // Each job to the most specific graph job whose name pattern takes it.
  // A caller of a workflow read here matches only its own name, which GitHub shows when it's skipped.
  const candidates = [...nodes.values()].sort((a, b) => b.fixed - a.fixed);
  const keyOf = new Map<number, string | undefined>();
  for (const j of all) keyOf.set(j.id, candidates.find((n) => n.pattern.test(j.name))?.key);
  const instances = new Map<string, ApiJob[]>();
  for (const j of ran) {
    const k = keyOf.get(j.id);
    if (k) instances.set(k, [...(instances.get(k) ?? []), j]);
  }

  const runStart = Math.min(...ran.map((j) => ms(j.created_at)));
  const finishMemo = new Map<string, number>();
  const finish = (key: string, seen = new Set<string>()): number => {
    const hit = finishMemo.get(key);
    if (hit !== undefined) return hit;
    if (seen.has(key)) return runStart;
    seen.add(key);
    const own = instances.get(key);
    // A job that didn't run, skipped by its `if:` or a caller of a reusable workflow, is done when its needs are.
    const t = own?.length ? Math.max(...own.map((j) => ms(j.completed_at!))) : ready(key, seen);
    finishMemo.set(key, t);
    return t;
  };
  const ready = (key: string, seen = new Set<string>()) => {
    const needs = nodes.get(key)?.needs ?? [];
    return needs.length ? Math.max(runStart, ...needs.map((n) => finish(n, seen))) : runStart;
  };
  /** The need that finished last: the one that let this job start. */
  const releasedBy = (key: string) => {
    const needs = nodes.get(key)?.needs ?? [];
    return needs.length ? needs.reduce((a, b) => (finish(b) > finish(a) ? b : a)) : undefined;
  };

  // Steps' times held inside their job's: GitHub gives some steps placeholder times, such as the year 1.
  const setupOf = (j: ApiJob) => {
    const [from, to] = [ms(j.started_at!), ms(j.completed_at!)];
    const clamp = (t: number) => Math.min(to, Math.max(from, t));
    return (j.steps ?? [])
      .filter((s) => s.started_at && s.completed_at && SETUP_STEP.test(s.name))
      .reduce((a, s) => a + Math.max(0, mins(clamp(ms(s.started_at!)), clamp(ms(s.completed_at!)))), 0);
  };
  const timed = (j: ApiJob): RunJob => {
    const key = keyOf.get(j.id);
    const start = ms(j.started_at!);
    // A job can't start before what it needs is done; if the times say it did, the join is off, and it reads as unblocked then.
    const readyAt = Math.min(key ? ready(key) : runStart, start);
    // GitHub creates a job when its needs are done. Created later than the YAML says it could be, it waited on
    // something else, such as a concurrency group or an environment; created on time but started late, on a runner.
    const queuedAt = Math.min(Math.max(readyAt, ms(j.created_at)), start);
    return {
      id: j.id,
      name: j.name,
      key,
      needs: key ? (nodes.get(key)?.needs ?? []) : [],
      readyMin: mins(runStart, readyAt),
      startMin: mins(runStart, start),
      endMin: mins(runStart, ms(j.completed_at!)),
      blockedMin: mins(runStart, readyAt),
      hiddenMin: mins(readyAt, queuedAt),
      queueMin: mins(queuedAt, start),
      workMin: mins(start, ms(j.completed_at!)),
      setupMin: setupOf(j),
    };
  };
  const jobs = ran.map(timed);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const lastOf = (key: string) => instances.get(key)?.reduce((a, b) => (b.completed_at! > a.completed_at! ? b : a));

  /** The jobs that, one after another, let this one start: through the need that finished last, skipping jobs that didn't run. */
  const chainBefore = (key: string | undefined) => {
    const chain: ApiJob[] = [];
    for (let k = key && releasedBy(key), guard = 0; k && guard < 200; k = releasedBy(k), guard++) {
      const j = lastOf(k);
      if (j) chain.unshift(j);
    }
    return chain;
  };

  // The critical path: back from the job that ended last.
  const end = ran.reduce((a, b) => (b.completed_at! > a.completed_at! ? b : a));
  const pathJobs = [...chainBefore(keyOf.get(end.id)), end];
  const spanMin = mins(runStart, ms(end.completed_at!));
  let before = 0;
  const path: Link[] = pathJobs.map((a) => {
    const t = byId.get(a.id)!;
    const link = { name: t.name, key: t.key, blockedMin: t.blockedMin, hiddenMin: t.hiddenMin, queueMin: t.queueMin, workMin: t.workMin, setupMin: t.setupMin, share: spanMin ? (t.endMin - before) / spanMin : 0 };
    before = t.endMin;
    return link;
  });

  // Who holds up whom: each job is held up by every job on its own chain, for as long as that job took.
  const holds = new Map<string, Set<number>>();
  for (const j of jobs)
    for (const up of chainBefore(j.key)) {
      const k = keyOf.get(up.id)!;
      holds.set(k, (holds.get(k) ?? new Set()).add(j.id));
    }
  const blockers = [...holds]
    .map(([key, held]) => {
      const own = instances.get(key)!;
      // From when it could start to when its last instance ended: what the jobs behind it would gain were it instant.
      const tookMin = mins(ready(key), finish(key));
      return { key, name: own.length === 1 ? own[0]!.name : shownName(nodes.get(key)!.label), heldJobs: held.size, tookMin, heldJobMin: held.size * tookMin };
    })
    .sort((a, b) => b.heldJobMin - a.heldJobMin);

  // Setup that waits on nothing can't move earlier; setup in a job on the path that waited on another could overlap it.
  const setupInPathMin = path.filter((l) => l.blockedMin > 0).reduce((a, l) => a + l.setupMin, 0);

  // A job that needs a whole job when it may need only one step of it: the upstream job's last step that makes
  // something ended well before the job did, and the waiting job's steps fetch something. A guess from names.
  const stepWaits: { job: string; waitsOn: string; step: string; earlyMin: number }[] = [];
  for (const [key, node] of nodes) {
    const down = instances.get(key);
    const upKey = releasedBy(key);
    const up = upKey && lastOf(upKey);
    if (!down?.length || !up || !node.needs.length) continue;
    if (!down.some((d) => (d.steps ?? []).some((s) => CONSUMES.test(s.name) && !/^(set up job|post )/i.test(s.name)))) continue;
    const made = (up.steps ?? []).filter((s) => s.completed_at && PRODUCES.test(s.name) && !SETUP_STEP.test(s.name)).at(-1);
    if (!made) continue;
    const earlyMin = mins(ms(made.completed_at!), ms(up.completed_at!));
    if (earlyMin >= LATE_MIN) stepWaits.push({ job: down.length === 1 ? down[0]!.name : shownName(node.label), waitsOn: up.name, step: made.name, earlyMin });
  }

  // Waits the YAML can't show: a job that got its runner long after its needs were done, when the others got theirs
  // quickly, is likely waiting on something else, such as another workflow or a concurrency group.
  // The jobs inside a workflow in another repo wait on each other in ways this file doesn't show, so they're left out.
  const lateStarts = jobs.filter((j) => j.hiddenMin > LATE_MIN && !(j.key && nodes.get(j.key)?.opaque)).map((j) => ({ name: j.name, lateMin: j.hiddenMin }));
  const waitSteps = ran.flatMap((j) =>
    (j.steps ?? [])
      .filter((s) => s.started_at && s.completed_at && WAIT_STEP.test(s.name) && mins(ms(s.started_at), ms(s.completed_at)) >= 1)
      .map((s) => ({ job: j.name, step: s.name, minutes: mins(ms(s.started_at!), ms(s.completed_at!)) })),
  );

  return {
    spanMin,
    jobs,
    path,
    end: end.name,
    // The last job's wait on the jobs before it; with the path's queue and work time, it makes up the run.
    blockedMin: path.at(-1)!.blockedMin,
    hiddenMin: path.reduce((a, l) => a + l.hiddenMin, 0),
    queueMin: path.reduce((a, l) => a + l.queueMin, 0),
    workMin: path.reduce((a, l) => a + l.workMin, 0),
    setupInPathMin,
    topBlocker: blockers[0],
    stepWaits,
    lateStarts,
    waitSteps,
    unmatched: ran.filter((j) => graph && !keyOf.get(j.id)).map((j) => j.name),
    skipped: [...nodes.values()].filter((n) => !n.virtual && !instances.get(n.key)?.length).map((n) => n.label),
  };
};

// ---------- across the sampled runs ----------

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.ceil(s.length / 2) - 1]! : NaN;
};
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

export interface SampledRun {
  id: number;
  /** The run's workflow file, such as `.github/workflows/ci.yml`. */
  path: string;
  /** Every job of the run's first attempt, skipped ones too. */
  jobs: ApiJob[];
}

/**
 * The job graph of the sampled runs: what sets the wait most often, how long the path is, what's blocked and queued
 * on it, the top blockers and the waits the YAML can't show. `read` answers a workflow file's text, as `practices` read it.
 */
export const jobGraphOf = (read: (path: string) => string | undefined, sampled: SampledRun[]) => {
  const graphs = new Map<string, Graph | undefined>();
  const graphFor = (path: string) => {
    if (!graphs.has(path)) {
      const text = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ? read(path) : undefined;
      graphs.set(path, text === undefined ? undefined : workflowGraph(path, text, read));
    }
    return graphs.get(path);
  };
  const runs = sampled.flatMap((s) => {
    const g = runGraph(graphFor(s.path), s.jobs);
    return g ? [{ id: s.id, workflow: s.path, ...g }] : [];
  });
  if (!runs.length) return undefined;

  const paths = [...new Set(runs.map((r) => r.workflow))];
  const graph = graphFor(paths[0]!);
  const shape = graph && {
    jobs: graph.jobs.filter((j) => !j.virtual).length,
    edges: graph.jobs.reduce((a, j) => a + j.needs.length, 0),
    matrixJobs: graph.jobs.filter((j) => j.matrix && !j.uses).length,
    reusableCalls: graph.jobs.filter((j) => j.uses).length,
  };

  // The chain by its graph jobs, so matrix instances that differ by run count as one chain.
  const chainSig = (r: (typeof runs)[number]) => r.path.map((l) => l.key ?? l.name).join(' → ');
  const [topChain, chainRuns] = tally(runs.map(chainSig))[0]!;
  const withChain = runs.filter((r) => chainSig(r) === topChain);
  const chain = withChain[0]!.path.map((l, i) => ({
    name: l.name,
    minutes: r1(median(withChain.map((r) => r.path[i]!.share * r.spanMin))),
    share: r2(median(withChain.map((r) => r.path[i]!.share))),
    blockedMin: r1(median(withChain.map((r) => r.path[i]!.blockedMin))),
    hiddenMin: r1(median(withChain.map((r) => r.path[i]!.hiddenMin))),
    queueMin: r1(median(withChain.map((r) => r.path[i]!.queueMin))),
    workMin: r1(median(withChain.map((r) => r.path[i]!.workMin))),
    setupMin: r1(median(withChain.map((r) => r.path[i]!.setupMin))),
  }));

  const blockers = tally(runs.flatMap((r) => (r.topBlocker && r.topBlocker.heldJobs > 0 ? [r.topBlocker.key] : []))).slice(0, 3).map(([key, n]) => {
    const bs = runs.map((r) => r.topBlocker).filter((b) => b?.key === key);
    return {
      name: bs[0]!.name,
      runs: n,
      heldJobs: Math.round(median(bs.map((b) => b!.heldJobs))),
      jobs: Math.round(median(runs.filter((r) => r.topBlocker?.key === key).map((r) => r.jobs.length))),
      tookMin: r1(median(bs.map((b) => b!.tookMin))),
      heldJobMin: r1(median(bs.map((b) => b!.heldJobMin))),
    };
  });

  const stepWaits = tally(runs.flatMap((r) => r.stepWaits.map((w) => `${w.job}\0${w.waitsOn}`))).map(([k, n]) => {
    const ws = runs.flatMap((r) => r.stepWaits).filter((w) => `${w.job}\0${w.waitsOn}` === k);
    return { job: ws[0]!.job, waitsOn: ws[0]!.waitsOn, step: ws[0]!.step, earlyMin: r1(median(ws.map((w) => w.earlyMin))), runs: n, guess: true as const };
  });

  const late = runs.filter((r) => r.lateStarts.length);
  return {
    runsSampled: runs.length,
    workflows: paths,
    ...(shape ?? {}),
    gateEnd: tally(runs.map((r) => r.end)).slice(0, 3).map(([name, n]) => ({ name, runs: n })),
    chain,
    chainRuns,
    pathJobsP50: Math.round(median(runs.map((r) => r.path.length))),
    pathMinP50: r1(median(runs.map((r) => r.spanMin))),
    blockedMinP50: r1(median(runs.map((r) => r.blockedMin))),
    queueMinP50: r1(median(runs.map((r) => r.queueMin))),
    hiddenMinP50: r1(median(runs.map((r) => r.hiddenMin))),
    workMinP50: r1(median(runs.map((r) => r.workMin))),
    setupInPathMinP50: r1(median(runs.map((r) => r.setupInPathMin))),
    topBlockers: blockers,
    stepWaits,
    hidden: {
      runs: late.length,
      jobs: tally(late.flatMap((r) => r.lateStarts.map((l) => l.name))).slice(0, 3).map(([name, n]) => ({ name, runs: n })),
      lateMinP50: r1(median(late.flatMap((r) => r.lateStarts.map((l) => l.lateMin)))),
      waitSteps: tally(runs.flatMap((r) => r.waitSteps.map((w) => `${w.job}: ${w.step}`))).slice(0, 3).map(([step, n]) => ({ step, runs: n })),
    },
    unmatched: tally(runs.flatMap((r) => r.unmatched)).slice(0, 5).map(([name]) => name),
    skippedP50: Math.round(median(runs.map((r) => r.skipped.length))),
    unknown: [...new Set(paths.flatMap((p) => graphFor(p)?.unknown ?? [`${p} couldn't be read, so its jobs are taken as waiting on nothing`]))],
    // Each run's jobs to scale, for a replay: minutes from the run's start.
    perRun: runs.map((r) => ({
      id: r.id,
      spanMin: r1(r.spanMin),
      path: r.path.map((l) => l.name),
      topBlocker: r.topBlocker?.name ?? null,
      jobs: r.jobs.map((j) => ({ name: j.name, needs: j.needs, readyMin: r1(j.readyMin), startMin: r1(j.startMin), endMin: r1(j.endMin), setupMin: r1(j.setupMin) })),
    })),
  };
};

export type JobGraph = NonNullable<ReturnType<typeof jobGraphOf>>;

const m = (x: number | null | undefined) => (x === null || x === undefined ? '–' : x.toFixed(1));
const runs = (n: number) => `${n} run${n === 1 ? '' : 's'}`;
const pc = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);

/** The chain that sets the wait, as one line: each job with its minutes and share. */
export const chainText = (g: JobGraph) => g.chain.map((l) => `"${l.name}" ${m(l.minutes)} min (${pc(l.share)})`).join(' → ');
export const blockerText = (g: JobGraph) => {
  const b = g.topBlockers[0];
  return b ? `"${b.name}" holds up ${b.heldJobs} of ${b.jobs} jobs for ${m(b.tookMin)} min, ${m(b.heldJobMin)} job-min (${b.runs} of ${g.runsSampled} runs)` : 'none: no job waits on another';
};

/** The two `<ci-report>` lines. */
export const promptLines = (g: JobGraph) => [
  `Chain that sets the wait: ${chainText(g)}; ${g.chainRuns} of ${g.runsSampled} runs; on it p50 blocked ${m(g.blockedMinP50)}, queue ${m(g.queueMinP50)}, setup after a wait ${m(g.setupInPathMinP50)} min`,
  `Top blocker: ${blockerText(g)}`,
];

/** The text report's "Job graph" block. */
export const graphBlock = (g: JobGraph) => {
  const shape = g.jobs === undefined ? '' : `, ${g.jobs} jobs, ${g.edges} needs edges, ${g.matrixJobs} matrix, ${g.reusableCalls} reusable workflow call${g.reusableCalls === 1 ? '' : 's'}`;
  const lines = [
    `Job graph (${g.workflows.join(', ')}${shape}; ${g.runsSampled} runs):`,
    `  Sets the wait       ${chainText(g)} (${g.chainRuns} of ${g.runsSampled} runs)`,
    `  Ends the gate       ${g.gateEnd.map((e) => `"${e.name}" ×${e.runs}`).join(', ')}`,
    `  Critical path p50   ${g.pathJobsP50} job${g.pathJobsP50 === 1 ? '' : 's'}, ${m(g.pathMinP50)} min: work ${m(g.workMinP50)}, queue ${m(g.queueMinP50)}; the last job blocked ${m(g.blockedMinP50)}`,
    `  Top blocker         ${blockerText(g)}`,
    ...g.topBlockers.slice(1).map((b) => `                      then "${b.name}", ${b.heldJobs} jobs for ${m(b.tookMin)} min (${runs(b.runs)})`),
    `  Setup in the path   ${m(g.setupInPathMinP50)} min p50 in jobs that first waited on others, which overlapping with upstream work could hide`,
    ...g.stepWaits.slice(0, 2).map((w) => `  One step, a guess   "${w.job}" waits on all of "${w.waitsOn}", whose "${w.step}" ended ${m(w.earlyMin)} min before it did (${runs(w.runs)})`),
    g.hidden.runs
      ? `  Waits not in YAML   ${g.hidden.runs} of ${g.runsSampled} runs had a job GitHub queued over ${LATE_MIN} minutes after its needs finished (${g.hidden.jobs.map((j) => `"${j.name}"`).join(', ')}, p50 ${m(g.hidden.lateMinP50)} min): it waited on something the YAML doesn't name, such as a concurrency group or an environment`
      : `  Waits not in YAML   none seen: GitHub queued every job as soon as its needs finished`,
    ...(g.hidden.waitSteps.length ? [`  Waiting steps       ${g.hidden.waitSteps.map((w) => `${w.step} (${runs(w.runs)})`).join(', ')}`] : []),
    ...(g.unmatched.length ? [`  Not in the YAML     ${g.unmatched.map((n) => `"${n}"`).join(', ')}: taken as waiting on nothing`] : []),
    ...g.unknown.map((u) => `  Unknown because: ${u}.`),
    `  Other workflows, \`workflow_run\` triggers and polling actions can hold a job up without \`needs\`; the YAML of one workflow doesn't show them.`,
  ];
  return lines.join('\n');
};

/** Fixes the graph shows, in `fixesOf`'s shape. */
export const graphFixes = (g: JobGraph | undefined) => {
  if (!g) return [];
  const fixes: { text: string; page: string; weight: number }[] = [];
  const setup = g.setupInPathMinP50 ?? 0;
  if (setup >= 1 && setup >= 0.1 * (g.pathMinP50 ?? Infinity))
    fixes.push({
      text: `Setup on the critical path: ${m(setup)} min of setup in jobs that first wait on others; start it while they wait, and wait only for the step you need`,
      page: '07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores',
      weight: 6,
    });
  const b = g.topBlockers[0];
  if (b && b.runs * 2 >= g.runsSampled && b.heldJobs * 2 >= b.jobs && (b.tookMin ?? 0) >= 3)
    fixes.push({
      text: `A blocker most jobs wait on: "${b.name}" holds up ${b.heldJobs} of ${b.jobs} jobs for ${m(b.tookMin)} min; shorten it, or let them start setup and wait only for what they need`,
      page: '21-optimize-all-of-your-graphs.md#ci-jobs',
      weight: 6,
    });
  return fixes;
};
