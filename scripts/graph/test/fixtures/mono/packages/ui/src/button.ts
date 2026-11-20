import { two } from '@pip/core';
import { main } from '@pip/app';

export type Button = { label: string };
export const button = () => [two(), main];
