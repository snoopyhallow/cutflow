import { useEffect, useState } from "react";
import { Bot, Cpu, KeyRound, Save, ShieldCheck } from "lucide-react";
import type { DoctorReport, StudioTransport } from "../transport";

export interface ModelRoutingState {
  active_provider: "gemini" | "anthropic" | "openai" | "groq" | "ollama";
  scan_model: string;
  editor_model: string;
  ollama_url?: string;
}

interface SettingsPageProps {
  transport: StudioTransport;
  keysPresent: Record<string, boolean>;
  initialModels: ModelRoutingState;
  initialBoundaries: string;
  onRefresh: () => Promise<void>;
}

const PROVIDERS: {
  id: ModelRoutingState["active_provider"];
  label: string;
  defaultModel: string;
  secretKey?: string;
  hint: string;
}[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    secretKey: "gemini",
    hint: "Fast highlight discovery, Co-Editor & webcam vision",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-4-5",
    secretKey: "anthropic",
    hint: "Claude Sonnet / Opus / Haiku via Messages API",
  },
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    secretKey: "openai",
    hint: "GPT-4o / GPT-4.1 + Whisper fallback",
  },
  {
    id: "groq",
    label: "Groq Cloud",
    defaultModel: "llama-3.3-70b-versatile",
    secretKey: "groq",
    hint: "Ultra-fast Llama 3.3 + Whisper Large v3 Turbo",
  },
  {
    id: "ollama",
    label: "Local Ollama",
    defaultModel: "qwen2.5:7b",
    hint: "100% offline local LLM on 127.0.0.1:11434 (no key needed)",
  },
];

const SECRET_KEYS = [
  { key: "gemini", label: "Google Gemini API Key" },
  { key: "anthropic", label: "Anthropic (Claude) API Key" },
  { key: "openai", label: "OpenAI API Key" },
  { key: "groq", label: "Groq (Whisper + Llama) API Key" },
];

export function SettingsPage({
  transport,
  keysPresent,
  initialModels,
  initialBoundaries,
  onRefresh,
}: SettingsPageProps) {
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [activeProvider, setActiveProvider] = useState<ModelRoutingState["active_provider"]>(
    initialModels.active_provider,
  );
  const [scanModel, setScanModel] = useState(initialModels.scan_model);
  const [editorModel, setEditorModel] = useState(initialModels.editor_model);
  const [ollamaUrl, setOllamaUrl] = useState(
    initialModels.ollama_url || "http://127.0.0.1:11434",
  );
  const [boundaries, setBoundaries] = useState(initialBoundaries);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setActiveProvider(initialModels.active_provider);
    setScanModel(initialModels.scan_model);
    setEditorModel(initialModels.editor_model);
    if (initialModels.ollama_url) setOllamaUrl(initialModels.ollama_url);
  }, [initialModels]);

  useEffect(() => {
    setBoundaries(initialBoundaries);
  }, [initialBoundaries]);

  useEffect(() => {
    void transport
      .getDoctor()
      .then(setDoctor)
      .catch(() => setDoctor(null));
  }, [transport]);

  async function handleSaveSecret(key: string) {
    const val = (secretDrafts[key] ?? "").trim();
    if (!val) return;
    try {
      await transport.setSecret(key, val);
      setSecretDrafts((prev) => ({ ...prev, [key]: "" }));
      await onRefresh();
      setNotice(`Saved ${key} key securely in OS Keyring.`);
    } catch (err) {
      setNotice(
        `Could not save secret: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleDeleteSecret(key: string) {
    try {
      await transport.deleteSecret(key);
      await onRefresh();
      setNotice(`Removed ${key} from OS Keyring.`);
    } catch (err) {
      setNotice(
        `Could not remove secret: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function handleSelectProvider(nextProvider: ModelRoutingState["active_provider"]) {
    setActiveProvider(nextProvider);
    const preset = PROVIDERS.find((p) => p.id === nextProvider);
    if (preset) {
      setScanModel(preset.defaultModel);
      setEditorModel(preset.defaultModel);
    }
  }

  async function handleSaveModels() {
    try {
      await transport.saveSettings({
        models: {
          active_provider: activeProvider,
          scan_model: scanModel.trim(),
          editor_model: editorModel.trim(),
          providers: {
            ollama: {
              model: activeProvider === "ollama" ? scanModel.trim() : "qwen2.5:7b",
              base_url: ollamaUrl.trim() || "http://127.0.0.1:11434",
            },
          },
        },
      });
      await onRefresh();
      setNotice(`Saved active AI provider (${activeProvider}) & model routing.`);
    } catch (err) {
      setNotice(
        `Could not save AI routing: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleSaveBoundaries() {
    try {
      await transport.saveSettings({
        export: { editor_boundaries: boundaries.trim() },
      });
      await onRefresh();
      setNotice("Saved global default Edit Boundaries.");
    } catch (err) {
      setNotice(
        `Could not save boundaries: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-4xl space-y-6">
        {notice && (
          <div className="rounded-lg border border-[#6366F1]/40 bg-[#6366F1]/10 px-3 py-2 text-xs text-[#E0E7FF]">
            {notice}
          </div>
        )}

        {/* Active AI Provider & Model Routing */}
        <section className="space-y-3 rounded-xl border border-[#222836] bg-[#131720] p-4">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold">
              <Bot className="h-4 w-4 text-[#6366F1]" />
              Active AI Provider &amp; Model Routing
            </h1>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Freely choose which AI provider powers Highlight Discovery, Webcam Vision, and the AI
              Co-Editor. Paste its API key below and click Save — CutFlow also auto-detects any
              configured key automatically.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-5">
            {PROVIDERS.map((prov) => {
              const selected = activeProvider === prov.id;
              const ready =
                prov.id === "ollama" ? true : Boolean(prov.secretKey && keysPresent[prov.secretKey]);
              return (
                <button
                  key={prov.id}
                  type="button"
                  onClick={() => handleSelectProvider(prov.id)}
                  className={`rounded-lg border p-2.5 text-left transition-colors ${
                    selected
                      ? "border-[#6366F1] bg-[#6366F1]/15 text-white"
                      : "border-[#222836] bg-[#0B0D12] text-[#CBD5E1] hover:border-[#334155]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-semibold">{prov.label}</span>
                    <span
                      title={ready ? "Ready" : "API key not set yet"}
                      className={`h-2 w-2 rounded-full ${
                        ready ? "bg-[#10B981]" : "bg-[#475569]"
                      }`}
                    />
                  </div>
                  <div className="mt-1 line-clamp-2 text-[10px] text-[#94A3B8]">{prov.hint}</div>
                </button>
              );
            })}
          </div>

          <div className="grid gap-3 pt-1 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-[#94A3B8]">Highlight Scan Model</span>
              <input
                type="text"
                value={scanModel}
                onChange={(e) => setScanModel(e.target.value)}
                placeholder="e.g. gemini-2.5-flash or claude-sonnet-4-5"
                className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-xs text-white focus:border-[#6366F1] focus:outline-none"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-[#94A3B8]">AI Co-Editor &amp; Vision Model</span>
              <input
                type="text"
                value={editorModel}
                onChange={(e) => setEditorModel(e.target.value)}
                placeholder="e.g. gemini-2.5-flash or claude-sonnet-4-5"
                className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-xs text-white focus:border-[#6366F1] focus:outline-none"
              />
            </label>
          </div>

          {activeProvider === "ollama" && (
            <label className="block space-y-1 text-xs">
              <span className="text-[#94A3B8]">Ollama Local Server URL</span>
              <input
                type="text"
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
                placeholder="http://127.0.0.1:11434"
                className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-xs text-white focus:border-[#6366F1] focus:outline-none"
              />
            </label>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveModels()}
              className="inline-flex items-center gap-1.5 rounded bg-[#6366F1] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5558E6]"
            >
              <Save className="h-3.5 w-3.5" />
              Save AI Provider &amp; Models
            </button>
          </div>
        </section>

        {/* Write-Only Keyring Secrets */}
        <section className="space-y-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <KeyRound className="h-4 w-4 text-[#6366F1]" />
              Write-Only OS Keyring Secrets
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              API keys are written directly to Windows Credential Manager / OS Keyring and are
              never returned to the browser or stored in SQLite.
            </p>
          </div>

          <div className="space-y-2.5">
            {SECRET_KEYS.map(({ key, label }) => {
              const isSet = Boolean(keysPresent[key]);
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#222836] bg-[#131720] p-3"
                >
                  <div>
                    <div className="text-xs font-medium">{label}</div>
                    <div className="text-[11px] text-[#94A3B8]">
                      Status:{" "}
                      <span className={isSet ? "text-[#10B981]" : "text-[#64748B]"}>
                        {isSet ? "Configured in OS Keyring" : "Not set"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={secretDrafts[key] ?? ""}
                      onChange={(e) =>
                        setSecretDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      placeholder="Paste new key..."
                      className="w-48 rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1 text-xs text-white focus:border-[#6366F1] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveSecret(key)}
                      className="rounded bg-[#6366F1] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#5558E6]"
                    >
                      Save
                    </button>
                    {isSet && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteSecret(key)}
                        className="rounded border border-[#F43F5E]/40 px-2 py-1 text-xs text-[#FDA4AF] hover:bg-[#F43F5E]/15"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Global Default Edit Boundaries */}
        <section className="space-y-2 rounded-xl border border-[#222836] bg-[#131720] p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="h-4 w-4 text-[#10B981]" />
            Global AI Co-Editor Boundaries
          </h2>
          <p className="text-xs text-[#94A3B8]">
            Persistent editorial guardrails obeyed by CutFlow&apos;s AI Co-Editor across clips.
          </p>
          <textarea
            rows={3}
            value={boundaries}
            onChange={(e) => setBoundaries(e.target.value)}
            placeholder="e.g. Never remove punchlines, keep profanity filter enabled, preserve white seam card..."
            className="w-full rounded border border-[#222836] bg-[#0B0D12] p-2.5 text-xs text-white focus:border-[#6366F1] focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveBoundaries()}
              className="inline-flex items-center gap-1.5 rounded bg-[#6366F1] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5558E6]"
            >
              <Save className="h-3.5 w-3.5" />
              Save Boundaries
            </button>
          </div>
        </section>

        {/* Hardware & Environment Doctor */}
        {doctor && (
          <section className="space-y-2.5 rounded-xl border border-[#222836] bg-[#131720] p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Cpu className="h-4 w-4 text-[#38BDF8]" />
              Hardware &amp; Pipeline Doctor
            </h2>
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded bg-[#0B0D12] p-2.5">
                <dt className="text-[10px] uppercase text-[#64748B]">Platform / Python</dt>
                <dd className="tabular-tc mt-0.5 text-white">
                  {doctor.platform} · Python {doctor.python}
                </dd>
              </div>
              <div className="rounded bg-[#0B0D12] p-2.5">
                <dt className="text-[10px] uppercase text-[#64748B]">GPU / NVENC Status</dt>
                <dd className="mt-0.5 text-white">
                  {doctor.gpu}{" "}
                  <span
                    className={
                      doctor.nvencOk ? "text-[#10B981]" : "text-[#F59E0B]"
                    }
                  >
                    ({doctor.nvencOk ? "NVENC OK" : "CPU libx264 Fallback"})
                  </span>
                </dd>
              </div>
              <div className="rounded bg-[#0B0D12] p-2.5">
                <dt className="text-[10px] uppercase text-[#64748B]">FFmpeg / libass / yt-dlp</dt>
                <dd className="mt-0.5 truncate text-white">
                  libass: {doctor.libass ? "OK" : "Missing"} · yt-dlp:{" "}
                  {doctor.ytDlp ? "OK" : "Missing"}
                </dd>
              </div>
              <div className="rounded bg-[#0B0D12] p-2.5">
                <dt className="text-[10px] uppercase text-[#64748B]">Storage &amp; Inbox</dt>
                <dd className="tabular-tc mt-0.5 truncate text-white">
                  {doctor.freeGb} GB free · {doctor.dataRoot}
                </dd>
              </div>
            </dl>
            {!doctor.nvencOk && (
              <p className="rounded border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2 text-[11px] text-[#FDE68A]">
                NVENC Diagnostic: {doctor.nvencDetail}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
