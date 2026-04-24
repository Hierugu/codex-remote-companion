import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const releaseChannel = process.env.CRC_RELEASE_CHANNEL ?? 'personal';
const buildDefines = {
  'process.env.CRC_RELEASE_CHANNEL': JSON.stringify(releaseChannel)
};

export default defineConfig({
  main: {
    define: buildDefines,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    define: buildDefines,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    define: buildDefines,
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
});
