import { useEffect, useState } from "react";
import { Cpu, KeyRound, Save, ShieldCheck } from "lucide-react";
import type { DoctorReport, StudioTransport } from "../transport";

interface SettingsPageProps {
  transport: StudioTransport;
  keysPresent: Record<string, boolean>;
  initialBoundaries: string;
  onRefresh: () => Promise<void>;
}

const SECRET_KEYS = [
  { key: "gemini", label: "Google Gemini API Key" },
  { key: "groq", label: "Groq Whisper API Key" },
  { key: "openai", label: "OpenAI API Key" },
  { key: "anthropic", label: "Anthropic API Key" },
];

export function SettingsPage({
  transport,
  keysPresent,
  initialBoundaries,
  onRefresh,
}: SettingsPageProps) {
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [boundaries, setBoundaries] = useState(initialBoundaries);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [notice, setNotice] = useState("");

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

        {/* Write-Only Keyring Secrets */}
        <section className="space-y-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold">
              <KeyRound className="h-4 w-4 text-[#6366F1]" />
              Write-Only OS Keyring Secrets
            </h1>
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
