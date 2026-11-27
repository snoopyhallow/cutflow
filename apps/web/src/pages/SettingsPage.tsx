import { useEffect, useState } from "react";
import {
  Cpu,
  FloppyDisk,
  Key,
  ShieldCheck,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { ProviderMark, TwitchIcon } from "../components/ui/BrandIcons";
import { SegmentedControl, StudioSelect } from "../components/ui/StudioControls";
import type { DoctorReport, StudioTransport } from "../transport";

export interface ModelRoutingState {
  active_provider: "gemini" | "anthropic" | "openai" | "groq" | "ollama";
  scan_model: string;
  editor_model: string;
  ollama_url?: string;
}

export interface IngestSettingsState {
  cookies_browser: string;
  concurrent_fragments: number;
}

interface SettingsPageProps {
  transport: StudioTransport;
  keysPresent: Record<string, boolean>;
  initialModels: ModelRoutingState;
  initialIngest?: IngestSettingsState;
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
    defaultModel: "gemini-3.5-flash-lite",
    secretKey: "gemini",
    hint: "Long-context highlight scan, Co-Editor & vision",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-4-5",
    secretKey: "anthropic",
    hint: "Claude Sonnet / Opus editorial reasoning",
  },
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    secretKey: "openai",
    hint: "GPT-4o / GPT-4.1 + Whisper API fallback",
  },
  {
    id: "groq",
    label: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    secretKey: "groq",
    hint: "Low-latency Llama 3.3 + Whisper v3 Turbo",
  },
  {
    id: "ollama",
    label: "Local Ollama",
    defaultModel: "qwen2.5:7b",
    hint: "100% offline local inference on 127.0.0.1:11434",
  },
];

const SECRET_KEYS = [
  { key: "gemini", label: "Google Gemini API Key" },
  { key: "anthropic", label: "Anthropic Claude API Key" },
  { key: "openai", label: "OpenAI API Key" },
  { key: "groq", label: "Groq Cloud API Key" },
];

export function SettingsPage({
  transport,
  keysPresent,
  initialModels,
  initialIngest = { cookies_browser: "none", concurrent_fragments: 8 },
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
  const [cookiesBrowser, setCookiesBrowser] = useState(initialIngest.cookies_browser || "none");
  const [concurrentFragments, setConcurrentFragments] = useState(
    String(initialIngest.concurrent_fragments || 8),
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
    setCookiesBrowser(initialIngest.cookies_browser || "none");
    setConcurrentFragments(String(initialIngest.concurrent_fragments || 8));
  }, [initialIngest]);

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
      setNotice(`Stored ${key} credential in OS Keyring.`);
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
      setNotice(`Removed ${key} credential from OS Keyring.`);
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
      setNotice(`Saved active model routing (${activeProvider}).`);
    } catch (err) {
      setNotice(
        `Could not save model routing: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleSaveIngest() {
    try {
      await transport.saveSettings({
        ingest: {
          cookies_browser: cookiesBrowser,
          concurrent_fragments: Number(concurrentFragments) || 8,
        },
      });
      await onRefresh();
      setNotice("Saved Twitch & VOD parallel ingest settings.");
    } catch (err) {
      setNotice(
        `Could not save ingest settings: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleSaveBoundaries() {
    try {
      await transport.saveSettings({
        export: { editor_boundaries: boundaries.trim() },
      });
      await onRefresh();
      setNotice("Saved global editorial guardrails.");
    } catch (err) {
      setNotice(
        `Could not save guardrails: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-4xl space-y-5">
        {notice && (
          <div className="rounded-md border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-3 py-2 text-xs text-[#FDE68A]">
            {notice}
          </div>
        )}

        {/* 1. Active Model Routing */}
        <section className="space-y-3 rounded-lg border border-[#222228] bg-[#111114] p-4">
          <div>
            <h1 className="flex items-center gap-2 text-sm font-semibold text-[#F4F4F5]">
              <SlidersHorizontal className="h-4 w-4 text-[#F59E0B]" />
              Model Provider &amp; Editorial Routing
            </h1>
            <p className="mt-0.5 text-xs text-[#A1A1AA]">
              Choose which LLM powers multi-slice highlight discovery, speaker framing, and the
              Co-Editor.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-5">
            {PROVIDERS.map((prov) => {
              const selected = activeProvider === prov.id;
              const ready =
                prov.id === "ollama"
                  ? true
                  : Boolean(prov.secretKey && keysPresent[prov.secretKey]);
              return (
                <button
                  key={prov.id}
                  type="button"
                  onClick={() => handleSelectProvider(prov.id)}
                  className={`rounded-md border p-2.5 text-left transition-colors ${
                    selected
                      ? "border-[#F59E0B] bg-[#18181C] text-[#F4F4F5]"
                      : "border-[#222228] bg-[#09090B] text-[#D4D4D8] hover:border-[#32323B]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                      <ProviderMark provider={prov.id} className="h-3.5 w-3.5" />
                      <span className="truncate">{prov.label.split(" ").pop()}</span>
                    </span>
                    <span
                      title={ready ? "Ready" : "Key not set"}
                      className={`h-2 w-2 rounded-full ${
                        ready ? "bg-[#22C55E]" : "bg-[#3F3F46]"
                      }`}
                    />
                  </div>
                  <div className="mt-1.5 line-clamp-2 text-[10px] text-[#71717A]">{prov.hint}</div>
                </button>
              );
            })}
          </div>

          <datalist id="cutflow-model-presets">
            <option value="gemini-3.5-flash-lite" />
            <option value="gemini-flash-lite-latest" />
            <option value="gemini-3.1-flash-lite" />
            <option value="gemma-4-26b-a4b-it" />
            <option value="claude-sonnet-4-5" />
            <option value="gpt-4o-mini" />
            <option value="llama-3.3-70b-versatile" />
            <option value="qwen2.5:7b" />
          </datalist>

          <div className="grid gap-3 pt-1 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-[#A1A1AA]">Highlight &amp; Act Scan Model</span>
              <input
                type="text"
                list="cutflow-model-presets"
                value={scanModel}
                onChange={(e) => setScanModel(e.target.value)}
                className="tabular-tc w-full rounded border border-[#222228] bg-[#09090B] px-2.5 py-1.5 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-[#A1A1AA]">Co-Editor &amp; Vision Model</span>
              <input
                type="text"
                list="cutflow-model-presets"
                value={editorModel}
                onChange={(e) => setEditorModel(e.target.value)}
                className="tabular-tc w-full rounded border border-[#222228] bg-[#09090B] px-2.5 py-1.5 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
              />
            </label>
          </div>

          {activeProvider === "ollama" && (
            <label className="block space-y-1 text-xs">
              <span className="text-[#A1A1AA]">Ollama Local Endpoint</span>
              <input
                type="text"
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
                className="tabular-tc w-full rounded border border-[#222228] bg-[#09090B] px-2.5 py-1.5 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
              />
            </label>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveModels()}
              className="inline-flex items-center gap-1.5 rounded bg-[#F59E0B] px-3 py-1.5 text-xs font-semibold text-[#09090B] hover:bg-[#FBBF24]"
            >
              <FloppyDisk weight="bold" className="h-3.5 w-3.5" />
              Save Routing
            </button>
          </div>
        </section>

        {/* 2. Twitch Long-VOD & Parallel HLS Ingest */}
        <section className="space-y-3 rounded-lg border border-[#222228] bg-[#111114] p-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#F4F4F5]">
              <TwitchIcon className="h-4 w-4 text-[#A970FF]" />
              Twitch VOD &amp; Parallel HLS Downloader
            </h2>
            <p className="mt-0.5 text-xs text-[#A1A1AA]">
              Accelerate multi-hour Twitch &amp; YouTube VOD downloads via concurrent HLS fragments,
              and optionally pass local browser cookies for subscriber-only broadcasts.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="mb-1 block text-xs text-[#A1A1AA]">
                Browser Cookies (Subscriber / Age-Gated VODs)
              </span>
              <StudioSelect
                value={cookiesBrowser}
                onChange={setCookiesBrowser}
                options={[
                  { value: "none", label: "Disabled (Public VODs Only)" },
                  { value: "chrome", label: "Google Chrome" },
                  { value: "edge", label: "Microsoft Edge" },
                  { value: "firefox", label: "Mozilla Firefox" },
                  { value: "brave", label: "Brave Browser" },
                ]}
              />
            </div>

            <div>
              <span className="mb-1 block text-xs text-[#A1A1AA]">
                Concurrent HLS Fragment Workers
              </span>
              <SegmentedControl
                value={concurrentFragments as "4" | "8" | "12" | "16"}
                onChange={(v) => setConcurrentFragments(v)}
                options={[
                  { value: "4", label: "4×" },
                  { value: "8", label: "8× (Default)" },
                  { value: "12", label: "12×" },
                  { value: "16", label: "16×" },
                ]}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveIngest()}
              className="inline-flex items-center gap-1.5 rounded border border-[#32323B] bg-[#18181C] px-3 py-1.5 text-xs font-medium text-[#F4F4F5] hover:border-[#F59E0B]/60"
            >
              <FloppyDisk className="h-3.5 w-3.5 text-[#F59E0B]" />
              Save Ingest Settings
            </button>
          </div>
        </section>

        {/* 3. Write-Only OS Keyring */}
        <section className="space-y-3 rounded-lg border border-[#222228] bg-[#111114] p-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#F4F4F5]">
              <Key className="h-4 w-4 text-[#F59E0B]" />
              OS Keyring Credentials (Write-Only)
            </h2>
            <p className="mt-0.5 text-xs text-[#A1A1AA]">
              API keys are stored in Windows Credential Manager / OS Keyring and are never echoed to
              the browser or SQLite.
            </p>
          </div>

          <div className="space-y-2">
            {SECRET_KEYS.map(({ key, label }) => {
              const isSet = Boolean(keysPresent[key]);
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#222228] bg-[#09090B] px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <ProviderMark provider={key} className="h-3.5 w-3.5" />
                    <div>
                      <div className="text-xs font-medium text-[#F4F4F5]">{label}</div>
                      <div className="text-[10px] text-[#71717A]">
                        Status:{" "}
                        <span className={isSet ? "text-[#4ADE80]" : "text-[#71717A]"}>
                          {isSet ? "Stored in OS Keyring" : "Not configured"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="password"
                      value={secretDrafts[key] ?? ""}
                      onChange={(e) =>
                        setSecretDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      placeholder="Paste API key..."
                      className="w-48 rounded border border-[#222228] bg-[#111114] px-2.5 py-1 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveSecret(key)}
                      className="rounded bg-[#F59E0B] px-2.5 py-1 text-xs font-semibold text-[#09090B] hover:bg-[#FBBF24]"
                    >
                      Save
                    </button>
                    {isSet && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteSecret(key)}
                        className="rounded border border-[#EF4444]/40 px-2 py-1 text-xs text-[#FCA5A5] hover:bg-[#EF4444]/15"
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

        {/* 4. Global Editorial Guardrails */}
        <section className="space-y-2.5 rounded-lg border border-[#222228] bg-[#111114] p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#F4F4F5]">
            <ShieldCheck className="h-4 w-4 text-[#22C55E]" />
            Global Editorial Guardrails
          </h2>
          <textarea
            rows={2}
            value={boundaries}
            onChange={(e) => setBoundaries(e.target.value)}
            placeholder="e.g. Preserve dramatic pauses in cinema clips; never cut punchlines..."
            className="w-full rounded border border-[#222228] bg-[#09090B] p-2.5 text-xs text-[#F4F4F5] focus:border-[#F59E0B] focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveBoundaries()}
              className="inline-flex items-center gap-1.5 rounded border border-[#32323B] bg-[#18181C] px-3 py-1.5 text-xs font-medium text-[#F4F4F5] hover:border-[#F59E0B]/60"
            >
              <FloppyDisk className="h-3.5 w-3.5 text-[#F59E0B]" />
              Save Guardrails
            </button>
          </div>
        </section>

        {/* 5. Hardware & Pipeline Doctor */}
        {doctor && (
          <section className="space-y-2.5 rounded-lg border border-[#222228] bg-[#111114] p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#F4F4F5]">
              <Cpu className="h-4 w-4 text-[#A1A1AA]" />
              Hardware &amp; Pipeline Diagnostics
            </h2>
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded border border-[#1E1E24] bg-[#09090B] p-2.5">
                <dt className="text-[10px] uppercase text-[#71717A]">Platform / Runtime</dt>
                <dd className="tabular-tc mt-0.5 text-[#F4F4F5]">
                  {doctor.platform} · Python {doctor.python}
                </dd>
              </div>
              <div className="rounded border border-[#1E1E24] bg-[#09090B] p-2.5">
                <dt className="text-[10px] uppercase text-[#71717A]">GPU / Hardware Encoder</dt>
                <dd className="mt-0.5 text-[#F4F4F5]">
                  {doctor.gpu}{" "}
                  <span className={doctor.nvencOk ? "text-[#4ADE80]" : "text-[#FBBF24]"}>
                    ({doctor.nvencOk ? "NVENC Ready" : "libx264 CPU"})
                  </span>
                </dd>
              </div>
              <div className="rounded border border-[#1E1E24] bg-[#09090B] p-2.5">
                <dt className="text-[10px] uppercase text-[#71717A]">Media Toolchain</dt>
                <dd className="tabular-tc mt-0.5 truncate text-[#F4F4F5]">
                  libass: {doctor.libass ? "OK" : "Missing"} · yt-dlp:{" "}
                  {doctor.ytDlp ? "OK" : "Missing"}
                </dd>
              </div>
              <div className="rounded border border-[#1E1E24] bg-[#09090B] p-2.5">
                <dt className="text-[10px] uppercase text-[#71717A]">Workspace Storage</dt>
                <dd className="tabular-tc mt-0.5 truncate text-[#F4F4F5]">
                  {doctor.freeGb} GB free · {doctor.dataRoot}
                </dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </div>
  );
}
