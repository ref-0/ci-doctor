/**
 * ci-jobs.ts: which jobs a ready pull request can run, and on which runners, read from the
 * workflows' YAML as written, expressions included.
 *
 * Runs: inside `ci-budgets.test.ts` (any CI job that runs your tests) and inside `ci-health.ts`
 * (the daily health workflow), which match a run's jobs to their budgets by name.
 * Configure: nothing here. `ci-budgets.ts` holds the budgets and the runner labels.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * A pull request runs each workflow with a `pull_request` trigger, and each workflow those call
 * with `uses: ./.github/workflows/<file>`. A `pull_request_target` trigger, such as a label that
 * starts a release, doesn't count: it starts something else, not a check.
 *
 * An expression is evaluated over every value it could take on a ready pull request: the event's
 * name and the draft flag are known, `inputs` are empty, a called workflow's inputs are what its
 * caller passes, a job's outputs are the literals its step writes, and anything else, such as a
 * matrix a plan job chooses, could be any value. A job can run when its `if:` could be truthy, and
 * its runners are every value its `runs-on:` could take for each leg of its matrix. A `runs-on:`
 * that could be a value this can't name is reported, not guessed.
 *
 * Only the YAML workflows usually use is read: block mappings and sequences, flow sequences of
 * scalars, quoted and plain scalars, and `|` and `>` blocks. Anything else throws, so a workflow
 * this can't read fails the budget test instead of passing it quietly. No dependencies: Node 24.
 */
import { readdirSync, readFileSync } from 'node:fs';

/** A YAML node: every scalar is its text, as the workflows' values are read. */
export type Yaml =
  | { readonly kind: 'scalar'; readonly text: string }
  | { readonly kind: 'list'; readonly items: ReadonlyArray<Yaml> }
  | { readonly kind: 'map'; readonly entries: ReadonlyMap<string, Yaml> };

interface Line {
  readonly indent: number;
  readonly text: string;
}

/** A node, and the index of the line after it. */
interface Parsed {
  readonly value: Yaml;
  readonly next: number;
}

const scalar = (text: string): Yaml => ({ kind: 'scalar', text });

/** A plain or quoted scalar, or a flow sequence of them, with any comment after it cut off. */
const scalarOf = (text: string): Yaml => {
  const trimmed = text.trim();
  const single = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(trimmed);
  if (single !== null) return scalar(single[1]!.replaceAll("''", "'"));

  const double = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(trimmed);
  if (double !== null) return scalar(String(JSON.parse(double[1]!)));

  if (/^["']/.test(trimmed)) throw new Error(`an unclosed quote: ${trimmed}`);

  const flow = /^\[(.*)\]\s*(?:#.*)?$/.exec(trimmed)?.[1];
  if (flow !== undefined) {
    return { kind: 'list', items: flow.trim() === '' ? [] : flow.split(',').map(scalarOf) };
  }

  if (/^\{\s*\}\s*(?:#.*)?$/.test(trimmed)) return { kind: 'map', entries: new Map() };

  if (/^[[{]/.test(trimmed)) throw new Error(`a flow collection this can't read: ${trimmed}`);

  return scalar(trimmed.replace(/\s+#.*$/, ''));
};

const keyLine = /^([A-Za-z0-9_][\w.-]*|'[^']+'|"[^"]+"):(?:\s+(.*))?$/;

/** The next line at or after `at` with something on it but a comment, or undefined. */
const nextLine = (lines: ReadonlyArray<Line>, at: number) => {
  for (let index = at; index < lines.length; index++) {
    const { text } = lines[index]!;
    if (text !== '' && !text.startsWith('#')) return index;
  }

  return undefined;
};

/** A `|` or `>` block's text, from the lines after `at` indented past `indent`. */
const blockOf = (lines: ReadonlyArray<Line>, at: number, indent: number, folded: boolean): Parsed => {
  const body: Array<string> = [];
  let index = at + 1;

  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.text !== '' && line.indent <= indent) break;

    body.push(line.text);
  }

  return { value: scalar(body.join(folded ? ' ' : '\n').trim()), next: index };
};

/** The value after a key or a sequence's dash on the line `at`, whose own indent is `indent`. */
const valueAfter = (lines: Array<Line>, at: number, indent: number, rest: string): Parsed => {
  const block = /^([|>])[-+]?$/.exec(rest);
  if (block !== null) return blockOf(lines, at, indent, block[1] === '>');

  if (rest !== '' && !rest.startsWith('#')) return { value: scalarOf(rest), next: at + 1 };

  const child = nextLine(lines, at + 1);
  if (child === undefined) return { value: scalar(''), next: lines.length };

  const { indent: childIndent, text } = lines[child]!;
  if (childIndent > indent || (childIndent === indent && text.startsWith('- '))) {
    return nodeAt(lines, child, childIndent);
  }

  return { value: scalar(''), next: at + 1 };
};

/** Fails when the line `index` is indented past the keys or items of the node at `indent`. */
const holdIndent = (lines: ReadonlyArray<Line>, index: number | undefined, indent: number) => {
  if (index !== undefined && lines[index]!.indent > indent) {
    throw new Error(`line ${String(index + 1)} is indented past its node's`);
  }
};

const sequenceAt = (lines: Array<Line>, at: number, indent: number): Parsed => {
  const items: Array<Yaml> = [];
  let index: number | undefined = at;

  while (index !== undefined && lines[index]!.indent === indent && lines[index]!.text.startsWith('-')) {
    const rest = lines[index]!.text.slice(1).trim();
    let item: Parsed;

    if (keyLine.test(rest)) {
      // A mapping that starts on the dash's line: read it as if its first key began the line.
      lines[index] = { indent: indent + 2, text: rest };
      item = nodeAt(lines, index, indent + 2);
    } else {
      item = valueAfter(lines, index, indent, rest);
    }

    items.push(item.value);
    index = nextLine(lines, item.next);
    holdIndent(lines, index, indent);
  }

  return { value: { kind: 'list', items }, next: index ?? lines.length };
};

const mappingAt = (lines: Array<Line>, at: number, indent: number): Parsed => {
  const entries = new Map<string, Yaml>();
  let index: number | undefined = at;

  while (index !== undefined && lines[index]!.indent === indent) {
    const { text } = lines[index]!;
    const key = keyLine.exec(text);
    if (key === null) throw new Error(`line ${String(index + 1)} isn't a key this can read: ${text}`);

    const entry = valueAfter(lines, index, indent, key[2]?.trim() ?? '');
    entries.set(key[1]!.replace(/^(['"])(.*)\1$/, '$2'), entry.value);
    index = nextLine(lines, entry.next);
    holdIndent(lines, index, indent);
  }

  return { value: { kind: 'map', entries }, next: index ?? lines.length };
};

/** The mapping or sequence whose first line is `at`, indented `indent`. */
const nodeAt = (lines: Array<Line>, at: number, indent: number): Parsed =>
  lines[at]!.text.startsWith('-') ? sequenceAt(lines, at, indent) : mappingAt(lines, at, indent);

/** A workflow's YAML, as far as workflows usually use YAML. */
export const parseYaml = (text: string): Yaml => {
  const lines = text.split('\n').map((raw) => {
    const content = raw.trimStart();

    return { indent: raw.length - content.length, text: content.trimEnd() };
  });
  const first = nextLine(lines, 0);
  if (first === undefined) return { kind: 'map', entries: new Map() };

  return nodeAt(lines, first, lines[first]!.indent).value;
};

/** YAML's data as plain values. */
type Plain = string | ReadonlyArray<Plain> | { readonly [key: string]: Plain };

const plain = (node: Yaml): Plain => {
  switch (node.kind) {
    case 'scalar':
      return node.text;
    case 'list':
      return node.items.map(plain);
    case 'map':
      return Object.fromEntries([...node.entries].map(([key, value]) => [key, plain(value)]));
  }
};

type Texts = Readonly<Record<string, string>>;

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Texts;
  readonly run?: string;
}

/** A matrix: one expression, or keys each a list, an expression, or `include`'s legs. */
type Matrix = string | Readonly<Record<string, string | ReadonlyArray<string> | ReadonlyArray<Texts>>>;

export interface JobSpec {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | ReadonlyArray<string>;
  readonly 'runs-on'?: string;
  readonly uses?: string;
  readonly with?: Texts;
  readonly strategy?: { readonly matrix?: Matrix };
  readonly outputs?: Texts;
  readonly steps?: ReadonlyArray<Step>;
}

interface Input {
  readonly type?: string;
  readonly default?: string;
}

/** What this reads of a workflow: its triggers, a called workflow's inputs, and its jobs. */
export interface Workflow {
  readonly on: Readonly<Record<string, Plain>>;
  readonly jobs: Readonly<Record<string, JobSpec>>;
}

const isText = (value: unknown): value is string => typeof value === 'string';

const isTexts = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every(isText);

const isRecord = (value: unknown): value is Readonly<Record<string, Plain>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the shapes this reads, field by field, and throws on one it can't use. */
const checkJob = (id: string, job: unknown): JobSpec => {
  if (!isRecord(job)) throw new Error(`the job ${id} isn't a mapping`);

  for (const key of ['name', 'if', 'runs-on', 'uses'] as const) {
    if (job[key] !== undefined && !isText(job[key])) throw new Error(`the job ${id}'s ${key} isn't text`);
  }

  if (job['needs'] !== undefined && !isText(job['needs']) && !isTexts(job['needs'])) {
    throw new Error(`the job ${id}'s needs isn't a name or a list of names`);
  }

  return job as JobSpec;
};

/** A workflow's text, decoded as far as this reads it. */
export const workflowOf = (text: string): Workflow => {
  const data = plain(parseYaml(text));
  if (!isRecord(data)) throw new Error("a workflow that isn't a mapping");

  // `on: push` and `on: [push, pull_request]` are shorthand for a mapping of triggers.
  const on = data['on'];
  const triggers = isText(on)
    ? { [on]: '' }
    : isTexts(on)
      ? Object.fromEntries(on.map((name) => [name, '']))
      : isRecord(on)
        ? on
        : undefined;
  if (triggers === undefined) throw new Error('a workflow with no `on:` this can read');

  const jobs = data['jobs'];
  if (!isRecord(jobs)) throw new Error('a workflow with no `jobs:`');

  return {
    on: triggers,
    jobs: Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, checkJob(id, job)])),
  };
};

/** A value of GitHub's expressions, or `anything`, a value this can't say. */
export type Value =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'boolean'; readonly boolean: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'list'; readonly items: ReadonlyArray<Value> }
  | { readonly kind: 'anything' };

/** Every value an expression could take. */
type Values = ReadonlyArray<Value>;

const text = (value: string): Value => ({ kind: 'text', text: value });

const bool = (value: boolean): Value => ({ kind: 'boolean', boolean: value });

const anything: Value = { kind: 'anything' };

const none: Value = { kind: 'null' };

const both: Values = [bool(true), bool(false)];

const unique = (values: Values): Values => [
  ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
];

const truthy = (value: Value) => {
  switch (value.kind) {
    case 'text':
      return value.text !== '';
    case 'number':
      return value.number !== 0 && !Number.isNaN(value.number);
    case 'boolean':
      return value.boolean;
    case 'null':
      return false;
    case 'list':
    case 'anything':
      return true;
  }
};

/** A value as GitHub's `==` compares it with one of another type. */
const numberOf = (value: Value) => {
  switch (value.kind) {
    case 'text':
      return Number(value.text);
    case 'number':
      return value.number;
    case 'boolean':
      return value.boolean ? 1 : 0;
    case 'null':
      return 0;
    case 'list':
    case 'anything':
      return Number.NaN;
  }
};

/** A value as a string, as GitHub writes one into text. */
const stringOf = (value: Value) => {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'number':
      return String(value.number);
    case 'boolean':
      return value.boolean ? 'true' : 'false';
    case 'list':
      return 'Array';
    case 'null':
    case 'anything':
      return '';
  }
};

/** GitHub's `==`: strings case-insensitively, other types as numbers. */
const equal = (a: Value, b: Value) =>
  a.kind === 'text' && b.kind === 'text'
    ? a.text.toLowerCase() === b.text.toLowerCase()
    : numberOf(a) === numberOf(b);

const compare = (op: string, a: Value, b: Value) => {
  switch (op) {
    case '==':
      return equal(a, b);
    case '!=':
      return !equal(a, b);
    case '<':
      return numberOf(a) < numberOf(b);
    case '>':
      return numberOf(a) > numberOf(b);
    case '<=':
      return numberOf(a) <= numberOf(b);
    default:
      return numberOf(a) >= numberOf(b);
  }
};

type Token =
  | { readonly kind: 'literal'; readonly value: Value }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'op'; readonly op: string };

const tokenPattern =
  /\s*(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)\b|(&&|\|\||==|!=|<=|>=|[!<>(),])|([A-Za-z_][\w-]*(?:\.[\w-]+|\.\*)*))/y;

/** The token a match of `tokenPattern` read. */
const tokenOf = ([, quoted, number, op, name]: RegExpExecArray): Token => {
  if (quoted !== undefined) return { kind: 'literal', value: text(quoted.replaceAll("''", "'")) };

  if (number !== undefined) return { kind: 'literal', value: { kind: 'number', number: Number(number) } };

  if (op !== undefined) return { kind: 'op', op };

  if (name === 'true' || name === 'false') return { kind: 'literal', value: bool(name === 'true') };

  if (name === 'null') return { kind: 'literal', value: none };

  return { kind: 'name', name: name ?? '' };
};

const tokensOf = (source: string) => {
  const tokens: Array<Token> = [];

  for (let at = 0; source.slice(at).trim() !== ''; at = tokenPattern.lastIndex) {
    tokenPattern.lastIndex = at;
    const match = tokenPattern.exec(source);
    if (match === null) throw new Error(`an expression this can't read: ${source}`);

    tokens.push(tokenOf(match));
  }

  return tokens;
};

/** What a context's path, such as `needs.plan.outputs.shards`, could be. */
export type Context = (path: string) => Values;

/** `fromJSON`, for the lists of strings workflows usually build matrices from. */
const fromJson = (value: Value): Value => {
  if (value.kind !== 'text') return anything;

  try {
    const parsed: unknown = JSON.parse(value.text);

    return isTexts(parsed) ? { kind: 'list', items: parsed.map(text) } : anything;
  } catch {
    return anything;
  }
};

/** Whether `haystack` holds `needle`, as `contains`, `startsWith` or `endsWith` reads it. */
const holds = (name: string, haystack: Value, needle: Value) => {
  if (haystack.kind === 'list') return haystack.items.some((item) => equal(item, needle));

  const whole = stringOf(haystack).toLowerCase();
  const part = stringOf(needle).toLowerCase();
  if (name === 'contains') return whole.includes(part);

  if (name === 'startsWith') return whole.startsWith(part);

  return whole.endsWith(part);
};

const call = (name: string, args: ReadonlyArray<Values>): Values => {
  switch (name) {
    case 'always':
      return [bool(true)];
    // The question is whether a job can run on a pull request, so on one that isn't cancelled.
    case 'cancelled':
      return [bool(false)];
    case 'success':
    case 'failure':
      return both;
    case 'fromJSON':
      return unique((args[0] ?? []).map(fromJson));
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const [haystacks = [], needles = []] = args;
      if ([...haystacks, ...needles].some((value) => value.kind === 'anything')) return both;

      return unique(haystacks.flatMap((haystack) => needles.map((needle) => bool(holds(name, haystack, needle)))));
    }

    default:
      return [anything];
  }
};

/** Every value `source`, an expression without its `${{ }}`, could take in `context`. */
export const evaluate = (source: string, context: Context): Values => {
  const tokens = tokensOf(source);
  let at = 0;

  const isOp = (op: string) => {
    const token = tokens[at];

    return token?.kind === 'op' && token.op === op;
  };

  const take = (op: string) => {
    if (!isOp(op)) throw new Error(`expected ${op} in ${source}`);

    at++;
  };

  const primary = (): Values => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`an expression ends early: ${source}`);

    switch (token.kind) {
      case 'literal':
        return [token.value];
      case 'op': {
        if (token.op === '!') {
          return unique(primary().flatMap((value) => (value.kind === 'anything' ? both : [bool(!truthy(value))])));
        }

        if (token.op !== '(') throw new Error(`unexpected ${token.op} in ${source}`);

        const inner = or();
        take(')');

        return inner;
      }

      case 'name': {
        if (!isOp('(')) return context(token.name);

        take('(');
        const args: Array<Values> = [];

        while (!isOp(')')) {
          args.push(or());

          if (isOp(',')) take(',');
        }

        take(')');

        return call(token.name, args);
      }
    }
  };

  const comparison = (): Values => {
    const left = primary();
    const token = tokens[at];
    if (token?.kind !== 'op' || !['==', '!=', '<', '>', '<=', '>='].includes(token.op)) return left;

    at++;
    const right = primary();

    return unique(
      left.flatMap((a) =>
        right.flatMap((b) => (a.kind === 'anything' || b.kind === 'anything' ? both : [bool(compare(token.op, a, b))])),
      ),
    );
  };

  // `a && b` is a when a is falsy and b otherwise; `a || b` is a when a is truthy and b otherwise.
  const chain = (op: '&&' | '||', next: () => Values) => (): Values => {
    let values = next();

    while (isOp(op)) {
      at++;
      const right = next();
      values = unique(
        values.flatMap((value) => {
          if (value.kind === 'anything') return [anything, ...right];

          return truthy(value) === (op === '&&') ? right : [value];
        }),
      );
    }

    return values;
  };

  const and = chain('&&', comparison);
  const or = chain('||', and);

  const values = or();
  if (at !== tokens.length) throw new Error(`more after an expression's end: ${source}`);

  return values;
};

/** Every value `source` could be, with each `${{ }}` in it evaluated. */
export const interpolate = (source: string, context: Context): Values => {
  const parts = source.split(/\$\{\{(.*?)\}\}/s);
  if (parts.length === 1) return [text(source)];

  // A value that's one expression alone keeps its type, as GitHub's does.
  if (parts.length === 3 && parts[0]!.trim() === '' && parts[2]!.trim() === '') {
    return evaluate(parts[1]!, context);
  }

  let strings: Values = [text('')];

  for (const [index, part] of parts.entries()) {
    const values = index % 2 === 0 ? [text(part)] : evaluate(part, context);
    strings = unique(
      strings.flatMap((prefix) =>
        values.map((value) =>
          prefix.kind === 'anything' || value.kind === 'anything'
            ? anything
            : text(`${stringOf(prefix)}${stringOf(value)}`),
        ),
      ),
    );
  }

  return strings;
};

/** A job a pull request's run could run, as its workflow says. */
export interface PullRequestJob {
  /** The workflow's file name, such as `ci.yml`. */
  readonly workflow: string;
  /** The job's key under `jobs:`. */
  readonly id: string;
  /**
   * Each name the job could show as on a run's page: its `name:` with each expression as a
   * pattern, after its caller's name for a called workflow's job.
   */
  readonly names: ReadonlyArray<RegExp>;
  /** Each runner a leg could take that this can name. */
  readonly runners: ReadonlyArray<string>;
  /** Whether a leg could take a runner this can't name. */
  readonly unreadable: boolean;
}

/** A workflow's text, by its file name under `.github/workflows/`. */
export type Workflows = (file: string) => string;

/** The workflows to read, and each one's file name. */
export interface WorkflowFiles {
  readonly read: Workflows;
  readonly files: ReadonlyArray<string>;
}

/** The workflows in `directory`, a checkout's `.github/workflows/`. */
export const workflowsIn = (directory: URL): WorkflowFiles => ({
  read: (file) => readFileSync(new URL(file, directory), 'utf8'),
  files: readdirSync(directory).filter((file) => /\.ya?ml$/.test(file)),
});

/** A pattern for a name with expressions in it: each expression matches any text. */
const namePattern = (name: string) =>
  name
    .split(/\$\{\{.*?\}\}/s)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+?');

/** One leg of a matrix: each key's values, and whether any other key could be anything. */
interface Leg {
  readonly keys: Map<string, Values>;
  readonly open: boolean;
}

const noLeg: Leg = { keys: new Map(), open: false };

/** Each value a matrix key's list or expression could give a leg. */
const keyValues = (value: string | ReadonlyArray<string>, context: Context) =>
  isText(value)
    ? interpolate(value, context).flatMap((list): ReadonlyArray<Values> =>
        list.kind === 'list' ? list.items.map((item) => [item]) : [[anything]],
      )
    : value.map((item): Values => [text(item)]);

/** Whether `leg` could hold each key `added` names with one of its values. */
const matches = (leg: Leg, added: ReadonlyMap<string, Values>) =>
  [...added].every(([key, values]) => {
    const own = leg.keys.get(key);

    return (
      own === undefined ||
      own.some((value) => value.kind === 'anything' || values.some((other) => equal(value, other)))
    );
  });

/** Each leg of a job's matrix. A job without one has one leg of no keys. */
const legsOf = (strategy: JobSpec['strategy'], context: Context): ReadonlyArray<Leg> => {
  const spec = strategy?.matrix;
  if (spec === undefined) return [noLeg];

  if (isText(spec)) return [{ keys: new Map(), open: true }];

  let legs: Array<Leg> = [{ keys: new Map(), open: false }];
  const include: Array<Texts> = [];

  for (const [key, value] of Object.entries(spec)) {
    if (key === 'exclude') continue;

    if (key === 'include') {
      if (isText(value)) legs.push({ keys: new Map(), open: true });
      else for (const each of value) if (isRecord(each)) include.push(each as Texts);
      continue;
    }

    if (!isText(value) && !isTexts(value)) throw new Error(`a matrix key ${key} this can't read`);

    const lists = keyValues(value, context);
    legs = legs.flatMap((leg) => lists.map((values) => ({ ...leg, keys: new Map([...leg.keys, [key, values]]) })));
  }

  // Each `include` adds its keys to every leg whose keys it shares match, or is a leg of its own.
  for (const entry of include) {
    const added = new Map(Object.entries(entry).map(([key, value]) => [key, interpolate(value, context)]));
    const matching = legs.filter((leg) => matches(leg, added));
    if (matching.length === 0) legs.push({ keys: added, open: false });

    for (const leg of matching) {
      for (const [key, values] of added) if (!leg.keys.has(key)) leg.keys.set(key, values);
    }
  }

  return legs;
};

/**
 * What a step's run writes to `$GITHUB_OUTPUT` as `name`: each literal it writes, and `anything`
 * when it writes one this can't read, such as `name=$var`, or none.
 */
const stepOutput = (run: string, name: string): Values => {
  const written = [...run.matchAll(new RegExp(`(?<![\\w-])${name}=(\\S*)`, 'g'))].map(([, value]) => {
    const literal = /^[A-Za-z0-9][\w.-]*/.exec(value ?? '')?.[0];

    return literal === undefined ? anything : text(literal);
  });

  return written.length === 0 ? [anything] : unique(written);
};

interface Call {
  /** The caller's name for the called workflow's jobs, before ` / `. */
  readonly prefix: string;
  /** The called workflow's inputs, as its caller passes them. */
  readonly inputs: ReadonlyMap<string, Values>;
}

/** The jobs of `file` a pull request's run could run, with the facts its run gives them. */
const jobsOf = (read: Workflows, file: string, caller: Call | undefined): ReadonlyArray<PullRequestJob> => {
  const { on, jobs } = workflowOf(read(file));
  const trigger = on['workflow_call'];
  const inputs = isRecord(trigger) ? trigger['inputs'] : undefined;
  const declared = (isRecord(inputs) ? inputs : {}) as Readonly<Record<string, Input>>;

  // A pull request's run has no inputs of its own. A called workflow's are what its caller
  // passes, or their defaults, a boolean input's as booleans.
  const input = (name: string): Values => {
    if (caller === undefined) return [none];

    const spec = declared[name];
    const fallback = spec?.default === undefined ? none : text(spec.default);
    const values = caller.inputs.get(name) ?? [fallback];

    return values.map((value) =>
      spec?.type === 'boolean' && value.kind === 'text' && ['true', 'false'].includes(value.text)
        ? bool(value.text === 'true')
        : value,
    );
  };

  // A job's outputs are strings, whatever their expression's type.
  const known = new Map<string, Values>();
  const output = (job: string, name: string): Values => {
    const key = `${job}.${name}`;
    const held = known.get(key);
    if (held !== undefined) return held;

    known.set(key, [anything]);
    const spec = jobs[job];
    const written = spec?.outputs?.[name];
    const values =
      written === undefined
        ? [anything]
        : interpolate(written, (path) => {
            const step = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(path);
            const run = spec?.steps?.find((each) => each.id === step?.[1])?.run;

            return step === null || run === undefined ? [anything] : stepOutput(run, step[2]!);
          });
    const strings = unique(values.map((value) => (value.kind === 'anything' ? value : text(stringOf(value)))));
    known.set(key, strings);

    return strings;
  };

  // A called workflow's `github` is its caller's.
  const contextFor =
    (leg: Leg): Context =>
    (path) => {
      switch (path) {
        case 'github.event_name':
          return [text('pull_request')];
        case 'github.event.pull_request.draft':
          return [bool(false)];
        case 'github.ref':
          return [text('refs/pull/1/merge')];
        case 'github.ref_name':
          return [text('1/merge')];
      }

      const inputName = /^inputs\.([\w-]+)$/.exec(path)?.[1];
      if (inputName !== undefined) return input(inputName);

      const needed = /^needs\.([\w-]+)\.outputs\.([\w-]+)$/.exec(path);
      if (needed !== null) return output(needed[1]!, needed[2]!);

      const key = /^matrix\.([\w-]+)$/.exec(path)?.[1];
      if (key !== undefined) return leg.keys.get(key) ?? [leg.open ? anything : text('')];

      return [anything];
    };

  const context = contextFor(noLeg);

  const runs = new Map<string, boolean>();
  const canRun = (id: string): boolean => {
    const held = runs.get(id);
    if (held !== undefined) return held;

    runs.set(id, false);
    const spec = jobs[id];
    if (spec === undefined) throw new Error(`${file} needs a job ${id} it doesn't have`);

    const written = spec.if ?? 'success()';
    const condition = /^\s*\$\{\{(.*)\}\}\s*$/s.exec(written)?.[1] ?? written;
    // Without a status function, a job runs only when every job it needs passed.
    const status = /\b(?:always|success|failure|cancelled)\(\)/.test(condition);
    const needs = spec.needs === undefined ? [] : isText(spec.needs) ? [spec.needs] : spec.needs;
    const can =
      (status || needs.every(canRun)) &&
      evaluate(condition, context).some((value) => value.kind === 'anything' || truthy(value));
    runs.set(id, can);

    return can;
  };

  return Object.entries(jobs).flatMap(([id, spec]): ReadonlyArray<PullRequestJob> => {
    if (!canRun(id)) return [];

    const name = spec.name ?? id;
    const shown = caller === undefined ? namePattern(name) : `${namePattern(caller.prefix)} / ${namePattern(name)}`;

    if (spec.uses !== undefined) {
      const called = /^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/.exec(spec.uses)?.[1];
      if (called === undefined) throw new Error(`${file}'s job ${id} calls ${spec.uses}, outside this repo`);

      const passed = new Map(Object.entries(spec.with ?? {}).map(([key, value]) => [key, interpolate(String(value), context)]));

      return jobsOf(read, called, { prefix: name, inputs: passed });
    }

    const runsOn = spec['runs-on'];
    if (runsOn === undefined) throw new Error(`${file}'s job ${id} has no runs-on`);

    const runners = unique(legsOf(spec.strategy, context).flatMap((leg) => interpolate(runsOn, contextFor(leg))));

    return [
      {
        workflow: file,
        id,
        names: [new RegExp(`^${shown}$`)],
        runners: runners.flatMap((runner) => (runner.kind === 'text' ? [runner.text] : [])),
        unreadable: runners.some((runner) => runner.kind !== 'text'),
      },
    ];
  });
};

/** Whether a workflow's `on:` has a `pull_request` trigger. */
export const triggersOnPullRequests = (source: string) => 'pull_request' in workflowOf(source).on;

/**
 * Each job a ready pull request's runs could run, in each of `files` with a `pull_request` trigger
 * and the workflows they call, one for each job however many callers it has, with every caller's
 * names and runners.
 */
export const pullRequestJobs = ({ read, files }: WorkflowFiles): ReadonlyArray<PullRequestJob> => {
  const merged = new Map<string, PullRequestJob>();

  for (const file of files.filter((each) => triggersOnPullRequests(read(each)))) {
    for (const job of jobsOf(read, file, undefined)) {
      const key = `${job.workflow}#${job.id}`;
      const held = merged.get(key);
      merged.set(
        key,
        held === undefined
          ? job
          : {
              ...held,
              names: [...held.names, ...job.names],
              runners: [...new Set([...held.runners, ...job.runners])],
              unreadable: held.unreadable || job.unreadable,
            },
      );
    }
  }

  return [...merged.values()];
};

/** A runner's vCPUs and the rest of its label (its OS and architecture). */
export interface Runner {
  readonly vcpu: number;
  readonly platform: string;
}

/**
 * A runner label's vCPUs and platform: Blacksmith's `blacksmith-<n>vcpu-<platform>`, or one of
 * `others`, such as GitHub's hosted labels, which name no size. Undefined for a label this can't size.
 */
export const runnerOf = (label: string, others: Readonly<Record<string, Runner>> = {}): Runner | undefined => {
  const match = /^blacksmith-(\d+)vcpu-(.+)$/.exec(label);
  if (match !== null) return { vcpu: Number(match[1]), platform: match[2]! };

  return others[label];
};
