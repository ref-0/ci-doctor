/**
 * Tests for the ci-workflows skill's ci-time.ts that need the rest of this repo beside it, so they
 * can't run with the skill installed alone: the settings template in agent-knowledge holds every
 * default, and the real Blacksmith adapter loads from the skills beside it.
 *
 * Runs: `node --test ci-time.test.ts` from this folder (Node 24).
 */
import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { adapterFile, DEFAULTS, loadAdapter, readSettings } from '../../skills/ci-workflows/scripts/ci-time.ts';

const skills = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

describe('ci-time.ts beside the other skills', () => {
  it('has a settings template that holds every default', () => {
    const template = join(skills, 'agent-knowledge', 'templates', 'repo-facts', 'ci-time.json');
    // Read the file itself first: readSettings fills a missing or empty file from DEFAULTS.
    deepStrictEqual(Object.keys(JSON.parse(readFileSync(template, 'utf8'))).sort(), Object.keys(DEFAULTS).sort());
    deepStrictEqual(readSettings(template), DEFAULTS);
  });

  it('loads the real Blacksmith adapter from the skills beside it', async () => {
    ok(adapterFile('blacksmith', skills), `no blacksmith-bill.ts where ci-time.ts looks, under ${skills}`);
    const adapter = await loadAdapter('blacksmith');
    equal(typeof adapter.billed, 'function');
    equal(typeof adapter.cpu, 'function');
  });
});
