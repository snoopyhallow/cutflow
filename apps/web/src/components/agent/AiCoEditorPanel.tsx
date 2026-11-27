import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  CircleNotch,
  Crosshair,
  PaperPlaneRight,
  ShieldCheck,
  Sparkle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { formatTimecodeMs, type TimelineProject } from "../../edl";
import { useTimelineStore } from "../../state/timelineStore";
import type { AiModelsResponse, StudioTransport } from "../../transport";

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
  modelUsed?: string;
  llmWarning?: string | null;
  previousEdl: TimelineProject | null;
  reverted?: boolean;
}

const QUICK_COMMANDS = [
  "Remove the hook",
  "Tighten silence",
  "Speed up 1.5x",
  "Mute voice",
  "Neon glow captions",
  "1:1 square",
];

const DEFAULT_FALLBACK_MODELS: Record<string, string[]> = {
  gemini: [
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.1-flash-lite",
    "gemma-4-26b-a4b-it",
  ],
  anthropic: ["claude-sonnet-4-5", "claude-3-5-haiku-latest"],
  openai: ["gpt-4o-mini", "gpt-4.1-mini"],
  groq: ["llama-3.3-70b-versatile"],
  ollama: ["qwen2.5:7b", "llama3.1:8b"],
};

export function AiCoEditorPanel({
  transport,
  projectId,
  initialBoundaries = "",
}: AiCoEditorPanelProps) {
  const {
    playheadMs,
    edl,
    selectedClipId,
    selectedOverlayId,
    selectedWordId,
    inPointMs,
    outPointMs,
    aiSelectionPromptLabel,
    clearAiSelectionPrompt,
    applyAiPatchResult,
    commitEdl,
  } = useTimelineStore();

  const [instruction, setInstruction] = useState("");
  const [boundaries, setBoundaries] = useState(initialBoundaries);
  const [showBoundaries, setShowBoundaries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);

  const [modelsInfo, setModelsInfo] = useState<AiModelsResponse | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>("gemini");
  const [selectedModel, setSelectedModel] = useState<string>("gemini-3.5-flash-lite");
  const [scopeToSelection, setScopeToSelection] = useState<boolean>(true);

  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    transport
      .listAiModels()
      .then((info) => {
        if (!active) return;
        setModelsInfo(info);
        const prov = info.activeProvider || "gemini";
        setSelectedProvider(prov);
        const providerModels =
          info.modelsByProvider?.[prov] ?? DEFAULT_FALLBACK_MODELS[prov] ?? [];
        const preferred =
          info.editorModel && providerModels.includes(info.editorModel)
            ? info.editorModel
            : providerModels[0] || info.editorModel || "gemini-3.5-flash-lite";
        setSelectedModel(preferred);
      })
      .catch(() => {
        /* keep local defaults */
      });
    return () => {
      active = false;
    };
  }, [transport]);

  // Focus input when user right-clicks an item -> "Ask AI on Selection..."
  useEffect(() => {
    if (aiSelectionPromptLabel) {
      setScopeToSelection(true);
      inputRef.current?.focus();
    }
  }, [aiSelectionPromptLabel]);

  const availableModels = useMemo(() => {
    const fromBackend = modelsInfo?.modelsByProvider?.[selectedProvider];
    const list =
      fromBackend && fromBackend.length > 0
        ? fromBackend
        : DEFAULT_FALLBACK_MODELS[selectedProvider] ?? [];
    if (selectedModel && !list.includes(selectedModel)) {
      return [selectedModel, ...list];
    }
    return list;
  }, [modelsInfo, selectedProvider, selectedModel]);

  const activeSelectionSummary = useMemo(() => {
    if (!edl || !scopeToSelection) return null;
    if (aiSelectionPromptLabel) return aiSelectionPromptLabel;
    if (selectedOverlayId) {
      const ov = edl.tracks.overlays.find((o) => o.id === selectedOverlayId);
      if (ov) return `Overlay "${ov.text.slice(0, 24)}"`;
    }
    if (selectedWordId) {
      const w = edl.tracks.subtitles.words.find((x) => x.id === selectedWordId);
      if (w) return `Caption "${w.text}"`;
    }
    if (inPointMs !== null && outPointMs !== null) {
      return `Range ${formatTimecodeMs(Math.min(inPointMs, outPointMs))}–${formatTimecodeMs(Math.max(inPointMs, outPointMs))}`;
    }
    if (selectedClipId) {
      const idx = edl.tracks.video.clips.findIndex((c) => c.id === selectedClipId);
      if (idx >= 0) {
        const clip = edl.tracks.video.clips[idx];
        return clip.label ? `Clip "${clip.label}"` : `Scene ${idx + 1}`;
      }
    }
    return null;
  }, [
    edl,
    scopeToSelection,
    aiSelectionPromptLabel,
    selectedOverlayId,
    selectedWordId,
    inPointMs,
    outPointMs,
    selectedClipId,
  ]);

  const providerReady = useMemo(() => {
    if (!modelsInfo) return transport.mode === "demo";
    if (selectedProvider === "ollama") return modelsInfo.ollamaOnline;
    return Boolean(modelsInfo.keysPresent?.[selectedProvider]);
  }, [modelsInfo, selectedProvider, transport.mode]);

  function handleProviderChange(nextProv: string) {
    setSelectedProvider(nextProv);
    const list =
      modelsInfo?.modelsByProvider?.[nextProv] ??
      DEFAULT_FALLBACK_MODELS[nextProv] ??
      [];
    if (list.length > 0) {
      setSelectedModel(list[0]);
    }
  }

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
        provider: selectedProvider,
        model: selectedModel,
        selection: scopeToSelection
          ? {
              selectedClipId,
              selectedOverlayId,
              selectedWordId,
              inPointMs,
              outPointMs,
            }
          : undefined,
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
          modelUsed: res.modelUsed,
          llmWarning: res.llmWarning,
          previousEdl: res.applied.length > 0 ? res.previousEdl : null,
        },
        ...prev,
      ]);
      setInstruction("");
      clearAiSelectionPrompt();
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
      {/* Live Model Selector Bar */}
      <div className="flex items-center gap-1.5 border-b border-[#222228] bg-[#0C0C0F] px-2.5 py-1.5">
        <span
          title={
            providerReady
              ? `${selectedProvider} API ready`
              : `${selectedProvider} key not configured (offline rules still work)`
          }
          className={`h-2 w-2 shrink-0 rounded-full ${
            providerReady ? "bg-[#22C55E]" : "bg-[#F59E0B]"
          }`}
        />
        <select
          aria-label="AI Provider"
          value={selectedProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="rounded border border-[#25252E] bg-[#141419] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#E4E4E7] focus:border-[#F59E0B] focus:outline-none"
        >
          <option value="gemini">Gemini</option>
          <option value="anthropic">Claude</option>
          <option value="openai">OpenAI</option>
          <option value="groq">Groq</option>
          <option value="ollama">Ollama</option>
        </select>

        <select
          aria-label="AI Model"
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="tabular-tc min-w-0 flex-1 truncate rounded border border-[#25252E] bg-[#141419] px-1.5 py-0.5 text-[10px] text-[#D4D4D8] focus:border-[#F59E0B] focus:outline-none"
        >
          {availableModels.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/* Persistent Edit Boundaries Drawer */}
      <div className="border-b border-[#222228] bg-[#0E0E12] px-2.5 py-1.5">
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

      {/* Studio Quick Action Chips */}
      <div className="flex flex-wrap gap-1 border-b border-[#222228] p-2">
        {QUICK_COMMANDS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={busy}
            onClick={() => void submitPrompt(q)}
            className="rounded border border-[#24242C] bg-[#09090B] px-2 py-0.5 text-[10px] font-medium text-[#D4D4D8] transition-colors hover:border-[#F59E0B]/50 hover:text-white disabled:opacity-45"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Conversational Patch Diff Log */}
      <div className="flex-1 space-y-2 overflow-y-auto p-2.5 text-xs">
        {error && (
          <div className="rounded border border-[#EF4444]/40 bg-[#EF4444]/10 px-2 py-1.5 text-[11px] text-[#FECACA]">
            {error}
          </div>
        )}

        {turns.length === 0 ? (
          <div className="rounded-md border border-[#1E1E24] bg-[#09090B]/60 p-4 text-center text-[11px] text-[#71717A]">
            <Sparkle className="mx-auto h-5 w-5 text-[#F59E0B]" />
            <p className="mt-1.5 leading-relaxed text-[#A1A1AA]">
              Ask the AI Co-Editor to remove hooks/overlays, adjust audio dB, speed up clips,
              cut dead air, or restyle captions. Right-click any clip or overlay to target it.
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
              <p className="text-[11px] leading-relaxed text-[#A1A1AA]">
                {turn.reply}
              </p>

              {turn.llmWarning && (
                <div className="flex items-start gap-1.5 rounded border border-[#F59E0B]/35 bg-[#F59E0B]/10 px-2 py-1 text-[10px] text-[#FDE68A]">
                  <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#F59E0B]" />
                  <span>{turn.llmWarning}</span>
                </div>
              )}

              {turn.applied.length > 0 && (
                <div className="space-y-1.5 rounded border border-[#2C2C35] bg-[#141418] p-2">
                  <div className="flex items-center justify-between gap-1 text-[10px]">
                    <span className="tabular-tc truncate font-semibold uppercase tracking-wider text-[#F59E0B]">
                      PATCH · {turn.modelUsed || turn.provider}
                    </span>
                    {turn.previousEdl && !turn.reverted ? (
                      <button
                        type="button"
                        onClick={() => handleRevertTurn(turn)}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-[#32323B] bg-[#1C1C22] px-1.5 py-0.5 text-[10px] font-medium text-[#F4F4F5] hover:bg-[#27272F]"
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

      {/* Active Selection Scope Badge */}
      {activeSelectionSummary && (
        <div className="flex items-center justify-between border-t border-[#222228] bg-[#15130E] px-2.5 py-1 text-[10px] text-[#FDE68A]">
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <Crosshair className="h-3 w-3 shrink-0 text-[#F59E0B]" />
            <span className="truncate">Scope: {activeSelectionSummary}</span>
          </span>
          <button
            type="button"
            title="Clear selection scope"
            onClick={() => {
              clearAiSelectionPrompt();
              setScopeToSelection(false);
            }}
            className="ml-1 text-[#A1A1AA] hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Command Input */}
      <form
        onSubmit={handleFormSubmit}
        className="flex items-center gap-1.5 border-t border-[#222228] bg-[#0C0C0F] p-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Ask AI: remove hook, mute voice, speed 1.5x..."
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
