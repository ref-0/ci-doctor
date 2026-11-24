// The scorer's version, from its package.json, which sits one folder up from both src/ and dist/.
import { readFileSync } from 'node:fs';

export const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
