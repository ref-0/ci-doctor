// The job graph: which jobs wait on which, from the workflow files, joined with a run's job times. It names the chain
// of jobs that sets a PR's wait, each job's blocked, queue and work time, and the job most others wait on. Guide
// sections 1 and 7 ask for this critical path, section 3 for waiting on a step instead of a whole job, and section 21
// treats it as one of the graphs to measure.
// It reads no more of GitHub than the scorer already has: the workflow files `practices` read and the jobs of the
// sampled runs, both remembered by Gh.

import { runnerOf, vcpusOf } from './runners.ts';

/** Steps that prepare a job rather than do its work. */
export const SETUP_STEP =
  /^(set up job|complete job|post |checkout|run actions\/checkout)|checkout|setup|set up|install|cache|restore|download|toolchain|login|docker pull|pnpm i\b|npm ci|yarn( install)?$|bun install|uv sync|pip install/i;

// ---------- a small YAML reader: the part of YAML workflow files use ----------

export type Yaml = string | Yaml[] | { [key: string]: Yaml } | null;
interface Line { indent: number; text: string; raw: string }

/** The text before a comment: a # at the start or after a space, outside quotes. */
export const uncomment = (s: string) => {
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
  /** A caller's own `needs`, which its workflow's first jobs wait on. */
  after?: string[];
  /** Matches the names of the API's jobs that are this job. */
  pattern: RegExp;
  /** The same, with any value in a matrix slot: for a run whose matrix values differ from today's YAML. */
  loose: RegExp;
  /** How much of the name is fixed text, so the most specific pattern wins. */
  fixed: number;
}

export interface Graph {
  path: string;
  jobs: GraphJob[];
  /** What the YAML couldn't tell, such as a reusable workflow in another repo. */
  unknown: string[];
}

/** GitHub runs reusable workflows nested up to 10 levels, the caller's own file counted. */
const MAX_NESTING = 10;
const EXPR = /\$\{\{[\s\S]*?\}\}/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asList = (x: Yaml | undefined): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : typeof x === 'string' ? [x] : []);
const isMap = (x: Yaml | undefined): x is Record<string, Yaml> => !!x && typeof x === 'object' && !Array.isArray(x);
const plainValue = (x: Yaml | undefined): x is string => typeof x === 'string' && !x.includes('${{');

/**
 * The values each `matrix.<key>` can take, such as `os` or `config.os` for a list of objects, from the lists and
 * `include`. A key set by an expression, such as `fromJSON(...)`, is undefined: its values can't be known here.
 */
export const matrixValues = (matrix: Yaml | undefined) => {
  const values = new Map<string, Set<string> | undefined>();
  const put = (key: string, v: Yaml | undefined) => {
    if (values.has(key) && values.get(key) === undefined) return;
    if (plainValue(v)) values.set(key, (values.get(key) ?? new Set()).add(v));
    else if (isMap(v)) for (const [k, x] of Object.entries(v)) put(`${key}.${k}`, x);
    else values.set(key, undefined);
  };
  if (!isMap(matrix)) return { values, known: false };
  for (const [key, list] of Object.entries(matrix)) {
    if (key === 'exclude') continue;
    if (key === 'include') {
      if (!Array.isArray(list)) return { values, known: false };
      for (const entry of list) if (isMap(entry)) for (const [k, v] of Object.entries(entry)) put(k, v);
      continue;
    }
    if (Array.isArray(list)) for (const v of list) put(key, v);
    else values.set(key, undefined);
  }
  return { values, known: true };
};

const MATRIX_REF = /^\$\{\{\s*matrix\.([\w.-]+)\s*\}\}$/;
/**
 * A name as a pattern. `${{ matrix.os }}` matches only the values the matrix gives `os`, when they're known; any other
 * expression matches anything. A matrix job whose name holds no expression gets GitHub's ` (values)` suffix.
 */
const namePattern = (label: string, matrix: boolean, values = new Map<string, Set<string> | undefined>()) => {
  const parts = label.split(EXPR).map(escape);
  const slots = (label.match(EXPR) ?? []).map((e) => {
    const vs = values.get(e.match(MATRIX_REF)?.[1] ?? '');
    return vs?.size ? `(?:${[...vs].sort((a, b) => b.length - a.length).map(escape).join('|')})` : '.*?';
  });
  const body = parts.map((p, i) => p + (slots[i] ?? '')).join('');
  const any = parts.join('.*?');
  const suffix = matrix && !slots.length ? '(?: \\(.*\\))?' : '';
  return { source: body + suffix, loose: any + suffix, fixed: parts.join('').length };
};

/**
 * One workflow file's jobs and their `needs`, with local reusable workflows read through `read` and expanded. With
 * `repo`, its `owner/name`, a call that names this repo in full, such as `owner/name/.github/workflows/build.yml@main`,
 * is local too, read as `read` has the file, whichever ref the call names.
 */
export const workflowGraph = (path: string, text: string, read: (path: string) => string | undefined, repo?: string): Graph => {
  const inRepo = repo ? new RegExp(`^${escape(repo)}/(\\.github/workflows/[^@\\s]+\\.ya?ml)@\\S+$`, 'i') : undefined;
  const unknown: string[] = [];
  const jobs: GraphJob[] = [];

  const add = (doc: Yaml, prefix: { key: string; label: string; source: string; loose: string; fixed: number; needs: string[] } | undefined, depth: number, file: string) => {
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
      const own = namePattern(label, matrix, matrixValues(strategy?.matrix).values);
      const key = prefix ? `${prefix.key}/${id}` : id;
      const needs = asList(def.needs).map((n) => (prefix ? `${prefix.key}/${n}` : n));
      const source = prefix ? `${prefix.source} / ${own.source}` : own.source;
      const loose = prefix ? `${prefix.loose} / ${own.loose}` : own.loose;
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
        loose: new RegExp(`^${loose}$`),
        fixed,
      };
      keys.push(key);
      jobs.push(job);
      if (!uses) continue;

      // A reusable workflow: its jobs show in the API as `caller / inner`.
      // `./` is this repo, at the caller's commit: never another repo's, however it reads.
      const local = uses.trim().match(/^\.\/(\.github\/workflows\/[^@\s]+\.ya?ml)$/)?.[1] ?? (inRepo ? uses.trim().match(inRepo)?.[1] : undefined);
      let called: string | undefined;
      let failed = '';
      try {
        called = local && depth < MAX_NESTING ? read(local) : undefined;
      } catch (e) {
        failed = ` (${(e as Error).message.replace(/\.$/, '')})`;
      }
      if (called === undefined) {
        if (!local) unknown.push(`"${label}" calls ${uses.split('@')[0]}, in another repo, so the jobs inside it are taken as one`);
        else if (depth >= MAX_NESTING) unknown.push(`"${label}" calls ${local} past GitHub's ${MAX_NESTING} levels of nesting`);
        else unknown.push(`"${label}" calls ${local}, which couldn't be read${failed}`);
        // GitHub shows a skipped caller under its own name, and the called jobs as `caller / inner`.
        job.pattern = new RegExp(`^${source}(?: / .+)?$`);
        job.loose = new RegExp(`^${loose}(?: / .+)?$`);
        job.matrix = true;
        job.opaque = true;
        continue;
      }
      const inner = add(parseYaml(called), { key, label: job.label, source, loose, fixed, needs: job.needs }, depth + 1, local!);
      // The caller finishes when every job of its workflow has; jobs that need it wait for all of them.
      job.virtual = true;
      job.after = job.needs;
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
  /** The runner labels the job asked for, as `runs-on` resolved them. */
  labels?: string[];
  steps?: { name: string; started_at: string | null; completed_at: string | null; conclusion: string | null }[];
}

export interface RunJob {
  id: number;
  name: string;
  /** The graph's job this is, or undefined when no job in the YAML matched its name. */
  key: string | undefined;
  needs: string[];
  /** Minutes from the run's start: when its last `needs` finished, when GitHub created it, when a runner took it, when it ended. */
  readyMin: number;
  createdMin: number;
  startMin: number;
  endMin: number;
  blockedMin: number;
  /** From when GitHub could have queued it, by its known needs, to when it did: a wait the YAML doesn't show. */
  hiddenMin: number;
  queueMin: number;
  workMin: number;
  setupMin: number;
  labels: string[];
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

  // Each job to the most specific graph job whose name pattern takes it. Two equally specific ones leave it
  // unmatched rather than guessed. A caller of a workflow read here matches only its own name, shown when it's skipped.
  const candidates = [...nodes.values()];
  const keyOf = new Map<number, string | undefined>();
  const ambiguous: string[] = [];
  // GitHub trims a name, so an empty matrix value at either end leaves no space there.
  const takes = (re: RegExp, name: string) => re.test(name) || re.test(`${name} `) || re.test(` ${name}`);
  const pick = (hits: GraphJob[]) => {
    const best = Math.max(...hits.map((n) => n.fixed));
    return hits.filter((n) => n.fixed === best);
  };
  for (const j of all) {
    let top = pick(candidates.filter((n) => takes(n.pattern, j.name)));
    // No job takes it with today's matrix values, as when a value was renamed since: one job that takes it with any
    // values is still that job. Two never are.
    if (!top.length) top = pick(candidates.filter((n) => takes(n.loose, j.name)));
    if (top.length > 1) ambiguous.push(j.name);
    keyOf.set(j.id, top.length === 1 ? top[0]!.key : undefined);
  }

  // A reusable workflow's jobs run once per instance of its caller, such as `call (ubuntu) / build` and
  // `call (macos) / build`, and each instance's jobs wait only on each other. So a run's nodes are the graph's jobs
  // in each caller instance they ran under: `call/build@call (ubuntu)`. A top-level job is its own key.
  const depth = (key: string) => key.split('/').length;
  const runKeyOf = (key: string, scope: string[]) => (depth(key) === 1 ? key : `${key}@${scope.slice(0, depth(key) - 1).join(' / ')}`);
  const rkOf = new Map<number, string>();
  const scopes = new Map<string, string[]>();
  const instances = new Map<string, ApiJob[]>();
  for (const j of all) {
    const key = keyOf.get(j.id);
    if (!key) continue;
    const scope = j.name.split(' / ').slice(0, depth(key) - 1);
    const rk = runKeyOf(key, scope);
    rkOf.set(j.id, rk);
    scopes.set(rk, scope);
    if (j.conclusion !== 'skipped' && j.started_at && j.completed_at) instances.set(rk, [...(instances.get(rk) ?? []), j]);
  }

  const runNodes = new Map<string, { key: string; needs: string[] }>();
  /** A run node's needs, in its own caller instance: built on first use, so a job that didn't run still has its place. */
  const runNode = (rk: string, key: string, scope: string[]) => {
    const hit = runNodes.get(rk);
    if (hit) return hit;
    const made = { key, needs: [] as string[] };
    runNodes.set(rk, made);
    const g = nodes.get(key);
    if (!g) return made;
    const at = (n: string) => {
      const sc = scope.slice(0, depth(n) - 1);
      const r = runKeyOf(n, sc);
      runNode(r, n, sc);
      return r;
    };
    if (g.virtual) {
      // A caller finishes when every job of its workflow, in this instance of its own caller, has.
      const mine = (r: string) => r.split('@')[0]!.startsWith(`${key}/`) && scopes.get(r)!.slice(0, depth(key) - 1).join(' / ') === scope.join(' / ');
      const inside = [...instances.keys()].filter(mine);
      made.needs = inside.length ? inside : (g.after ?? []).map(at);
    } else made.needs = g.needs.map(at);
    return made;
  };
  for (const [rk, scope] of scopes) runNode(rk, rk.split('@')[0]!, scope);

  const runStart = Math.min(...ran.map((j) => ms(j.created_at)));
  const finishMemo = new Map<string, number>();
  const finish = (rk: string, seen = new Set<string>()): number => {
    const hit = finishMemo.get(rk);
    if (hit !== undefined) return hit;
    if (seen.has(rk)) return runStart;
    seen.add(rk);
    const own = instances.get(rk);
    // A job that didn't run, skipped by its `if:` or a caller of a reusable workflow, is done when its needs are.
    const t = own?.length ? Math.max(...own.map((j) => ms(j.completed_at!))) : ready(rk, seen);
    finishMemo.set(rk, t);
    return t;
  };
  const ready = (rk: string, seen = new Set<string>()) => {
    const needs = runNodes.get(rk)?.needs ?? [];
    return needs.length ? Math.max(runStart, ...needs.map((n) => finish(n, seen))) : runStart;
  };
  /** The need that finished last: the one that let this job start. */
  const releasedBy = (rk: string) => {
    const needs = runNodes.get(rk)?.needs ?? [];
    return needs.length ? needs.reduce((a, b) => (finish(b) > finish(a) ? b : a)) : undefined;
  };
  const graphJob = (rk: string | undefined) => (rk ? nodes.get(runNodes.get(rk)!.key) : undefined);
  const labelOf = (rk: string) => {
    const own = instances.get(rk) ?? [];
    return own.length === 1 ? own[0]!.name : shownName(graphJob(rk)!.label);
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
    const key = rkOf.get(j.id);
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
      needs: key ? (runNodes.get(key)?.needs ?? []) : [],
      readyMin: mins(runStart, readyAt),
      createdMin: mins(runStart, ms(j.created_at)),
      startMin: mins(runStart, start),
      endMin: mins(runStart, ms(j.completed_at!)),
      blockedMin: mins(runStart, readyAt),
      hiddenMin: mins(readyAt, queuedAt),
      queueMin: mins(queuedAt, start),
      workMin: mins(start, ms(j.completed_at!)),
      setupMin: setupOf(j),
      labels: j.labels ?? [],
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
  const pathJobs = [...chainBefore(rkOf.get(end.id)), end];
  const spanMin = mins(runStart, ms(end.completed_at!));
  let before = 0;
  const path: Link[] = pathJobs.map((a) => {
    const t = byId.get(a.id)!;
    const link = { name: t.name, key: t.key, blockedMin: t.blockedMin, hiddenMin: t.hiddenMin, queueMin: t.queueMin, workMin: t.workMin, setupMin: t.setupMin, share: spanMin ? (t.endMin - before) / spanMin : 0 };
    before = t.endMin;
    return link;
  });

  // Who holds up whom, and by how much. A need holds its dependent up only past the dependent's other needs: by the
  // last need's finish less the next-latest's, or less the run's start when it's the only one. Up a chain, a job
  // ahead gains a job behind only what every link between them passes on, and never more than its own time.
  const margin = (rk: string) => {
    const needs = runNodes.get(rk)?.needs ?? [];
    const last = releasedBy(rk);
    const others = needs.filter((n) => n !== last).map((n) => finish(n));
    return last ? finish(last) - Math.max(runStart, ...others) : 0;
  };
  const tookMs = (rk: string) => (instances.get(rk)?.length ? finish(rk) - ready(rk) : 0);
  const held = new Map<string, { jobs: number; ms: number }>();
  for (const j of jobs) {
    let passed = Infinity;
    for (let below = j.key, up = below && releasedBy(below), guard = 0; below && up && guard < 200; below = up, up = releasedBy(up), guard++) {
      passed = Math.min(passed, margin(below));
      const credit = Math.min(passed, tookMs(up));
      if (credit <= 0) continue;
      const h = held.get(up) ?? { jobs: 0, ms: 0 };
      held.set(up, { jobs: h.jobs + 1, ms: h.ms + credit });
    }
  }
  const blockers = [...held]
    .map(([key, h]) => ({ key, name: labelOf(key), heldJobs: h.jobs, tookMin: tookMs(key) / 60e3, heldJobMin: h.ms / 60e3 }))
    .sort((a, b) => b.heldJobMin - a.heldJobMin);

  // Setup that waits on nothing can't move earlier; setup in a job on the path that waited on another could overlap it.
  const setupInPathMin = path.filter((l) => l.blockedMin > 0).reduce((a, l) => a + l.setupMin, 0);

  // A job that needs a whole job when it may need only one step of it: the upstream job's last step that makes
  // something ended well before the job did, and the waiting job's steps fetch something. A guess from names.
  const stepWaits: { job: string; waitsOn: string; step: string; earlyMin: number }[] = [];
  for (const [key, node] of runNodes) {
    const down = instances.get(key);
    const upKey = releasedBy(key);
    const up = upKey && lastOf(upKey);
    if (!down?.length || !up || !node.needs.length) continue;
    if (!down.some((d) => (d.steps ?? []).some((s) => CONSUMES.test(s.name) && !/^(set up job|post )/i.test(s.name)))) continue;
    const made = (up.steps ?? []).filter((s) => s.completed_at && PRODUCES.test(s.name) && !SETUP_STEP.test(s.name)).at(-1);
    if (!made) continue;
    const earlyMin = mins(ms(made.completed_at!), ms(up.completed_at!));
    if (earlyMin >= LATE_MIN) stepWaits.push({ job: labelOf(key), waitsOn: up.name, step: made.name, earlyMin });
  }

  // Waits the YAML can't show: a job that got its runner long after its needs were done, when the others got theirs
  // quickly, is likely waiting on something else, such as another workflow or a concurrency group.
  // The jobs inside a workflow in another repo wait on each other in ways this file doesn't show, so they're left out.
  const lateStarts = jobs.filter((j) => j.hiddenMin > LATE_MIN && !graphJob(j.key)?.opaque).map((j) => ({ name: j.name, lateMin: j.hiddenMin }));
  const waitSteps = ran.flatMap((j) =>
    (j.steps ?? [])
      .filter((s) => s.started_at && s.completed_at && WAIT_STEP.test(s.name) && mins(ms(s.started_at), ms(s.completed_at)) >= 1)
      .map((s) => ({ job: j.name, step: s.name, minutes: mins(ms(s.started_at!), ms(s.completed_at!)) })),
  );

  // Today's YAML may not be the YAML a run ran: a PR can add or drop a `needs`. A run whose jobs don't fit the graph
  // is left out of the chain and the hidden waits, rather than read wrong; the reasons say how it didn't fit.
  const SAME_MS = 5e3;
  const AFTER_MS = 20e3;
  const ends = ran.map((j) => ms(j.completed_at!));
  const misfit = new Set<string>();
  if (graph && ran.some((j) => !rkOf.get(j.id))) misfit.add('a job the YAML doesn\'t name, or could name two ways');
  for (const j of ran) {
    const rk = rkOf.get(j.id);
    if (!rk || graphJob(rk)?.opaque) continue;
    const created = ms(j.created_at);
    const yamlReady = ready(rk);
    if (created < yamlReady - SAME_MS) misfit.add('a job GitHub created before a need the YAML names had finished');
    else if (created > yamlReady + LATE_MIN * 60e3 && ends.some((e) => e <= created && created - e <= AFTER_MS))
      misfit.add('a job GitHub created as another finished, a need the YAML lacks');
  }

  return {
    fits: misfit.size === 0,
    leftOutBecause: [...misfit],
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
    unmatched: ran.filter((j) => graph && !rkOf.get(j.id)).map((j) => j.name),
    ambiguous,
    skipped: [...nodes.values()].filter((n) => !n.virtual && ![...instances.keys()].some((r) => r.split('@')[0] === n.key)).map((n) => n.label),
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
 * It's asked only for the sampled runs' workflow files and the local workflows they call. A read that fails, such as
 * a 403, leaves that part of the graph unknown, with the reason; it never stops the report. `repo` is `workflowGraph`'s.
 */
export const jobGraphOf = (read: (path: string) => string | undefined, sampled: SampledRun[], isPrivate = false, repo?: string) => {
  const graphs = new Map<string, Graph | undefined>();
  const failures = new Map<string, string>();
  const graphFor = (path: string) => {
    if (!graphs.has(path)) {
      let text: string | undefined;
      try {
        text = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ? read(path) : undefined;
      } catch (e) {
        failures.set(path, `${path} couldn't be read (${(e as Error).message.replace(/\.$/, '')}), so its jobs are taken as waiting on nothing`);
      }
      graphs.set(path, text === undefined ? undefined : workflowGraph(path, text, read, repo));
    }
    return graphs.get(path);
  };
  const all = sampled.flatMap((s) => {
    const g = runGraph(graphFor(s.path), s.jobs);
    return g ? [{ id: s.id, workflow: s.path, ...g }] : [];
  });
  if (!all.length) return undefined;
  // The runs that fit the default branch's YAML: only they give the chain, the blockers and the hidden waits.
  const runs = all.filter((r) => r.fits);

  const paths = [...new Set(all.map((r) => r.workflow))];
  const graph = graphFor(paths[0]!);
  const shape = graph && {
    jobs: graph.jobs.filter((j) => !j.virtual).length,
    edges: graph.jobs.reduce((a, j) => a + j.needs.length, 0),
    matrixJobs: graph.jobs.filter((j) => j.matrix && !j.uses).length,
    reusableCalls: graph.jobs.filter((j) => j.uses).length,
  };

  // The chain by its graph jobs, so matrix instances that differ by run count as one chain. A list, never a joined
  // string: a job's name can hold any text, so one named "build → test" mustn't read as a chain of two.
  // A caller instance, such as `@test (3/10)`, groups with the others, as a matrix job's instances do.
  const jobOf = (key: string) => key.split('@')[0]!;
  const chainSig = (r: (typeof runs)[number]) => JSON.stringify(r.path.map((l) => (l.key === undefined ? ['name', l.name] : ['job', jobOf(l.key)])));
  const [topChain, chainRuns] = tally(runs.map(chainSig))[0] ?? ['', 0];
  const withChain = runs.filter((r) => chainSig(r) === topChain);
  const chain = (withChain[0]?.path ?? []).map((l, i) => ({
    name: l.name,
    minutes: r1(median(withChain.map((r) => r.path[i]!.share * r.spanMin))),
    share: r2(median(withChain.map((r) => r.path[i]!.share))),
    blockedMin: r1(median(withChain.map((r) => r.path[i]!.blockedMin))),
    hiddenMin: r1(median(withChain.map((r) => r.path[i]!.hiddenMin))),
    queueMin: r1(median(withChain.map((r) => r.path[i]!.queueMin))),
    workMin: r1(median(withChain.map((r) => r.path[i]!.workMin))),
    setupMin: r1(median(withChain.map((r) => r.path[i]!.setupMin))),
  }));

  const blockers = tally(runs.flatMap((r) => (r.topBlocker && r.topBlocker.heldJobs > 0 ? [jobOf(r.topBlocker.key)] : []))).slice(0, 3).map(([key, n]) => {
    const bs = runs.map((r) => r.topBlocker).filter((b) => b && jobOf(b.key) === key);
    return {
      name: bs[0]!.name,
      runs: n,
      heldJobs: Math.round(median(bs.map((b) => b!.heldJobs))),
      jobs: Math.round(median(runs.filter((r) => r.topBlocker && jobOf(r.topBlocker.key) === key).map((r) => r.jobs.length))),
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
    runsSampled: all.length,
    runsUsed: runs.length,
    runsLeftOut: all.length - runs.length,
    leftOutBecause: tally(all.flatMap((r) => r.leftOutBecause)).map(([why, n]) => ({ why, runs: n })),
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
    unmatched: tally(all.flatMap((r) => r.unmatched)).slice(0, 5).map(([name]) => name),
    ambiguous: tally(all.flatMap((r) => r.ambiguous)).slice(0, 5).map(([name]) => name),
    skippedP50: Math.round(median(runs.map((r) => r.skipped.length))),
    unknown: [...new Set(paths.flatMap((p) => graphFor(p)?.unknown ?? [failures.get(p) ?? `${p} couldn't be found, so its jobs are taken as waiting on nothing`]))],
    // Each run's jobs to scale, for a replay: minutes from the run's start.
    perRun: all.map((r) => ({
      id: r.id,
      fits: r.fits,
      leftOutBecause: r.leftOutBecause,
      spanMin: r1(r.spanMin),
      path: r.path.map((l) => l.name),
      topBlocker: r.topBlocker?.name ?? null,
      // Blocked, then hidden wait (created late), then queued (waiting on a runner), then work: they add up to endMin.
      jobs: r.jobs.map((j) => ({
        name: j.name,
        needs: j.needs,
        readyMin: r1(j.readyMin),
        createdMin: r1(j.createdMin),
        startMin: r1(j.startMin),
        endMin: r1(j.endMin),
        blockedMin: r1(j.blockedMin),
        hiddenMin: r1(j.hiddenMin),
        queueMin: r1(j.queueMin),
        workMin: r1(j.workMin),
        setupMin: r1(j.setupMin),
        runner: runnerOf(j.labels),
        vcpus: vcpusOf(j.labels, isPrivate),
      })),
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
  return b
    ? `"${b.name}" holds up ${b.heldJobs} of ${b.jobs} jobs, ${m(b.heldJobMin)} job-min past their other needs; it takes ${m(b.tookMin)} min (${b.runs} of ${g.runsUsed} runs)`
    : 'none: no job waits on another';
};

const leftOut = (g: JobGraph) => (g.runsLeftOut ? `; ${g.runsLeftOut} of ${g.runsSampled} runs left out, their jobs not fitting today's YAML` : '');

/** The two `<ci-report>` lines. */
export const promptLines = (g: JobGraph) => [
  `Chain that sets the wait: ${g.chain.length ? `${chainText(g)}; ${g.chainRuns} of ${g.runsUsed} runs` : 'unknown'}${leftOut(g)}; on it p50 blocked ${m(g.blockedMinP50)}, queue ${m(g.queueMinP50)}, setup after a wait ${m(g.setupInPathMinP50)} min`,
  `Top blocker: ${blockerText(g)}`,
];

/** The text report's "Job graph" block. */
export const graphBlock = (g: JobGraph) => {
  const shape = g.jobs === undefined ? '' : `, ${g.jobs} jobs, ${g.edges} needs edges, ${g.matrixJobs} matrix, ${g.reusableCalls} reusable workflow call${g.reusableCalls === 1 ? '' : 's'}`;
  const lines = [
    `Job graph (${g.workflows.join(', ')}${shape}; ${g.runsSampled} runs):`,
    g.chain.length ? `  Sets the wait       ${chainText(g)} (${g.chainRuns} of ${g.runsUsed} runs)` : `  Sets the wait       unknown: no sampled run fits the default branch's YAML`,
    ...(g.runsLeftOut ? [`  Left out            ${g.runsLeftOut} of ${g.runsSampled} runs, whose jobs don't fit today's YAML: ${g.leftOutBecause.map((w) => `${w.why} (${runs(w.runs)})`).join('; ')}`] : []),
    `  Ends the gate       ${g.gateEnd.map((e) => `"${e.name}" ×${e.runs}`).join(', ')}`,
    `  Critical path p50   ${g.pathJobsP50} job${g.pathJobsP50 === 1 ? '' : 's'}, ${m(g.pathMinP50)} min: work ${m(g.workMinP50)}, queue ${m(g.queueMinP50)}; the last job blocked ${m(g.blockedMinP50)}`,
    `  Top blocker         ${blockerText(g)}`,
    ...g.topBlockers.slice(1).map((b) => `                      then "${b.name}", ${b.heldJobs} jobs, ${m(b.heldJobMin)} job-min (${runs(b.runs)})`),
    `  Setup in the path   ${m(g.setupInPathMinP50)} min p50 in jobs that first waited on others, which overlapping with upstream work could hide`,
    ...g.stepWaits.slice(0, 2).map((w) => `  One step, a guess   "${w.job}" waits on all of "${w.waitsOn}", whose "${w.step}" ended ${m(w.earlyMin)} min before it did (${runs(w.runs)})`),
    g.hidden.runs
      ? `  Waits not in YAML   ${g.hidden.runs} of ${g.runsUsed} runs had a job GitHub queued over ${LATE_MIN} minutes after its needs finished (${g.hidden.jobs.map((j) => `"${j.name}"`).join(', ')}, p50 ${m(g.hidden.lateMinP50)} min): it waited on something the YAML doesn't name, such as a concurrency group or an environment`
      : `  Waits not in YAML   none seen: GitHub queued every job as soon as its needs finished`,
    ...(g.hidden.waitSteps.length ? [`  Waiting steps       ${g.hidden.waitSteps.map((w) => `${w.step} (${runs(w.runs)})`).join(', ')}`] : []),
    ...(g.unmatched.length ? [`  Not in the YAML     ${g.unmatched.map((n) => `"${n}"`).join(', ')}: taken as waiting on nothing`] : []),
    ...(g.ambiguous.length ? [`  Ambiguous names     ${g.ambiguous.map((n) => `"${n}"`).join(', ')}: two jobs in the YAML could be each, so neither is assumed`] : []),
    ...g.unknown.map((u) => `  Unknown because: ${u}.`),
    `  Other workflows, \`workflow_run\` triggers and polling actions can hold a job up without \`needs\`; the YAML of one workflow doesn't show them.`,
  ];
  return lines.join('\n');
};

/** Setup minutes on the critical path, in jobs that first waited on others, when they're a minute and a tenth of the path or more. */
export const setupInPath = (g: JobGraph) => {
  const setup = g.setupInPathMinP50 ?? 0;
  return setup >= 1 && setup >= 0.1 * (g.pathMinP50 ?? Infinity) ? setup : undefined;
};

/** The top blocker when most jobs wait on it, in most runs, and each of them a minute or more past its other needs. */
export const heavyBlocker = (g: JobGraph) => {
  const b = g.topBlockers[0];
  return b && b.runs * 2 >= g.runsUsed && b.heldJobs * 2 >= b.jobs && (b.heldJobMin ?? 0) >= b.heldJobs ? b : undefined;
};

/** Fixes the graph shows, in `fixesOf`'s shape. */
export const graphFixes = (g: JobGraph | undefined) => {
  if (!g) return [];
  const fixes: { text: string; page: string; weight: number }[] = [];
  const setup = setupInPath(g);
  if (setup !== undefined)
    fixes.push({
      text: `Setup on the critical path: ${m(setup)} min of setup in jobs that first wait on others; start it while they wait, and wait only for the step you need`,
      page: '07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores',
      weight: 6,
    });
  const b = heavyBlocker(g);
  if (b)
    fixes.push({
      text: `A blocker most jobs wait on: "${b.name}" holds up ${b.heldJobs} of ${b.jobs} jobs, ${m(b.heldJobMin)} job-min past their other needs; shorten it, or let them start setup and wait only for what they need`,
      page: '21-optimize-all-of-your-graphs.md#ci-jobs',
      weight: 6,
    });
  return fixes;
};
