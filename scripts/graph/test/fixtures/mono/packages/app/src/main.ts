import { one } from '@pip/core';
import { util } from '@pip/core/util';
import type { Button } from '@pip/ui';

export const main = (button?: Button) => [one(), util, button];
