import { useState, type FormEvent } from "react";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Loader2,
  RotateCcw,
  Send,
  ShieldCheck,
} from "lucide-react";
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

const QUICK_PROMPTS = [
  "Single word captions",
  "Cut 2s pause",
  "Remove cold open",
  "Insert 'SIU!' at playhead",
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
    commitEdl(`Revert AI: ${turn.instruction.slice(0, 28)}`, turn.previousEdl);
    setTurns((prev) =>
      prev.map((t) => (t.id === turn.id ? { ...t, reverted: true } : t)),
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Collapsible Persistent Edit Boundaries */}
      <div className="border-b border-[#222836] bg-[#0F131B] px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setShowBoundaries((v) => !v)}
          className="flex w-full items-center justify-between text-[11px] font-medium text-[#CBD5E1] hover:text-white"
        >
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-[#10B981]" />
            Edit Boundaries
          </span>
          {showBoundaries ? (
            <ChevronUp className="h-3.5 w-3.5 text-[#64748B]" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-[#64748B]" />
          )}
        </button>
        {showBoundaries && (
          <textarea
            rows={2}
            value={boundaries}
            onChange={(e) => setBoundaries(e.target.value)}
            placeholder="Rules the AI must always obey (e.g. never cut punchlines, keep white seam card)..."
            className="mt-1.5 w-full rounded border border-[#222836] bg-[#0B0D12] p-1.5 text-[11px] text-white placeholder-[#64748B] focus:border-[#6366F1] focus:outline-none"
          />
        )}
      </div>

      {/* Quick Prompt Chips */}
      <div className="flex flex-wrap gap-1 border-b border-[#222836] p-2">
        {QUICK_PROMPTS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={busy}
            onClick={() => void submitPrompt(q)}
            className="rounded-full border border-[#222836] bg-[#0B0D12] px-2 py-0.5 text-[10px] text-[#CBD5E1] hover:border-[#6366F1] hover:text-white disabled:opacity-45"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Patch Diff Feed */}
      <div className="flex-1 space-y-2 overflow-y-auto p-2 text-xs">
        {error && (
          <div className="rounded border border-[#F43F5E]/40 bg-[#F43F5E]/10 px-2 py-1.5 text-[11px] text-[#FECDD3]">
            {error}
          </div>
        )}

        {turns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#222836] p-4 text-center text-[11px] text-[#64748B]">
            <Bot className="mx-auto h-5 w-5 text-[#6366F1]" />
            <p className="mt-1.5">
              Ask the AI Co-Editor to cut pauses, tweak captions, or change the
              Seam Title Card. Every change applies optimistically with 1-click
              Revert.
            </p>
          </div>
        ) : (
          turns.map((turn) => (
            <div
              key={turn.id}
              className="space-y-1.5 rounded-lg border border-[#222836] bg-[#0B0D12] p-2.5"
            >
              <div className="text-[11px] font-medium text-white">
                &ldquo;{turn.instruction}&rdquo;
              </div>
              <p className="text-[11px] text-[#94A3B8]">{turn.reply}</p>

              {/* Compact Patch Diff Card */}
              {turn.applied.length > 0 && (
                <div className="space-y-1.5 rounded border border-[#6366F1]/35 bg-[#6366F1]/10 p-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-semibold uppercase tracking-wider text-[#A5B4FC]">
                      Patch Diff ({turn.provider})
                    </span>
                    {turn.previousEdl && !turn.reverted ? (
                      <button
                        type="button"
                        onClick={() => handleRevertTurn(turn)}
                        className="inline-flex items-center gap-1 rounded bg-[#1A202C] px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-[#2E374A]"
                      >
                        <RotateCcw className="h-2.5 w-2.5" />
                        Revert
                      </button>
                    ) : turn.reverted ? (
                      <span className="text-[10px] text-[#F59E0B]">Reverted</span>
                    ) : null}
                  </div>
                  <ul className="space-y-0.5 text-[11px] text-[#D1FAE5]">
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

      {/* Prompt Input Bar */}
      <form
        onSubmit={handleFormSubmit}
        className="flex items-center gap-1.5 border-t border-[#222836] bg-[#0F131B] p-2"
      >
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. cut 4s to 7s or change title..."
          className="min-w-0 flex-1 rounded border border-[#222836] bg-[#0B0D12] px-2 py-1.5 text-xs text-white placeholder-[#64748B] focus:border-[#6366F1] focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !instruction.trim()}
          aria-label="Send to AI Co-Editor"
          className="inline-flex items-center justify-center rounded bg-[#6366F1] p-1.5 text-white hover:bg-[#5558E6] disabled:opacity-45"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
    </div>
  );
}
