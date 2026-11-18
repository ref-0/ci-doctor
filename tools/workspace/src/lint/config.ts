/**
 * config.ts: lint settings with a switch for the type-aware rules, so one config serves both of a
 * split check's passes, and `merge`, which lays a repo's own settings over these.
 *
 * Runs: imported by the repo's lint config (for Vite+, the module its `vite.config.ts` spreads in).
 * Configure: `WORKSPACE_LINT_TYPES=none` in the environment turns the type-aware rules off. Key
 * that variable in every cached lint task, or a typed pass replays an untyped one. Add your own
 * rules and plugins with `merge`.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * The settings are Oxlint's, as Vite+'s `lint` and `fmt` take them, and as `.oxlintrc.json` holds
 * them. The two passes:
 *
 * - Untyped, over every file: `typeAware: false`, and unused-disable reporting off, since a
 *   directive for a type-aware rule disables nothing without types and would read as unused.
 * - Typed, over the changed files: `typeAware: true`, and unused directives are errors again.
 *
 * Both keep `typeCheck: false`: the type driver (`../types/`) owns the complete type check, and
 * lint checking types too would be a second, partial pass.
 *
 * The source repo's shared config also turns on rules from vendored community plugins
 * and its own. Those aren't ported here; add the plugins you use with `merge`.
 */

/** A lint or format config: Oxlint's keys, loosely typed so it needs no tool's types. */
export interface Settings {
  readonly ignorePatterns?: ReadonlyArray<string>;
  readonly plugins?: ReadonlyArray<string>;
  readonly jsPlugins?: ReadonlyArray<string>;
  readonly overrides?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly [other: string]: unknown;
}

/** The variable that picks the pass. */
export const modeVariable = 'WORKSPACE_LINT_TYPES';

// What agents' tools keep in a repo: their settings, skills and logs, which no repo's checks read.
const agentToolingIgnorePatterns = [
  '.agent/**',
  '.agents/**',
  '.claude/**',
  '.codex/**',
  '.continue/**',
  '.cursor/**',
  '.gemini/**',
  '.opencode/**',
  '.roo/**',
  '.windsurf/**',
];

const unsafeAnyRules = [
  'typescript/no-explicit-any',
  'typescript/no-unsafe-argument',
  'typescript/no-unsafe-assignment',
  'typescript/no-unsafe-call',
  'typescript/no-unsafe-member-access',
  'typescript/no-unsafe-return',
] as const;

/** Whether this pass runs the type-aware rules: yes, unless the mode variable is `none`. */
export const typeAwareIn = (environment: Readonly<Record<string, string | undefined>>) => environment[modeVariable] !== 'none';

/** The shared format settings. */
export const format: Settings = { ignorePatterns: agentToolingIgnorePatterns, semi: true, singleQuote: true };

/** The shared lint settings for one pass. */
export const lintFor = (typeAware: boolean): Settings => ({
  ignorePatterns: [...agentToolingIgnorePatterns, '**/dist/**'],
  options: {
    // Without types, a directive for a type-aware rule disables nothing.
    reportUnusedDisableDirectives: typeAware ? 'error' : 'off',
    typeAware,
    typeCheck: false,
  },
  plugins: ['typescript', 'import'],
  rules: {
    'oxc/no-accumulating-spread': 'error',
    // A value a dependency types `any`, like `JSON.parse`'s, is narrowed at the call that returns
    // it, with a schema or a guard, never `as`. Tests keep these off, in the override below.
    ...Object.fromEntries(unsafeAnyRules.map((rule) => [rule, 'error'])),
  },
  overrides: [
    {
      // Tests may take a dependency's `any` as it is.
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.test-d.ts'],
      rules: Object.fromEntries(unsafeAnyRules.map((rule) => [rule, 'off'])),
    },
    {
      // No import cycle, in any file, tests too. The rule skips an import whose names are all
      // types, so lint asks for `import type` there: `verbatimModuleSyntax` keeps
      // `import { type A } from './a'` as `import {} from './a'`, which still loads `./a`. The import
      // plugin is on for the whole config, above, since Oxlint builds the module graph only then.
      // `import/namespace` would read a package's built `dist/`, which lint's inputs leave out.
      files: ['**/*'],
      rules: {
        'import/no-cycle': 'error',
        'typescript/no-import-type-side-effects': 'error',
        'import/default': 'off',
        'import/namespace': 'off',
      },
    },
  ],
});

/** The settings for the pass the environment picks. */
export const base = (environment: Readonly<Record<string, string | undefined>> = process.env) => ({
  fmt: format,
  lint: lintFor(typeAwareIn(environment)),
});

/** Two lists, the shared one first, or nothing when neither config sets it. */
const lists = <Item>(shared?: ReadonlyArray<Item>, own?: ReadonlyArray<Item>) =>
  shared === undefined && own === undefined ? undefined : [...(shared ?? []), ...(own ?? [])];

/** Two objects, the shared one's keys overwritten by the repo's, or nothing when neither sets it. */
const objects = <Entries extends object>(shared?: Entries, own?: Entries) =>
  shared === undefined && own === undefined ? undefined : { ...shared, ...own };

/**
 * `local` over `shared`, shared first: ignores, plugins and overrides are joined, and rules and
 * options are merged, so a local rule wins over the shared one. Any other setting is local's when
 * it has one.
 */
export const merge = (shared: Settings, local: Settings): Settings => {
  const joined = Object.entries({
    ignorePatterns: lists(shared.ignorePatterns, local.ignorePatterns),
    plugins: lists(shared.plugins, local.plugins),
    jsPlugins: lists(shared.jsPlugins, local.jsPlugins),
    overrides: lists(shared.overrides, local.overrides),
    rules: objects(shared.rules, local.rules),
    options: objects(shared.options, local.options),
  }).filter(([, setting]) => setting !== undefined);

  return { ...shared, ...local, ...Object.fromEntries(joined) };
};
