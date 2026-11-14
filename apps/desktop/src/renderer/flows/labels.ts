// Words for the parts of a rule: what each kind is called, and a one-line summary of a node.
import type { ActionKind, ActionNode, ConditionKind, ConditionNode, FlowGraph, PersonRef, TriggerKind, TriggerNode } from '@dex/core';

export interface Names {
  person: (id: string) => string;
  group: (id: string) => string;
  conv: (id: string) => string;
}

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  'file.added': 'A file is attached',
  'reaction.added': 'Someone reacts',
  'response.confirmed': 'A vote or form answer',
  'message.matched': 'A message has these words',
  'message.mentioned': 'Someone is mentioned',
};
export const CONDITION_LABEL: Record<ConditionKind, string> = {
  conversation: 'Only in these conversations',
  author: 'Only when it is these people',
  time: 'Only at these times',
  file: 'Only these files',
};
export const ACTION_LABEL: Record<ActionKind, string> = {
  extract: 'Read the PDF title block',
  notify: 'Notify people',
  post: 'Post a message',
  task: 'Reminder or To do',
  tag: 'Tag the message',
  webhook: 'Call a webhook',
};

export const ROLE_LABEL: Record<'author' | 'actor' | 'owner', string> = {
  author: 'Who wrote the message',
  actor: 'Who reacted or answered',
  owner: 'The rule’s owner',
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function peopleText(refs: PersonRef[], n: Names): string {
  if (!refs.length) return 'nobody chosen yet';
  const parts = refs.map((r) => (r.kind === 'user' ? n.person(r.id) : r.kind === 'group' ? `${n.group(r.id)} (group)` : ROLE_LABEL[r.id].toLowerCase()));
  return parts.length <= 3 ? parts.join(', ') : `${parts.slice(0, 2).join(', ')} and ${parts.length - 2} more`;
}

export function daysText(days: number[]): string {
  const s = [...days].sort().join(',');
  if (s === '1,2,3,4,5') return 'Mon–Fri';
  if (s === '0,6') return 'weekends';
  if (s === '0,1,2,3,4,5,6') return 'every day';
  return days.map((d) => DAYS[d]).join(', ');
}

const types = (t?: string[]) => (t?.length ? t.map((x) => `.${x}`).join(' ') : 'any file');
const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function triggerSummary(t: TriggerNode, n: Names): string {
  switch (t.kind) {
    case 'file.added': return `${types(t.types)}${t.namePattern ? ` named ${t.namePattern}` : ''}`;
    case 'reaction.added': return `${t.emoji || 'a reaction (choose one)'}${t.by?.length ? ` on messages by ${peopleText(t.by, n)}` : ' on any message'}`;
    case 'response.confirmed': return `${t.source === 'poll' ? 'a poll vote' : t.source === 'form' ? 'a form answer' : t.source === 'decision' ? 'the end of a Decision' : 'a poll vote, form answer or Decision'}${t.choice ? ` of “${t.choice}”` : ''}`;
    case 'message.matched': return t.pattern ? (t.mode === 'regex' ? `matches /${clip(t.pattern, 40)}/` : `has “${clip(t.pattern, 50)}”`) : 'words not chosen yet';
    case 'message.mentioned': return `mentions ${peopleText(t.targets, n)}`;
  }
}

export function conditionSummary(c: ConditionNode, n: Names): string {
  switch (c.kind) {
    case 'conversation': return c.convIds.length ? c.convIds.map((id) => n.conv(id)).join(', ') : 'no conversation chosen';
    case 'author': return `${c.exclude ? 'not ' : ''}${peopleText(c.people, n)}`;
    case 'time': return `${c.outside ? 'outside ' : ''}${daysText(c.days)}${c.from === c.to ? ', all day' : `, ${c.from}–${c.to}`}`;
    case 'file': return `${types(c.types)}${c.namePattern ? ` named ${c.namePattern}` : ''}`;
  }
}

export function actionSummary(a: ActionNode, n: Names): string {
  switch (a.kind) {
    case 'extract': return 'gives {{file.title}}, {{file.revision}}, {{file.number}}';
    case 'notify': return `to ${peopleText(a.to, n)}`;
    case 'post': return `in ${a.convId ? n.conv(a.convId) : 'the conversation where it happened'}`;
    case 'task': return `${a.mode === 'todo' ? 'To do on the Desk of' : 'reminder for'} ${peopleText(a.to, n)}${a.mode === 'reminder' ? (a.dueInMinutes ? `, due in ${dueText(a.dueInMinutes)}` : ', due at once') : ''}`;
    case 'tag': return a.tag ? `#${a.tag}` : 'tag not chosen yet';
    case 'webhook': return a.url ? (() => { try { const u = new URL(a.url); return `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return a.url; } })() : 'address not set';
  }
}

export function dueText(m: number): string {
  if (m % 10080 === 0) return `${m / 10080} week${m === 10080 ? '' : 's'}`;
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minutes`;
}

/** A blank node of a kind, to start editing. */
export function blankTrigger(kind: TriggerKind): TriggerNode {
  switch (kind) {
    case 'file.added': return { id: 't1', kind, types: ['pdf'] };
    case 'reaction.added': return { id: 't1', kind, emoji: '✅' };
    case 'response.confirmed': return { id: 't1', kind, source: 'any' };
    case 'message.matched': return { id: 't1', kind, mode: 'keywords', pattern: '' };
    case 'message.mentioned': return { id: 't1', kind, targets: [] };
  }
}

export function blankCondition(kind: ConditionKind, id: string): ConditionNode {
  switch (kind) {
    case 'conversation': return { id, kind, convIds: [] };
    case 'author': return { id, kind, people: [] };
    case 'time': return { id, kind, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
    case 'file': return { id, kind, types: ['pdf'] };
  }
}

export function blankAction(kind: ActionKind, id: string, graph: FlowGraph): ActionNode {
  const extracted = graph.actions.some((a) => a.kind === 'extract');
  const text = extracted ? '{{author.name}} shared {{file.name}} in {{conversation.name}}.\nTitle: {{file.title}}\nRevision: {{file.revision}}'
    : graph.trigger.kind === 'file.added' ? '{{author.name}} shared {{file.name}} in {{conversation.name}}.'
      : graph.trigger.kind === 'reaction.added' ? '{{actor.name}} reacted {{reaction.emoji}} in {{conversation.name}}: {{message.text}}'
        : graph.trigger.kind === 'response.confirmed' ? '{{actor.name}} chose “{{response.choice}}” in {{conversation.name}}.'
          : '{{author.name}} wrote in {{conversation.name}}: {{message.text}}';
  switch (kind) {
    case 'extract': return { id, kind };
    case 'notify': return { id, kind, to: [], text };
    case 'post': return { id, kind, convId: null, text };
    case 'task': return { id, kind, to: [{ kind: 'role', id: 'owner' }], text: 'Follow up', mode: 'reminder', dueInMinutes: 60 };
    case 'tag': return { id, kind, tag: '' };
    case 'webhook': return { id, kind, url: 'https://', body: '' };
  }
}
