import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      gen: { command: 'node gen.js', cache: { input: [] } },
      types: { command: 'tsc --noEmit', dependsOn: ['gen'], cache: { input: ['src/**/*.ts', { pattern: 'tsconfig.json', base: 'workspace' }] } },
      docs: { command: 'node docs.js', dependsOn: ['types'] },
    },
  },
});
