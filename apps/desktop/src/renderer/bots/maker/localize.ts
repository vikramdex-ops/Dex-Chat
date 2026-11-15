// A template in the language the maker reads: its questions, buttons, stages and stamps are put
// into Hindi or Tamil when the bot is made from it (the answers' values, the {{placeholders}} and
// the short names stay as they are, so the bot works the same in every language).
import type { BotFlowDefinition } from '@dex/core';
import { tr, translating } from '../../i18n/index.ts';

const t = <T extends string | undefined>(s: T): T => (s ? tr(s) as T : s);

export function localizeBot(def: BotFlowDefinition): BotFlowDefinition {
  if (!translating()) return def;
  const d = JSON.parse(JSON.stringify(def)) as BotFlowDefinition;
  d.title = t(d.title);
  d.description = t(d.description);
  d.done = t(d.done);
  if (d.persona) { d.persona.about = t(d.persona.about); d.persona.greeting = t(d.persona.greeting); }
  for (const s of d.steps) {
    s.label = t(s.label);
    s.prompt = t(s.prompt);
    s.input.placeholder = t(s.input.placeholder);
    s.input.yes = t(s.input.yes);
    s.input.no = t(s.input.no);
    if (s.input.validate?.message) s.input.validate.message = t(s.input.validate.message);
    // a choice keeps its value; its words are translated (software names have no translation and stay)
    if (s.input.options) s.input.options = s.input.options.map((o) => ({ value: o.value, label: t(o.label) }));
  }
  if (d.track) {
    for (const r of Object.values(d.track.roles ?? {})) r.label = t(r.label);
    for (const st of d.track.stages) {
      st.label = t(st.label);
      st.prompt = t(st.prompt);
      if (st.checklist) st.checklist = st.checklist.map((c) => t(c));
      for (const a of st.actions) { a.label = t(a.label); a.stamp = t(a.stamp); a.ask = t(a.ask); }
      // places are counted by the answers' words: keep the counts with the translated words
      if (st.limit?.by) {
        const step = def.steps.find((x) => (x.save ?? x.id) === st.limit!.by);
        st.limit.seats = Object.fromEntries(Object.entries(st.limit.seats).map(([k, n]) => [step?.input.options?.some((o) => o.label === k) ? t(k) : k, n]));
      }
    }
  }
  return d;
}
