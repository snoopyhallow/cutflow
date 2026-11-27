export interface CutFlowDesktopBridge {
  isDesktop: boolean;
  desktopToken?: string;
  platform?: string;
  appVersion?: string;
  openMediaDialog?: (opts?: {
    multiple?: boolean;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<string[]>;
  minimizeWindow?: () => void;
  toggleMaximizeWindow?: () => void;
  closeWindow?: () => void;
}

declare global {
  interface Window {
    cutflowDesktop?: CutFlowDesktopBridge;
  }
}

export function getDesktopBridge(): CutFlowDesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.cutflowDesktop?.isDesktop ? window.cutflowDesktop : null;
}
