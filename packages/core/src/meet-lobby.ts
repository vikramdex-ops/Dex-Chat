// Knocks: someone waiting in the lobby of a meeting or room you host, wherever you are in the app
// (docs/MEETINGS.md, "Who is waiting"). The hub keeps one knock per waiting device and tells every
// person who may let them in: an event for the app's indicator and notification, and a card in
// their conversation with Nib with Admit and Decline. A knock is answered from any of them, or
// from the Room's own lobby list; every copy then shows who answered.
import type { MeetingKind } from './protocol.ts';

/** waiting: still in the lobby; admitted/declined: a host answered; left: they gave up; ended: the meeting ended first. */
export type KnockState = 'waiting' | 'admitted' | 'declined' | 'left' | 'ended';

export interface KnockView {
  id: string;
  meetingId: string;
  /** The meeting's title ("Vikram's room", "Client review"). */
  title: string;
  kind: MeetingKind;
  /** The name as the person gave it. A browser guest's name is typed by them and checked by no one. */
  name: string;
  /** The colleague's account; '' for a browser guest (they have none). */
  userId: string;
  /** From a browser, through the meeting link: the name is not verified. */
  guest: boolean;
  /** When they started waiting. */
  at: number;
  state: KnockState;
  /** Who let them in or turned them away (a person's id), or null (the hub: the host arrived, the meeting ended). */
  by: string | null;
  decidedAt: number | null;
  /** When the person came into the Room after being let in (null until then). */
  joinedAt: number | null;
  /** The meeting's Room is open now. */
  live: boolean;
  /** Its host or a co-host is in the Room now. */
  hostIn: boolean;
}

/** A meeting you organise that has people in it while you are not there. */
export interface HostedLive {
  meetingId: string;
  title: string;
  kind: MeetingKind;
  /** Since when the Room has been open. */
  since: number;
  people: Array<{ name: string; guest: boolean; since: number }>;
}

/** What the indicator shows: everyone waiting for you, and your meetings running without you. */
export interface LobbyBoard { knocks: KnockView[]; rooms: HostedLive[] }

/** Someone came into a meeting you organise while you were not in it (lighter than a knock). */
export interface JoinedNotice { meetingId: string; title: string; kind: MeetingKind; name: string; guest: boolean; at: number; /** let in from the lobby (from a knock) */ admitted: boolean }

declare module './protocol.ts' {
  interface Ops {
    /** Everyone waiting in the lobbies of meetings you may let people into, and your meetings running without you. */
    'meet.knocks': { req: void; res: LobbyBoard };
    /**
     * Let one person in (or turn them away) by their knock, from anywhere in the app: the
     * indicator, the notification or Nib's card. With a meeting ID and `all`, everyone waiting
     * for that meeting. Works whether or not you are in the Room: a person let in before the
     * Room is open opens it and waits there for you.
     */
    'meet.knock.answer': { req: { id?: string; meetingId?: string; all?: boolean; allow: boolean }; res: { knocks: KnockView[] } };
  }
  interface Events {
    /** Your board changed (someone knocked, was answered, left, or a meeting of yours runs without you). */
    'meet.knocks': LobbyBoard;
    /** Someone just started waiting for you: the app notifies (the card in Nib's conversation comes too). */
    'meet.knocked': KnockView;
    /** Someone came into a meeting you organise while you are not in it. */
    'meet.joined': JoinedNotice;
  }
}

/** "Dana Wright (guest, name not verified)": how a knock names a person everywhere it is shown. */
export function knockWho(k: Pick<KnockView, 'name' | 'guest'>): string {
  return k.guest ? `${k.name} (guest, name not verified)` : k.name;
}
