import type { SVGProps } from "react";

export type BrandSvgProps = SVGProps<SVGSVGElement> & { title?: string };

/**
 * Custom geometric CutFlow Studio mark: precision frame aperture split by a razor diagonal cut.
 */
export function CutFlowLogo({ title: _title, ...props }: BrandSvgProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeOpacity="0.9"
      />
      <path
        d="M6.5 17.5L17.5 6.5"
        stroke="#F59E0B"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M7 7.5H12.5M11.5 16.5H17"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TwitchIcon({ title: _title, ...props }: BrandSvgProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M4.3 3L3 6.5v12.8h4.4V22h2.8l2.7-2.7h4.1L21 15.3V3H4.3zm14.8 11.4l-2.9 2.9h-4.7l-2.5 2.5v-2.5H5.2V4.9h13.9v9.5zM14.8 7.9h1.9v5.2h-1.9V7.9zm-4.9 0h1.9v5.2H9.9V7.9z" />
    </svg>
  );
}

export function YouTubeIcon({ title: _title, ...props }: BrandSvgProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5a2.7 2.7 0 0 0-1.9 1.9C2 8.9 2 12 2 12s0 3.1.4 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9c.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8zM10 15.2V8.8l5.5 3.2-5.5 3.2z" />
    </svg>
  );
}

export function KickIcon({ title: _title, ...props }: BrandSvgProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M4 4h5v6h2.2V7.2h2.6V4H19v5.5h-2.6v2.2h-2.2v.6h2.2v2.2H19V20h-5.2v-3.2h-2.6V14H9v6H4V4z" />
    </svg>
  );
}

export function TikTokIcon({ title: _title, ...props }: BrandSvgProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M16.6 5.8A4.3 4.3 0 0 1 15.3 3h-3.1v12.4a2.6 2.6 0 1 1-1.8-2.5V9.7a5.8 5.8 0 1 0 5 5.7V9.1a7.4 7.4 0 0 0 4.3 1.4V7.4a4.4 4.4 0 0 1-3.1-1.6z" />
    </svg>
  );
}

export function XBrandIcon({ title: _title, ...props }: BrandSvgProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M17.5 3h3.1l-6.8 7.8L21.8 21h-6.2l-4.9-6.4L5.1 21H2l7.3-8.4L1.6 3H8l4.4 5.8L17.5 3zm-1.1 16.1h1.7L7.1 4.8H5.3l11.1 14.3z" />
    </svg>
  );
}

export function GeminiIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2.5c.6 5.1 4.4 8.9 9.5 9.5-5.1.6-8.9 4.4-9.5 9.5-.6-5.1-4.4-8.9-9.5-9.5 5.1-.6 8.9-4.4 9.5-9.5z" />
    </svg>
  );
}

export function ClaudeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" {...props}>
      <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" strokeLinecap="round" />
    </svg>
  );
}

export function OpenAIIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <polygon points="12,6.4 16.8,14.8 7.2,14.8" strokeLinejoin="round" />
    </svg>
  );
}

export function GroqIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" {...props}>
      <path d="M15.5 8.5a5 5 0 1 0 0 7h-3.5v-3.5h5v4.5a7.5 7.5 0 1 1-1.2-9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function OllamaIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" {...props}>
      <rect x="5" y="7" width="14" height="12" rx="4" />
      <path d="M8 7V4.5a1.5 1.5 0 0 1 3 0V7m5 0V4.5a1.5 1.5 0 0 0-3 0V7" strokeLinecap="round" />
      <circle cx="9.5" cy="12.5" r="1" fill="currentColor" />
      <circle cx="14.5" cy="12.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function detectPlatformFromUrl(url: string | null | undefined): string {
  const lower = (url ?? "").toLowerCase();
  if (lower.includes("twitch.tv")) return "twitch";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  if (lower.includes("kick.com")) return "kick";
  if (lower.includes("tiktok.com")) return "tiktok";
  if (lower.includes("twitter.com") || lower.includes("x.com")) return "x";
  return lower ? "web" : "local";
}

export function PlatformMark({
  platform,
  className = "h-3.5 w-3.5",
}: {
  platform: string;
  className?: string;
}) {
  switch (platform) {
    case "twitch":
      return <TwitchIcon className={`${className} text-[#A970FF]`} />;
    case "youtube":
      return <YouTubeIcon className={`${className} text-[#FF4E45]`} />;
    case "kick":
      return <KickIcon className={`${className} text-[#53FC18]`} />;
    case "tiktok":
      return <TikTokIcon className={`${className} text-[#F4F4F5]`} />;
    case "x":
      return <XBrandIcon className={`${className} text-[#F4F4F5]`} />;
    default:
      return null;
  }
}

export function ProviderMark({
  provider,
  className = "h-3.5 w-3.5",
}: {
  provider: string;
  className?: string;
}) {
  switch (provider) {
    case "gemini":
      return <GeminiIcon className={`${className} text-[#60A5FA]`} />;
    case "anthropic":
      return <ClaudeIcon className={`${className} text-[#F59E0B]`} />;
    case "openai":
      return <OpenAIIcon className={`${className} text-[#E4E4E7]`} />;
    case "groq":
      return <GroqIcon className={`${className} text-[#F97316]`} />;
    default:
      return <OllamaIcon className={`${className} text-[#A1A1AA]`} />;
  }
}
