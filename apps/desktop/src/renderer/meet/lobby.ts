// The lobby rules, named the same way everywhere they are chosen: the Meet lens, the Control room,
// the meeting dialog, the invitation block and a Room's meeting settings. Guests from a browser
// always wait, whatever the rule, so "off" is not "nobody waits" (docs/MEETINGS.md).
import type { LobbyRule } from '@dex/core';

export const LOBBY_RULES: Array<{ value: LobbyRule; label: string }> = [
  { value: 'outside', label: 'Guests and people from outside wait' },
  { value: 'everyone', label: 'Everyone waits to be let in' },
  { value: 'off', label: 'Only guests from a browser wait' },
];
export const lobbyLabel = (rule: LobbyRule): string => (LOBBY_RULES.find((r) => r.value === rule) ?? LOBBY_RULES[0]).label;
