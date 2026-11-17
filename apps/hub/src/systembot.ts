// The Dexterity Connect system bot: it writes to people in a Direct conversation about their own
// account (a device was added or removed, a role changed, guest access ending). It has no token,
// cannot be revoked like an integration, and posts only what the hub tells it to.
import type { Conversation, PublicUser } from '@dex/core';
import type { Messaging } from './messaging.ts';
import type { Store } from './store.ts';

export const SYSTEM_ACCOUNT = 'system\\dexterity-connect';

export class SystemBot {
  private readonly store: Store;
  private readonly messaging: Messaging;
  readonly id: string;

  constructor(store: Store, messaging: Messaging) {
    this.store = store;
    this.messaging = messaging;
    const existing = store.userByAccount(SYSTEM_ACCOUNT);
    this.id = existing?.id ?? store.createUser(SYSTEM_ACCOUNT, 'Dexterity Connect', 'bot').id;
  }

  get user(): PublicUser | null { return this.store.userById(this.id); }

  /** A Direct message to one person (never to guests' Spaces, never to other bots). */
  tell(userId: string, text: string, key: string): void {
    const bot = this.user;
    const to = this.store.userById(userId);
    if (!bot || !to || to.role === 'bot' || to.id === bot.id) return;
    try {
      const conv = this.messaging.handle('conv.create', bot, { kind: 'direct', members: [userId] }) as Conversation;
      this.messaging.sendAs(bot, this.messaging.memberConv(conv.id, bot.id), text, undefined, [], `sys-${key}`, {});
    } catch { /* a notice that cannot be posted is not worth failing the action that caused it */ }
  }
}
