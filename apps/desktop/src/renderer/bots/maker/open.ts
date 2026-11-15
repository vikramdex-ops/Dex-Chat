// Open the bot maker from anywhere (it loads when first opened; BotMakerHost listens).
export type MakerSection = 'identity' | 'steps' | 'end' | 'track' | 'share' | 'json';
export interface MakerRequest { name?: string; admin?: { name?: string }; section?: MakerSection }
export const openBotMaker = (r: MakerRequest = {}) => window.dispatchEvent(new CustomEvent('dex-botmaker', { detail: r }));
