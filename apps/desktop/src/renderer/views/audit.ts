// Control room ▸ Audit log: one line per entry, "<who> <what they did>". Most actions read the same
// whoever did them (the list in Admin.tsx); meetings read by how they ended, and an entry the hub
// recorded with no person (actor null) is the hub's own doing, so it says so rather than "Someone".

export interface AuditLine { who: string; what: string }

/**
 * The words for an entry. `actor` is the person's name, or null when no person did it (the hub
 * records actor null for what it does by itself). `words` gives an action's usual words.
 */
export function auditLine(action: string, actor: string | null, detail: unknown, words: (action: string) => string): AuditLine {
  const d = (detail && typeof detail === 'object' ? detail : {}) as { endedForEveryone?: unknown; people?: unknown };
  if (action === 'meeting.ended') {
    // the hub closes a meeting when the last person leaves, or when a call nobody else joined stops ringing
    if (actor === null) return { who: 'The hub', what: typeof d.people === 'number' && d.people <= 1 ? 'ended a meeting (nobody else joined)' : 'ended a meeting (everyone had left)' };
    return { who: actor, what: d.endedForEveryone ? 'ended a meeting for everyone' : 'ended a meeting' };
  }
  return { who: actor ?? 'Someone', what: words(action) };
}
