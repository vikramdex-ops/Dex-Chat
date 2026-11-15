// The bot maker's view of a draft: the kinds of answer a step can take, in people's words, and the
// small changes the editor makes (a new step of a kind, a kind changed, a route between steps).
import type { BotFlowCondition, BotFlowDefinition, BotFlowInput, BotFlowStep } from '@dex/core';
import { freshStepId } from '@dex/core/botmaker';

export type AnswerKind = 'choice' | 'text' | 'long' | 'number' | 'date' | 'email' | 'pattern' | 'person' | 'file' | 'confirm';
export const ANSWER_KINDS: AnswerKind[] = ['choice', 'text', 'long', 'number', 'date', 'email', 'pattern', 'person', 'file', 'confirm'];

export const KIND_WORDS: Record<AnswerKind, string> = {
  choice: 'Choices', text: 'Short text', long: 'Paragraph', number: 'Number', date: 'Date', email: 'Email address',
  pattern: 'Checked text', person: 'A person', file: 'A file', confirm: 'Confirm',
};
/** The mono caption on a step's row. */
export const KIND_TAG: Record<AnswerKind, string> = {
  choice: 'CHOICE', text: 'TEXT', long: 'PARA', number: 'NUMBER', date: 'DATE', email: 'EMAIL', pattern: 'CHECKED', person: 'PERSON', file: 'FILE', confirm: 'CONFIRM',
};

export function kindOf(input: BotFlowInput | undefined): AnswerKind {
  if (!input) return 'text';
  if (input.kind !== 'text') return input.kind as AnswerKind;
  const v = input.validate?.type;
  if (v === 'number') return 'number';
  if (v === 'date') return 'date';
  if (v === 'email') return 'email';
  if (v === 'regex') return 'pattern';
  return input.multiline ? 'long' : 'text';
}

/** An input of a kind, keeping what still fits from the one before (the choices, the placeholder…). */
export function inputOf(kind: AnswerKind, prev?: BotFlowInput): BotFlowInput {
  const keep = { ...(prev?.placeholder ? { placeholder: prev.placeholder } : {}), ...(prev?.optional && kind !== 'confirm' ? { optional: true } : {}) };
  switch (kind) {
    case 'choice': return { kind: 'choice', options: prev?.options?.length ? prev.options : [{ value: 'Option 1', label: 'Option 1' }, { value: 'Option 2', label: 'Option 2' }], ...(prev?.optional ? { optional: true } : {}) };
    case 'text': return { kind: 'text', ...keep, ...(prev?.suggestions ? { suggestions: prev.suggestions } : {}) };
    case 'long': return { kind: 'text', multiline: true, ...keep };
    case 'number': return { kind: 'text', validate: { type: 'number', integer: true, min: 1 }, ...keep, ...(prev?.suggestions ? { suggestions: prev.suggestions } : {}) };
    case 'date': return { kind: 'text', validate: { type: 'date', notBefore: 'today' }, ...(prev?.optional ? { optional: true } : {}) };
    case 'email': return { kind: 'text', validate: { type: 'email' }, ...keep };
    case 'pattern': return { kind: 'text', validate: { type: 'regex', pattern: '[A-Z]{1,4}-\\d{3,6}', message: 'Write it like P-12513.' }, ...keep };
    case 'person': return { kind: 'person', ...(prev?.optional ? { optional: true } : {}) };
    case 'file': return { kind: 'file', accept: ['.pdf'], ...(prev?.optional ? { optional: true } : {}) };
    case 'confirm': return { kind: 'confirm' };
  }
}

const FIRST_PROMPT: Record<AnswerKind, string> = {
  choice: 'Which one?', text: 'What is it?', long: 'Tell us more.', number: 'How many?', date: 'Which day?', email: 'Which email address?',
  pattern: 'Which job number?', person: 'Who should do it?', file: 'Attach the file.', confirm: 'Send this?\n\n{{summary}}',
};
const FIRST_LABEL: Record<AnswerKind, string> = {
  choice: 'Choice', text: 'Answer', long: 'Details', number: 'Number', date: 'Day', email: 'Email', pattern: 'Job', person: 'Person', file: 'File', confirm: '',
};

/** A new step of a kind, with an id not used yet. */
export function newStep(def: BotFlowDefinition, kind: AnswerKind): BotFlowStep {
  const id = freshStepId(def);
  const used = new Set(def.steps.map((s) => (s.label ?? '').toLowerCase()));
  let label = FIRST_LABEL[kind];
  for (let n = 2; label && used.has(label.toLowerCase()); n++) label = `${FIRST_LABEL[kind]} ${n}`;
  return { id, ...(label ? { label } : {}), prompt: FIRST_PROMPT[kind], input: inputOf(kind) };
}

// ------------------------------------------------------------------ routes
export type RouteOp = 'is' | 'isnt' | 'more' | 'less' | 'empty';
export const ROUTE_WORDS: Record<RouteOp, string> = { is: 'is', isnt: 'is not', more: 'is more than', less: 'is less than', empty: 'was skipped' };

export function routeOf(c: BotFlowCondition): { op: RouteOp; value: string } {
  if (c.empty) return { op: 'empty', value: '' };
  if (c.notEquals !== undefined) return { op: 'isnt', value: c.notEquals };
  if (c.gt !== undefined) return { op: 'more', value: String(c.gt) };
  if (c.lt !== undefined) return { op: 'less', value: String(c.lt) };
  return { op: 'is', value: c.equals ?? c.in?.[0] ?? '' };
}

export function conditionOf(op: RouteOp, value: string): BotFlowCondition {
  if (op === 'empty') return { empty: true };
  if (op === 'isnt') return { notEquals: value };
  if (op === 'more' || op === 'less') { const n = Number(value); return op === 'more' ? { gt: Number.isFinite(n) ? n : 0 } : { lt: Number.isFinite(n) ? n : 0 }; }
  return { equals: value };
}

/** Steps whose answers name a person / a date (for tasks, posts and due dates). */
export const personSteps = (def: BotFlowDefinition) => def.steps.filter((s) => s.input?.kind === 'person');
export const dateSteps = (def: BotFlowDefinition) => def.steps.filter((s) => kindOf(s.input) === 'date');
export const saveKeyOf = (s: BotFlowStep) => s.save ?? s.id;
