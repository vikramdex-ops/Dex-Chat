// End for everyone (docs/MEETINGS.md): a permanent control beside Leave for whoever may end the
// meeting (its host and co-hosts), in the Room's title block and on the folded Room's chip in the
// title bar, so it is reachable from every lens and panel tab. Always asked first. Hidden from
// people who cannot end it.
import type { RoomInfo } from '@dex/core';
import { useToast } from '../ui.tsx';
import { confirmAction } from '../confirm.tsx';

/** Host or co-host of this Room: the hub lets them end it (room.end). */
export const mayEnd = (room: RoomInfo, meId: string): boolean => !room.purpose && (room.hostId === meId || (room.coHosts ?? []).includes(meId));

export function askEndForEveryone(room: RoomInfo, toast: (text: string, error?: boolean) => void): void {
  void confirmAction({
    title: 'End the meeting for everyone?',
    body: 'Everyone leaves the Room and the meeting closes. To go without ending it, use Leave Room instead.',
    confirm: 'End for everyone', cancel: 'Keep it going', danger: true,
  }).then((ok) => {
    if (ok) void window.dex.request('room.end', { roomId: room.id }).catch((e: Error) => toast(e.message, true));
  });
}

export function EndForEveryone({ room, meId, className }: { room: RoomInfo; meId: string; className: string }) {
  const toast = useToast();
  if (!mayEnd(room, meId)) return null;
  return (
    <button className={className} onClick={() => askEndForEveryone(room, toast)} title="End the meeting for everyone: everyone leaves and it closes (you are asked first)">
      End for everyone
    </button>
  );
}
