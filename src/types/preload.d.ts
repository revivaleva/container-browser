export {};

declare global {
  interface Window {
    appAPI: {
      checkForUpdates: () => Promise<void>;
    };
    containersAPI: any;
  }
}


