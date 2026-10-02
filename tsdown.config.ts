import { defineConfig } from 'tsdown'

/**
 * Bundle the plugin to the runtime entry the package.json exports point at
 * (lib/index.js). Peer and runtime dependencies stay external; the .d.ts
 * declarations come from `tsc` (see tsconfig.json).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  // tsc emits lib/types/*.d.ts first; a clean pass would wipe them.
  clean: false,
  // Keep the bundle at lib/index.js as package.json exports declare; newer
  // tsdown defaults to .mjs for node/esm.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/schemastery',
    '@qoder-ai/qoder-agent-sdk',
    'zod',
  ],
})
