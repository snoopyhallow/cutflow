import { DemoTransport } from "./demoTransport";
import { HttpTransport } from "./httpTransport";
import type { StudioTransport } from "./types";

export * from "./types";
export * from "./desktopBridge";
export { DemoTransport } from "./demoTransport";
export { HttpTransport } from "./httpTransport";

export function createTransport(): StudioTransport {
  const isBrowser = typeof window !== "undefined";
  const queryDemo =
    isBrowser && new URLSearchParams(window.location.search).get("demo") === "1";
  const envDemo = import.meta.env.VITE_DEMO_MODE === "true";
  if (queryDemo || envDemo) {
    return new DemoTransport();
  }
  return new HttpTransport("/api/v1");
}
