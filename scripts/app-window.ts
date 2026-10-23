// One app window for tests: load it with tsx's tsImport() so every call gets its own
// module graph (store, sync engine, db connection) over the shared storage shims.
export { actions, state } from '../src/hooks/useStore';
export { bootSync, sync } from '../src/lib/sync-boot';
export * as syncLib from '../src/lib/sync';
export * as dbLib from '../src/lib/db';
