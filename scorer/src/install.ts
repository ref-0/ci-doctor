// The install steps per harness: the same lines as the README's "Installing" sections. A test will compare the two.
export const INSTALL_STEPS: readonly { harness: string; steps: readonly string[] }[] = [
  { harness: 'Claude Code', steps: ['claude plugin marketplace add ref-0/ci-doctor', 'claude plugin install ci-doctor@ref0'] },
  { harness: 'Codex', steps: ['codex plugin marketplace add ref-0/ci-doctor', 'codex plugin add ci-doctor@ref0'] },
  { harness: 'VS Code / Copilot', steps: ['Install plugin from source: https://github.com/ref-0/ci-doctor'] },
  { harness: 'Cursor', steps: ['Plugins, From GitHub Repository'] },
  { harness: 'Any other agent', steps: ['npx skills add https://github.com/ref-0/ci-doctor'] },
  { harness: 'By hand', steps: ["Copy skills/ into your agent's skills folder: the README's table lists each agent's folder"] },
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
