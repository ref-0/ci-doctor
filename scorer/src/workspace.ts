// Which manifests are their workspace's packages, as the workspace declares them: npm, Yarn and Bun's `workspaces`,
// pnpm-workspace.yaml's `packages`, Cargo's `members` and `exclude`, go.work's `use` and uv's `[tool.uv.workspace]`.
// Paths are the repo's, with forward slashes; a directory is '' at the root.

/** A workspace's members and exclusions, as globs from its own directory. */
export interface Workspace {
  members: string[];
  exclude: string[];
}

/** A workspace declared in directory `dir`, for one ecosystem's manifests. */
export interface Declaration {
  dir: string;
  ecosystem: string;
  workspace: Workspace;
}

export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from directory `base`, normalized; undefined when it leaves the repo or is absolute. */
export const resolveDir = (base: string, rel: string): string | undefined => {
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return undefined;
  const parts = base ? base.split('/') : [];
  for (const seg of rel.split(/[/\\]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
};

const norm = (glob: string) => glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');

/** A glob as workspaces write them: `*` within a segment, `**` across them, `?` and `{a,b}`. */
export const globRe = (glob: string) => {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces) {
      braces--;
      re += ')';
    } else if (c === ',' && braces) re += '|';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
};

/** Globs with pnpm's and npm's `!` exclusions split out. */
export const fromGlobs = (globs: string[]): Workspace => ({
  members: globs.filter((g) => !g.startsWith('!')).map(norm),
  exclude: globs.filter((g) => g.startsWith('!')).map((g) => norm(g.slice(1))),
});

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');

/** pnpm-workspace.yaml's `packages`, as a block list or a flow list. */
export const pnpmWorkspace = (text: string): Workspace => {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      const flow = line.match(/\[(.*)\]/)?.[1];
      if (flow !== undefined) globs.push(...flow.split(',').map(unquote).filter(Boolean));
      inPackages = flow === undefined;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s*-\s*(.+?)\s*$/)?.[1];
    if (item) globs.push(unquote(item));
    else if (/^\S/.test(line)) inPackages = false;
  }
  return fromGlobs(globs);
};

/** go.work's `use` directives, one at a time or in a block: each is a module's directory. */
export const goWork = (text: string): Workspace => {
  const dirs: string[] = [];
  let block = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (/^use\s*\($/.test(line)) block = true;
    else if (block && line === ')') block = false;
    else if (block && line) dirs.push(unquote(line));
    else if (!block) {
      const one = line.match(/^use\s+(\S+)$/)?.[1];
      if (one) dirs.push(unquote(one));
    }
  }
  return { members: dirs.map(norm), exclude: [] };
};

/** A TOML array of strings under `[table]`, across lines; undefined when the key isn't there. */
export const tomlArray = (text: string, table: string, key: string): string[] | undefined => {
  let current = '';
  let collecting = false;
  let found: string[] | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$|^\s*#.*$/, '').trim();
    if (collecting) {
      found!.push(...(line.match(/"[^"]*"|'[^']*'/g) ?? []).map(unquote));
      if (line.replace(/"[^"]*"|'[^']*'/g, '').includes(']')) collecting = false;
      continue;
    }
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1]!.trim();
      continue;
    }
    if (current !== table) continue;
    const m = line.match(new RegExp(`^${key}\\s*=\\s*\\[(.*)$`));
    if (!m) continue;
    found = (m[1]!.match(/"[^"]*"|'[^']*'/g) ?? []).map(unquote);
    collecting = !m[1]!.replace(/"[^"]*"|'[^']*'/g, '').includes(']');
  }
  return found;
};

const within = (dir: string, root: string) => root === '' || dir === root || dir.startsWith(`${root}/`);

/** The innermost workspace declared at or above `dir` for `ecosystem`, merged when one directory declares it twice. */
export const workspaceOf = (declarations: Declaration[], ecosystem: string, dir: string): Declaration | undefined => {
  const around = declarations.filter((d) => d.ecosystem === ecosystem && within(dir, d.dir));
  const dirAt = around.reduce<string | undefined>((a, d) => (a === undefined || d.dir.length > a.length ? d.dir : a), undefined);
  if (dirAt === undefined) return undefined;
  const here = around.filter((d) => d.dir === dirAt);
  return { dir: dirAt, ecosystem, workspace: { members: here.flatMap((d) => d.workspace.members), exclude: here.flatMap((d) => d.workspace.exclude) } };
};

const excluded = (w: Workspace, rel: string) => w.exclude.some((ex) => globRe(ex).test(rel) || rel.startsWith(`${ex}/`));

/**
 * Whether a manifest in `dir` is a package of the workspace around it: its root, or matched by a member glob and by
 * no exclusion. A manifest with no workspace around it is a package of its own. Cargo's path dependencies inside the
 * workspace are members too; `pathMembers` adds them.
 */
export const isMember = (declarations: Declaration[], ecosystem: string, dir: string, pathMembers: Set<string> = new Set()) => {
  const w = workspaceOf(declarations, ecosystem, dir);
  if (!w || w.dir === dir) return true;

  const rel = w.dir === '' ? dir : dir.slice(w.dir.length + 1);
  if (excluded(w.workspace, rel)) return false;
  return pathMembers.has(dir) || w.workspace.members.some((g) => globRe(g).test(rel));
};
