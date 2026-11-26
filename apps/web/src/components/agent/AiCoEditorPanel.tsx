import { useState, type FormEvent } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  CircleNotch,
  PaperPlaneRight,
  ShieldCheck,
  TerminalWindow,
} from "@phosphor-icons/react";
import type { TimelineProject } from "../../edl";
import { useTimelineStore } from "../../state/timelineStore";
import type { StudioTransport } from "../../transport";

interface AiCoEditorPanelProps {
  transport: StudioTransport;
  projectId: string | null;
  initialBoundaries?: string;
}

interface ChatTurn {
  id: string;
  instruction: string;
  reply: string;
  applied: string[];
  provider: string;
  previousEdl: TimelineProject | null;
  reverted?: boolean;
}

const QUICK_COMMANDS = [
  "Tighten silence",
  "Neon glow captions",
  "1:1 square",
  "Single word captions",
];

export function AiCoEditorPanel({
  transport,
  projectId,
  initialBoundaries = "",
}: AiCoEditorPanelProps) {
  const { playheadMs, edl, applyAiPatchResult, commitEdl } = useTimelineStore();
  const [instruction, setInstruction] = useState("");
  const [boundaries, setBoundaries] = useState(initialBoundaries);
  const [showBoundaries, setShowBoundaries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);

  async function submitPrompt(rawText: string) {
    const cleaned = rawText.trim();
    if (!cleaned || busy || !edl) return;
    setError(null);
    setBusy(true);
    try {
      const targetId = projectId ?? edl.projectId;
      const res = await transport.runCoEditor(targetId, {
        instruction: cleaned,
        boundaries,
        playheadMs,
        saveBoundaries: showBoundaries,
      });

      if (res.applied.length > 0) {
        applyAiPatchResult(res.edl, res.applied);
      }
      setTurns((prev) => [
        {
          id: `turn_${Date.now().toString(36)}`,
          instruction: cleaned,
          reply: res.reply,
          applied: res.applied,
          provider: res.provider,
          previousEdl: res.applied.length > 0 ? res.previousEdl : null,
        },
        ...prev,
      ]);
      setInstruction("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    void submitPrompt(instruction);
  }

  function handleRevertTurn(turn: ChatTurn) {
    if (!turn.previousEdl) return;
    commitEdl(`Revert: ${turn.instruction.slice(0, 28)}`, turn.previousEdl);
    setTurns((prev) =>
      prev.map((t) => (t.id === turn.id ? { ...t, reverted: true } : t)),
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#111114]">
      {/* Persistent Edit Boundaries Drawer */}
      <div className="border-b border-[#222228] bg-[#0C0C0F] px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setShowBoundaries((v) => !v)}
          className="flex w-full items-center justify-between text-[11px] font-medium text-[#A1A1AA] hover:text-[#F4F4F5]"
        >
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-[#22C55E]" />
            Editorial Guardrails
          </span>
          {showBoundaries ? (
            <CaretUp className="h-3 w-3 text-[#71717A]" />
          ) : (
            <CaretDown className="h-3 w-3 text-[#71717A]" />
          )}
        </button>
        {showBoundaries && (
          <textarea
            rows={2}
            value={boundaries}
            onChange={(e) => setBoundaries(e.target.value)}
            placeholder="Rules obeyed on every edit (e.g. preserve dramatic pauses, never cut punchlines)..."
            className="mt-1.5 w-full rounded border border-[#222228] bg-[#09090B] p-1.5 text-[11px] text-[#F4F4F5] placeholder-[#71717A] focus:border-[#F59E0B] focus:outline-none"
          />
        )}
      </div>

      {/* Studio Macro Chips */}
      <div className="flex flex-wrap gap-1 border-b border-[#222228] p-2">
        {QUICK_COMMANDS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={busy}
            onClick={() => void submitPrompt(q)}
            className="rounded border border-[#222228] bg-[#09090B] px-2 py-0.5 text-[10px] font-medium text-[#D4D4D8] transition-colors hover:border-[#F59E0B]/50 hover:text-white disabled:opacity-45"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Patch Diff Log */}
      <div className="flex-1 space-y-2 overflow-y-auto p-2.5 text-xs">
        {error && (
          <div className="rounded border border-[#EF4444]/40 bg-[#EF4444]/10 px-2 py-1.5 text-[11px] text-[#FECACA]">
            {error}
          </div>
        )}

        {turns.length === 0 ? (
          <div className="rounded-md border border-[#1E1E24] bg-[#09090B]/60 p-4 text-center text-[11px] text-[#71717A]">
            <TerminalWindow className="mx-auto h-5 w-5 text-[#A1A1AA]" />
            <p className="mt-1.5 leading-relaxed">
              Issue timeline commands in plain English — cut ranges, switch to 1:1 neon glow, or
              retime captions. Every patch is undoable in 1 click.
            </p>
          </div>
        ) : (
          turns.map((turn) => (
            <div
              key={turn.id}
              className="space-y-1.5 rounded-md border border-[#222228] bg-[#09090B] p-2.5"
            >
              <div className="text-[11px] font-medium text-[#F4F4F5]">
                &ldquo;{turn.instruction}&rdquo;
              </div>
              <p className="text-[11px] text-[#A1A1AA]">{turn.reply}</p>

              {turn.applied.length > 0 && (
                <div className="space-y-1.5 rounded border border-[#2C2C35] bg-[#141418] p-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="tabular-tc font-semibold uppercase tracking-wider text-[#F59E0B]">
                      EDL PATCH · {turn.provider}
                    </span>
                    {turn.previousEdl && !turn.reverted ? (
                      <button
                        type="button"
                        onClick={() => handleRevertTurn(turn)}
                        className="inline-flex items-center gap-1 rounded border border-[#32323B] bg-[#1C1C22] px-1.5 py-0.5 text-[10px] font-medium text-[#F4F4F5] hover:bg-[#27272F]"
                      >
                        <ArrowCounterClockwise className="h-2.5 w-2.5" />
                        Revert
                      </button>
                    ) : turn.reverted ? (
                      <span className="text-[10px] text-[#71717A]">Reverted</span>
                    ) : null}
                  </div>
                  <ul className="tabular-tc space-y-0.5 text-[10px] text-[#4ADE80]">
                    {turn.applied.map((line, i) => (
                      <li key={i}>+ {line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Command Input */}
      <form
        onSubmit={handleFormSubmit}
        className="flex items-center gap-1.5 border-t border-[#222228] bg-[#0C0C0F] p-2"
      >
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Command: cut 4s to 7s, neon glow..."
          className="min-w-0 flex-1 rounded border border-[#222228] bg-[#09090B] px-2.5 py-1.5 text-xs text-[#F4F4F5] placeholder-[#71717A] focus:border-[#F59E0B] focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !instruction.trim()}
          aria-label="Run command"
          className="inline-flex items-center justify-center rounded bg-[#F59E0B] p-1.5 text-[#09090B] transition-colors hover:bg-[#FBBF24] disabled:opacity-40"
        >
          {busy ? (
            <CircleNotch className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PaperPlaneRight weight="fill" className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
    </div>
  );
}
