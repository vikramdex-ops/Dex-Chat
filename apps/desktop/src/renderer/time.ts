// 12- or 24-hour times everywhere in the app (Preferences ▸ Appearance), or the system's choice.
let hour12: boolean | undefined;
export function setTimeFormat(f: 'system' | '12' | '24' | undefined): void { hour12 = f === '12' ? true : f === '24' ? false : undefined; }
/** Spread into toLocaleTimeString options. */
export const timeOpts = (): { hour12?: boolean } => (hour12 === undefined ? {} : { hour12 });
