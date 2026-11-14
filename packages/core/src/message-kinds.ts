// Message kinds beyond plain text: Decisions (a small tree of questions each person walks on their
// own) and references (a message or file from another conversation, shown only to people who may
// open it). The hub keeps the state (apps/hub/src/decisions.ts, refs.ts); the apps draw it.
import type { FileInfo, Message } from './protocol.ts';

// ---------------------------------------------------------------- Decisions

/** Steps below the first question, counted with it: a decision is at most this many steps deep. */
export const DECISION_MAX_DEPTH = 4;
export const DECISION_MAX_OPTIONS = 6;
/** Steps in the whole tree. */
export const DECISION_MAX_STEPS = 24;
export const DECISION_LIMITS = { prompt: 300, label: 80, note: 500, answer: 1000 } as const;

/** What the author sends: a question with options; an option either closes or leads to another step. */
export interface DecisionStepInput {
  prompt: string;
  /** choice: pick one option; text: write an answer (always the end of the path). */
  kind: 'choice' | 'text';
  options?: DecisionOptionInput[];
}
export interface DecisionOptionInput {
  label: string;
  /** The follow-up step this option reveals; none means the option closes the decision. */
  next?: DecisionStepInput | null;
  /** Shown when the option closes (for example "Send the drawings to site by Friday"). */
  note?: string | null;
}

/** The stored tree, with ids the hub gave each step (s1, s2…) and option (s1.1, s1.2…). */
export interface DecisionStep {
  id: string;
  prompt: string;
  kind: 'choice' | 'text';
  /** 1 for the first question. */
  depth: number;
  options: DecisionOption[];
}
export interface DecisionOption {
  id: string;
  label: string;
  closes: boolean;
  note: string | null;
  next: DecisionStep | null;
}

/** A step as someone answering sees it: the follow-ups stay hidden until they are reached. */
export interface DecisionStepView {
  id: string;
  prompt: string;
  kind: 'choice' | 'text';
  depth: number;
  options: Array<{ id: string; label: string; closes: boolean }>;
}
export interface DecisionTrailItem {
  step: DecisionStepView;
  optionId: string | null;
  text: string | null;
}

/** A Decision as one person sees it. */
export interface DecisionView {
  question: string;
  closed: boolean;
  /** People who have answered at least one step, and who reached an end. */
  started: number;
  finished: number;
  /** How deep the tree goes (1–4). */
  depth: number;
  /** The viewer's own path so far. */
  trail: DecisionTrailItem[];
  /** The step in front of the viewer (null once they reached an end, or when the decision is closed). */
  current: DecisionStepView | null;
  done: boolean;
  /** The closing option (or, after a written answer, the option that led to it). */
  outcome: string | null;
  /** The closing option's note. */
  note: string | null;
  finishedAt: number | null;
  /** The whole tree, for its author only. */
  tree: DecisionStep | null;
}

/** One person's walk, for the author's results sheet. */
export interface DecisionPath {
  userId: string;
  done: boolean;
  outcome: string | null;
  steps: Array<{ stepId: string; prompt: string; optionId: string | null; answer: string; text: string | null }>;
  at: number;
}

export interface DecisionResults {
  messageId: string;
  question: string;
  closed: boolean;
  tree: DecisionStep;
  people: DecisionPath[];
  /** Members who have not answered yet (the author and integrations left out). */
  notStarted: string[];
  /** How many people picked each option (by option id). */
  counts: Record<string, number>;
}

// ---------------------------------------------------------------- references

/** What a reference points at: a message in a conversation, or a file someone shared. */
export type RefTarget = { convId: string; messageId: string } | { fileId: string };

/** The body a reference is stored with: what notifications and older apps show. */
export const REF_BODY = 'Shared a reference';

/** A reference as one person sees it: everything only when they may open the source. */
export interface MessageRef {
  kind: 'message' | 'file';
  /** Who wrote the message, or shared the file: shown to everyone. */
  authorId: string;
  /** The viewer may open the source. */
  access: boolean;
  /** With access: */
  convId?: string;
  messageId?: string;
  /** The source conversation's name (Spaces) and kind. */
  convName?: string | null;
  convKind?: 'space' | 'direct';
  /** The source message (its body may be encrypted for Direct conversations; the app opens it). */
  message?: { id: string; convId: string; authorId: string; body: string; createdAt: number; editedAt: number | null; parentId: string | null; files: FileInfo[] };
  file?: FileInfo;
  /** The source was deleted since. */
  gone?: boolean;
}

export interface MessageKindOps {
  'decision.create': { req: { convId: string; parentId?: string; clientId?: string; root: DecisionStepInput }; res: Message };
  /** Answer the step in front of you: an option, or a written answer for a text step. */
  'decision.answer': { req: { messageId: string; stepId: string; optionId?: string; text?: string }; res: Message };
  /** Start your own path again. */
  'decision.reset': { req: { messageId: string }; res: Message };
  /** The author (or an administrator) stops further answers. */
  'decision.close': { req: { messageId: string }; res: Message };
  /** Who is where, for the author (or an administrator). */
  'decision.results': { req: { messageId: string }; res: DecisionResults };
  /** Post a reference to a message or file (not a copy) into a conversation. */
  'refs.send': { req: { convId: string; parentId?: string; clientId?: string; target: RefTarget }; res: Message };
  /** Before posting: how many people in the conversation could not open the source. */
  'refs.check': { req: { convId: string; target: RefTarget }; res: { members: number; without: number } };
  /** A reference message, resolved for the person asking. */
  'refs.resolve': { req: { messageId: string }; res: MessageRef };
}
