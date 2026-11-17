// Open the bot network sheet or the job sheet from anywhere (they load when first opened; NetSheetsHost listens).
import type { BotJobSheet } from '@dex/core';

export const openBotNetwork = (scope: 'mine' | 'office' = 'mine') => window.dispatchEvent(new CustomEvent('dex-botnet', { detail: { scope } }));
export const openJobSheet = (scope: BotJobSheet['scope'] = 'mine', flow?: string) => window.dispatchEvent(new CustomEvent('dex-botjobs', { detail: { scope, flow } }));
