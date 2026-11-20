import 'react';
import { readFileSync } from 'node:fs';

export const load = (name: string) => import(name);
export const routes = () => import('./generated/routes');
void readFileSync;
