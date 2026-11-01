import type { EventChannel, InvokeChannel } from '../shared/ipc';

declare global {
  interface Window {
    api: {
      platform: NodeJS.Platform | string;
      invoke<T = unknown>(channel: InvokeChannel, ...args: unknown[]): Promise<T>;
      on(channel: EventChannel, cb: (payload: any) => void): () => void;
      pathForFile(file: File): string;
    };
  }
}
export {};