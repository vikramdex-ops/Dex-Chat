// The tools that come with Dexterity Connect, approved from the start (an administrator can
// switch any of them off in Control room → Bots & tools).
import type { BuiltinApp } from './kit.ts';
import { CALCULATOR } from './calculator.ts';
import { UNIT_CONVERTER } from './units.ts';
import { DIAGRAM_VIEWER } from './diagram.ts';
import { DATA_SHEET } from './table.ts';
import { PUNCH_LIST } from './punchlist.ts';

export const BUILTIN_MINIAPPS: BuiltinApp[] = [CALCULATOR, UNIT_CONVERTER, DIAGRAM_VIEWER, DATA_SHEET, PUNCH_LIST];
