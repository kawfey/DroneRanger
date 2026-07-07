export {};

declare global {
  interface Window {
    droneRanger?: Readonly<{
      platform: NodeJS.Platform;
      userDataPath: string;
      mapboxToken: string;
    }>;
    droneRangerTokenPrompt?: Readonly<{
      save: (token: string) => Promise<{ ok: boolean; error?: string }>;
    }>;
  }
}
