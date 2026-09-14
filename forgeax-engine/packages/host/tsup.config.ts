import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    frontend: 'src/frontend.ts',
    backend: 'src/backend.ts',
    protocol: 'src/protocol.ts',
    transport: 'src/transport.ts',
  },
  external: ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@forgeax/engine-plugin'],
});
