// The Room panel's tabs on a webinar's stage (kept apart so the Room sheet does not load the
// webinar's code until a webinar is open): People, the panelists' backstage chat, and the
// webinar's own Questions, Audience, Polls and Handouts.
export type WebinarTab = 'questions' | 'audience' | 'wpolls' | 'handouts';
export const WEBINAR_TABS: Array<{ id: WebinarTab; label: string }> = [
  { id: 'questions', label: 'Questions' }, { id: 'audience', label: 'Audience' }, { id: 'wpolls', label: 'Polls' }, { id: 'handouts', label: 'Handouts' },
];
export const WEBINAR_TAB_LIST: Array<{ id: 'people' | 'chat' | WebinarTab; label: string }> = [{ id: 'people', label: 'People' }, { id: 'chat', label: 'Backstage' }, ...WEBINAR_TABS];
export const isWebinarTab = (t: string): t is WebinarTab => WEBINAR_TABS.some((x) => x.id === t);
