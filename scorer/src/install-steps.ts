// The install steps per harness: the same lines as the repo README's "Installing" sections.
// The repo's scripts/plugin/validate.ts checks that each of its INSTALL_LINES is in both.
export const INSTALL_STEPS: readonly { harness: string; steps: readonly string[] }[] = [
  { harness: 'Claude Code', steps: ['claude plugin marketplace add ref-0/ci-doctor', 'claude plugin install ci-doctor@ref0'] },
  { harness: 'Codex', steps: ['codex plugin marketplace add ref-0/ci-doctor', 'codex plugin add ci-doctor@ref0'] },
  { harness: 'VS Code / Copilot', steps: ['With chat.plugins.enabled on, run Chat: Install Plugin From Source', 'and enter https://github.com/ref-0/ci-doctor'] },
  { harness: 'Cursor', steps: ['Customize, Plugins, From GitHub Repository', 'and enter https://github.com/ref-0/ci-doctor'] },
  { harness: 'Any other agent', steps: ['npx skills add https://github.com/ref-0/ci-doctor'] },
  { harness: 'By hand', steps: ["Clone the repo at its newest release tag and copy each folder in skills/ into your agent's skills folder", "(the repo's README lists each agent's folder)"] },
];

export const installText = () => {
  const width = Math.max(...INSTALL_STEPS.map((s) => s.harness.length));
  const rows = INSTALL_STEPS.flatMap(({ harness, steps }) => steps.map((step, i) => `  ${(i ? '' : harness).padEnd(width)}  ${step}`));
  return [
    "Install ci-doctor's skills in your agent:",
    '',
    ...rows,
    '',
    "Updates are each harness's own. Installing adds skills only: no MCP server, no hooks, and no scripts run.",
  ].join('\n');
};
