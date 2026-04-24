/// <reference types="vite/client" />

import type { CodexDesktopApi } from '@shared/contracts';

declare global {
  interface Window {
    codexDesktop: CodexDesktopApi;
  }
}

export {};
