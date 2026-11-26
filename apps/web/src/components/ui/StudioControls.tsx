import { useEffect, useRef, useState, type ReactNode } from "react";

interface ScrubSliderProps {
  label?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  displayValue?: string;
  onChange: (next: number) => void;
  ariaLabel?: string;
  compact?: boolean;
}

/**
 * Precision Carbon studio slider replacing raw browser <input type="range">.
 */
export function ScrubSlider({
  label,
  value,
  min,
  max,
  step = 1,
  displayValue,
  onChange,
  ariaLabel,
  compact = false,
}: ScrubSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const clamped = Math.max(min, Math.min(max, value));
  const pct = max > min ? ((clamped - min) / (max - min)) * 100 : 0;

  function clientXToVal(clientX: number, el: HTMLElement): number {
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const raw = min + ratio * (max - min);
    const snapped = Math.round(raw / step) * step;
    const decimals = (String(step).split(".")[1] ?? "").length;
    return Number(Math.max(min, Math.min(max, snapped)).toFixed(decimals));
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = trackRef.current;
    if (!el) return;
    onChange(clientXToVal(e.clientX, el));

    function onMove(ev: PointerEvent) {
      if (!el) return;
      onChange(clientXToVal(ev.clientX, el));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(Math.max(min, Number((clamped - step).toFixed(4))));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(Math.min(max, Number((clamped + step).toFixed(4))));
    }
  }

  return (
    <div className={compact ? "flex items-center gap-2" : "space-y-1.5"}>
      {(label || displayValue) && !compact && (
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#A1A1AA]">{label}</span>
          {displayValue && (
            <span className="tabular-tc font-medium text-[#F4F4F5]">{displayValue}</span>
          )}
        </div>
      )}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel ?? label ?? "Slider"}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clamped}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        className={`group relative flex h-4 cursor-ew-resize items-center select-none focus:outline-none ${
          compact ? "w-24" : "w-full"
        }`}
      >
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#24242B]">
          <div
            className="h-full rounded-full bg-[#F59E0B] transition-[width] duration-75"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div
          className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-[#09090B] bg-[#F4F4F5] shadow-[0_0_0_1px_rgba(245,158,11,0.5)] transition-transform group-hover:scale-115 group-focus-visible:ring-2 group-focus-visible:ring-[#F59E0B]"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  );
}

interface ScrubNumberProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
}

/**
 * DaVinci/NLE-style scrubbable numeric input: drag label horizontally or type directly.
 */
export function ScrubNumber({
  label,
  value,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit = "",
  onChange,
}: ScrubNumberProps) {
  function startScrub(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const orig = value;

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const next = Math.max(min, Math.min(max, orig + Math.round(dx / 3) * step));
      onChange(next);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className="space-y-1">
      <div
        onPointerDown={startScrub}
        title="Drag horizontally to scrub value"
        className="flex cursor-ew-resize items-center justify-between text-[10px] text-[#A1A1AA] select-none hover:text-[#F4F4F5]"
      >
        <span>{label}</span>
        {unit && <span className="text-[#71717A]">{unit}</span>}
      </div>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          if (!Number.isNaN(parsed)) {
            onChange(Math.max(min, Math.min(max, parsed)));
          }
        }}
        className="tabular-tc w-full rounded-md border border-[#222228] bg-[#09090B] px-2 py-1 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
      />
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "sm",
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: "xs" | "sm";
}) {
  return (
    <div className="inline-flex w-full rounded-md border border-[#222228] bg-[#09090B] p-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={`flex-1 rounded-[5px] font-medium transition-colors ${
              size === "xs" ? "px-1.5 py-1 text-[10px]" : "px-2 py-1 text-[11px]"
            } ${
              active
                ? "bg-[#202026] text-[#F4F4F5] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                : "text-[#A1A1AA] hover:text-[#F4F4F5]"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Custom dark Carbon studio dropdown replacing native white-popup OS <select>.
 */
export function StudioSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (next: string) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    function onOutside(ev: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onOutside);
    return () => window.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-[#222228] bg-[#111114] px-2.5 py-1.5 text-left text-xs font-medium text-[#F4F4F5] transition-colors hover:border-[#32323B] focus:border-[#F59E0B] focus:outline-none"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <svg
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-[#71717A] transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-60 overflow-y-auto rounded-md border border-[#2C2C35] bg-[#141418] p-1 shadow-2xl">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                  active
                    ? "bg-[#F59E0B]/15 font-medium text-[#F4F4F5]"
                    : "text-[#D4D4D8] hover:bg-[#202026]"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{opt.label}</div>
                  {opt.hint && (
                    <div className="truncate text-[10px] text-[#71717A]">{opt.hint}</div>
                  )}
                </div>
                {active && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#F59E0B]" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StudioToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-[#D4D4D8]">{label}</div>
        {hint && <div className="text-[10px] text-[#71717A]">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-[18px] w-[32px] shrink-0 cursor-pointer items-center rounded-full border transition-colors ${
          checked
            ? "border-[#F59E0B]/60 bg-[#F59E0B]"
            : "border-[#2C2C35] bg-[#18181C]"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
            checked
              ? "translate-x-[14px] bg-[#09090B]"
              : "translate-x-[2px] bg-[#A1A1AA]"
          }`}
        />
      </button>
    </div>
  );
}
