import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type ContextMenuEntry =
  | { divider: true }
  | {
      divider?: false;
      id: string;
      label: string;
      shortcut?: string;
      icon?: ReactNode;
      disabled?: boolean;
      tone?: "default" | "danger" | "ai";
      onSelect: () => void;
    };

export interface StudioContextMenuState {
  x: number;
  y: number;
  header?: string;
  items: ContextMenuEntry[];
}

interface StudioContextMenuProps {
  menu: StudioContextMenuState | null;
  onClose: () => void;
}

export function StudioContextMenu({ menu, onClose }: StudioContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number }>({
    left: menu?.x ?? 0,
    top: menu?.y ?? 0,
  });

  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const mw = el?.offsetWidth ?? 232;
    const mh = el?.offsetHeight ?? 260;
    const left = Math.max(8, Math.min(vw - mw - 8, menu.x));
    const top = Math.max(8, Math.min(vh - mh - 8, menu.y));
    setCoords({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onScroll() {
      onClose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onScroll, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onScroll);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
      className="fixed z-[120] min-w-[228px] max-w-[280px] select-none rounded-lg border border-[#2C2C38] bg-[#131318]/98 py-1 text-xs shadow-[0_18px_48px_rgba(0,0,0,0.85)] backdrop-blur-md"
    >
      {menu.header && (
        <div className="truncate border-b border-[#22222A] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#71717A]">
          {menu.header}
        </div>
      )}
      {menu.items.map((entry, idx) => {
        if ("divider" in entry && entry.divider) {
          return <div key={`div_${idx}`} className="my-1 h-px bg-[#22222A]" />;
        }
        const toneCls =
          entry.tone === "danger"
            ? "text-[#F87171] hover:bg-[#EF4444]/15 hover:text-[#FCA5A5]"
            : entry.tone === "ai"
              ? "text-[#FBBF24] hover:bg-[#F59E0B]/15 hover:text-[#FDE68A]"
              : "text-[#E4E4E7] hover:bg-[#22222C] hover:text-white";

        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              if (entry.disabled) return;
              onClose();
              entry.onSelect();
            }}
            className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${toneCls}`}
          >
            <span className="inline-flex min-w-0 items-center gap-2 truncate">
              {entry.icon && <span className="shrink-0 opacity-85">{entry.icon}</span>}
              <span className="truncate">{entry.label}</span>
            </span>
            {entry.shortcut && (
              <span className="tabular-tc shrink-0 text-[10px] text-[#71717A]">
                {entry.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
