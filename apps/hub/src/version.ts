// The hub's own version. A release build stamps it (scripts/build.mjs --version 0.1.26111712 puts
// it in place of process.env.DEX_HUB_BUILD_VERSION), so the hub knows which build it is: the
// apps, the setup check, backups and the hub's own updates (hub-update.ts) all read it here.
// Run from source, it is the development version unless DEX_HUB_BUILD_VERSION says otherwise.
const DEV_VERSION = '0.1.0';
const stamped = process.env.DEX_HUB_BUILD_VERSION;

export const HUB_VERSION: string = typeof stamped === 'string' && /^\d+(\.\d+){1,3}$/.test(stamped) ? stamped : DEV_VERSION;
