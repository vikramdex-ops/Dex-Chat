// What the bot maker knows about other bots while a bot is made: the skills this maker's bots may
// ask (Nib's, the Directory's, the calendar's, their own bots' and office-wide ones), and the bots
// they may hand requests to or listen to. Loaded once when the maker opens; shared through context.
import { createContext, useContext, useEffect, useState } from 'react';
import type { BotFlowDefinition, BotFlowInfo, BotSkill } from '@dex/core';

export interface NetData {
  skills: BotSkill[];
  bots: BotFlowInfo[];
  /** A bot's definition (for its steps and stages), fetched when first wanted. */
  definition: (name: string) => BotFlowDefinition | null;
  loaded: boolean;
}

export const NetContext = createContext<NetData>({ skills: [], bots: [], definition: () => null, loaded: false });
export const useNet = () => useContext(NetContext);

export function useNetData(name: string | null, admin: boolean): NetData {
  const [skills, setSkills] = useState<BotSkill[]>([]);
  const [bots, setBots] = useState<BotFlowInfo[]>([]);
  const [defs, setDefs] = useState<Record<string, BotFlowDefinition | null>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (admin) { setLoaded(true); return; }
    void Promise.all([
      window.dex.request('botnet.skills', name ? { flow: name } : {}).catch(() => [] as BotSkill[]),
      window.dex.request('botflow.list').catch(() => [] as BotFlowInfo[]),
      window.dex.request('botflow.mine').catch(() => []),
    ]).then(([s, list, mine]) => {
      setSkills(s);
      const all = [...list];
      for (const m of mine) if (!all.some((x) => x.name === m.name)) all.push(m);
      setBots(all.filter((b) => b.name !== name));
      setLoaded(true);
    });
  }, [name, admin]);
  const definition = (n: string) => {
    if (n in defs) return defs[n];
    setDefs((d) => ({ ...d, [n]: null }));
    void window.dex.request('botflow.definition', { name: n }).then((r) => setDefs((d) => ({ ...d, [n]: r.definition }))).catch(() => {});
    return null;
  };
  return { skills, bots, definition, loaded };
}

/** A bot's title for a name (a system bot, a bot in the list, or the name itself). */
export function botTitle(net: NetData, name: string): string {
  if (name === 'nib') return 'Nib';
  if (name === 'directory') return 'Directory';
  if (name === 'calendar') return 'Office calendar';
  return net.bots.find((b) => b.name === name)?.title ?? net.skills.find((s) => s.bot === name)?.botTitle ?? name;
}
