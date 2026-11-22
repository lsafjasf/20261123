import { synthesizeFixture } from '../shared/fixtures.ts';
import type { AudioBufferData, StemId } from '../shared/types.ts';

// Browser entry point for the same deterministic demo signal used by the CLI.
export const synthesizeBrowserFixture = (): Partial<Record<StemId, AudioBufferData>> =>
  synthesizeFixture(24000, 6);
