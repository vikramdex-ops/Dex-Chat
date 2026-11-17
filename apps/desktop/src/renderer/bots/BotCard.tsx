// What a message from an integration or a tool shows in the timeline (the message body
// renderer hands these messages here).
import type { Conversation, Message, PublicUser } from '@dex/core';
import { FlowCardView } from './FlowCard.tsx';
import { MiniAppCard } from './MiniAppCard.tsx';
import './bots.css';

export const isBotCard = (m: Pick<Message, 'botflow' | 'miniapp'>) => !!m.botflow || !!m.miniapp;

export function BotCard({ m, conv, meId, users }: { m: Message; conv: Conversation; meId: string; users: Map<string, PublicUser> }) {
  if (m.miniapp) {
    const me = users.get(meId);
    return me ? <MiniAppCard m={m} conv={conv} me={me} users={users} /> : null;
  }
  return m.botflow ? <FlowCardView m={m} meId={meId} users={users} /> : null;
}
