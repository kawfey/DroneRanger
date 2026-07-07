export {};

declare global {
  interface Window {
    droneRanger?: Readonly<{
      platform: NodeJS.Platform;
      userDataPath: string;
    }>;
  }
}
