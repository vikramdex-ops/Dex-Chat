// The bot's conversation, played beside the editor in a real chat pane with the real cards. It
// follows the draft as it changes (the answers given so far are given again to the new draft), and
// Test run walks through it from the start exactly as a colleague would; nothing is sent.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotFlowAnswer, BotFlowDefinition, Message, PublicUser } from '@dex/core';
import { BotFlowError, validateFlow } from '@dex/core/botflows';
import { testAnswer, testBack, testCancel, testStart } from '@dex/core/botmaker';
import type { TestRun } from '@dex/core/botmaker';
import { Icon } from '../../ui.tsx';
import { FlowCardView } from '../FlowCard.tsx';
import type { FlowDriver } from '../FlowCard.tsx';
import { BotMarkTile } from '../BotMark.tsx';
import { DEFAULT_PERSONA } from './Identity.tsx';

type Given = Array<{ stepId: string; value: string }>;

/** A test run of `def`, with `given` answered again (as far as they still fit). */
function replay(def: BotFlowDefinition, me: { id: string; name: string; account: string }, given: Given, memory: Record<string, BotFlowAnswer>, ctx: Parameters<typeof testAnswer>[3]): { run: TestRun; given: Given } {
  let run = testStart(def, me, memory);
  const kept: Given = [];
  for (const g of given) {
    if (run.status !== 'active' || run.step !== g.stepId) break;
    try { run = testAnswer(run, g.stepId, g.value, ctx); kept.push(g); } catch { break; }
  }
  return { run, given: kept };
}

export function Preview({ def, me, users, restartKey }: { def: BotFlowDefinition; me: PublicUser; users: Map<string, PublicUser>; restartKey: number }) {
  // the last draft that is a working bot: the pane keeps showing it while a problem is being fixed
  const [good, broken] = useMemo((): [BotFlowDefinition | null, boolean] => { try { return [validateFlow(def), false]; } catch { return [null, true]; } }, [def]);
  const lastGood = useRef<BotFlowDefinition | null>(good);
  if (good) lastGood.current = good;
  const shown = good ?? lastGood.current;
  const [given, setGiven] = useState<Given>([]);
  const [memory, setMemory] = useState<Record<string, BotFlowAnswer>>({});
  const [ended, setEnded] = useState<'cancelled' | null>(null);
  const meRef = useMemo(() => ({ id: me.id, name: me.displayName, account: me.account }), [me]);
  const ctx = useMemo(() => ({
    now: Date.now(),
    person: (v: string) => { const u = users.get(v) ?? [...users.values()].find((x) => x.displayName.toLowerCase() === v.toLowerCase()); return u && u.role !== 'bot' && u.id !== me.id ? { id: u.id, name: u.displayName } : null; },
    file: (v: string) => (v.startsWith('test:') ? { id: v, name: v.slice(5) } : null),
  }), [users, me.id]);
  useEffect(() => { setGiven([]); setEnded(null); }, [restartKey]);
  const base = useMemo(() => (shown ? replay(shown, meRef, given, memory, ctx) : null), [shown, given, memory, meRef, ctx]);
  const run = base && ended ? testCancel(base.run) : base?.run ?? null;
  // when it finishes, it remembers (as the real bot would) for the next test run
  useEffect(() => { if (run?.status === 'done' && shown?.persona?.remember) setMemory((m) => ({ ...m, ...run.memory })); }, [run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [run?.cards.length]);

  const driver: FlowDriver = {
    test: true,
    answer: async (_sid, stepId, value) => {
      if (!base) return;
      // checked here so the card can show the refusal in the bot's own words
      try { testAnswer(base.run, stepId, value, ctx); } catch (e) { throw new Error(e instanceof BotFlowError ? e.message : String(e)); }
      setGiven([...base.given, { stepId, value }]);
    },
    back: async () => { if (base) { testBack(base.run); setGiven(base.given.slice(0, -1)); } },
    cancel: async () => { setEnded('cancelled'); },
    resume: async (_sid, over) => { if (over) setGiven([]); },
    start: async () => ({ convId: 'test', resumed: false }),
  };
  const p = shown?.persona ?? DEFAULT_PERSONA(def.title);
  const botUser = { id: 'test-bot', displayName: def.title || 'Your bot' };
  const fake = (id: string, body: string, card: TestRun['cards'][number]['card']): Message => ({ id, convId: 'test', authorId: botUser.id, body, createdAt: Date.now(), botflow: card ?? undefined } as unknown as Message);
  const lines = run ? run.cards : [];
  return (
    <section className="bm-preview" aria-label="Test run">
      <header className="bm-pv-head">
        <BotMarkTile mark={p.mark} colour={p.colour} size={28} />
        <span className="bm-pv-name" translate="no">{def.title || 'Your bot'}</span>
        <span className="chip">Bot</span>
        <span className="bm-pv-as mono">As {me.displayName}</span>
      </header>
      {broken && <div className="bm-pv-note" role="status"><Icon name="warning" size={14} />Showing the last version that worked. Fix the marked problems to try the change.</div>}
      <div className="timeline bm-pv-timeline">
        <div className="spine">
          {!run && <div className="empty bm-pv-empty"><Icon name="chat" size={20} /><span>Add a question to see the conversation.</span></div>}
          {run && (
            <div className="run">
              <div className="run-tile"><BotMarkTile mark={p.mark} colour={p.colour} size={36} /></div>
              <div className="run-body">
                <div className="run-head">
                  <span className="run-name" translate="no">{def.title || 'Your bot'}</span>
                  <span className="chip accent bot-chip">Bot</span>
                  <span className="run-time">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                {lines.map((c) => (
                  <div key={c.id} className="msg">
                    {c.card
                      ? <FlowCardView m={fake(c.id, c.body, { ...c.card, ownerId: me.id })} meId={me.id} users={users} driver={driver} />
                      : <div className="msg-text" translate="no">{c.body}</div>}
                  </div>
                ))}
                <div ref={end} />
              </div>
            </div>
          )}
        </div>
      </div>
      <footer className="bm-pv-foot">
        <span className="mono faint">Test run · nothing is sent</span>
        <span className="grow" />
        {Object.keys(memory).length > 0 && <button type="button" className="btn ghost sm" onClick={() => setMemory({})}>Forget test answers</button>}
      </footer>
    </section>
  );
}
