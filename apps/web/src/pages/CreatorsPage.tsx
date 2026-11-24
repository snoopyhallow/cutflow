import { useState, type FormEvent } from "react";
import { Check, Copy, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import type { CreatorProfile, StudioTransport } from "../transport";

interface CreatorsPageProps {
  transport: StudioTransport;
  profiles: CreatorProfile[];
  onCreated: () => Promise<void>;
}

export function CreatorsPage({
  transport,
  profiles,
  onCreated,
}: CreatorsPageProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [brief, setBrief] = useState("");
  const [layoutMode, setLayoutMode] = useState("auto_split");
  const [revealMode, setRevealMode] = useState("progressive");
  const [autoExport, setAutoExport] = useState(false);
  const [channelsRaw, setChannelsRaw] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openCreate() {
    setEditingId(null);
    setName("");
    setCreatorName("");
    setBrief("");
    setLayoutMode("auto_split");
    setRevealMode("progressive");
    setAutoExport(false);
    setChannelsRaw("");
    setError(null);
    setShowForm(true);
  }

  function openEdit(p: CreatorProfile) {
    setEditingId(p.id);
    setName(p.name);
    setCreatorName(p.creator_name);
    setBrief(p.brief);
    setLayoutMode(p.layout_mode);
    setRevealMode(p.reveal_mode);
    setAutoExport(p.auto_export);
    setChannelsRaw((p.channel_urls ?? []).join("\n"));
    setError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      const channels = channelsRaw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (editingId) {
        await transport.updateProfile(editingId, {
          name: name.trim(),
          creator_name: creatorName.trim(),
          brief: brief.trim(),
          layout_mode: layoutMode,
          reveal_mode: revealMode,
          auto_export: autoExport,
          channel_urls: channels,
        });
      } else {
        await transport.createProfile({
          name: name.trim(),
          creator_name: creatorName.trim(),
          brief: brief.trim(),
          layout_mode: layoutMode,
          reveal_mode: revealMode,
          channel_urls: channels,
        });
      }
      setShowForm(false);
      setEditingId(null);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(profileId: string) {
    setError(null);
    try {
      await transport.deleteProfile(profileId);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold">Creator Profiles &amp; Watch Folders</h1>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Drop VODs into a creator&apos;s local inbox folder for zero-copy NTFS hardlink ingest.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#6366F1] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#5558E6]"
          >
            <Plus className="h-3.5 w-3.5" />
            New Creator Profile
          </button>
        </div>

        {error && !showForm && (
          <div className="rounded-lg border border-[#F43F5E]/40 bg-[#F43F5E]/10 px-3 py-2 text-xs text-[#FECDD3]">
            {error}
          </div>
        )}

        {showForm && (
          <form
            onSubmit={(e) => void handleSubmit(e)}
            className="space-y-3 rounded-xl border border-[#6366F1]/40 bg-[#131720] p-4 text-xs"
          >
            <div className="text-xs font-semibold text-white">
              {editingId ? "Edit Creator Profile" : "Create Creator Profile"}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] text-[#94A3B8]">Profile Name</label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. IShowSpeed IRL Tour"
                  className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-white focus:border-[#6366F1] focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-[#94A3B8]">Creator Name</label>
                <input
                  value={creatorName}
                  onChange={(e) => setCreatorName(e.target.value)}
                  placeholder="e.g. IShowSpeed"
                  className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-white focus:border-[#6366F1] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[#94A3B8]">Editorial Brief</label>
              <textarea
                rows={2}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="What makes a clip viral for this creator or campaign?"
                className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-white focus:border-[#6366F1] focus:outline-none"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] text-[#94A3B8]">Framing Mode</label>
                <select
                  value={layoutMode}
                  onChange={(e) => setLayoutMode(e.target.value)}
                  className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-white"
                >
                  <option value="auto_split">Auto Split (Detect Facecam)</option>
                  <option value="split">Always Split Screen</option>
                  <option value="fit">Fit Full Frame</option>
                  <option value="centre">Center Crop 9:16</option>
                  <option value="auto_reframe">Auto Reframe Speaker</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-[#94A3B8]">
                  Subtitle Reveal Mode
                </label>
                <select
                  value={revealMode}
                  onChange={(e) => setRevealMode(e.target.value)}
                  className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-white"
                >
                  <option value="progressive">Progressive (word-by-word)</option>
                  <option value="group">Group (2-3 words)</option>
                  <option value="single_word">Single Word</option>
                </select>
              </div>
              <div className="flex items-end pb-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-[#CBD5E1]">
                  <input
                    type="checkbox"
                    checked={autoExport}
                    onChange={(e) => setAutoExport(e.target.checked)}
                    className="accent-[#6366F1]"
                  />
                  Auto-render Draft MP4s
                </label>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-[#94A3B8]">
                Followed Channel URLs for Smart Feed (one per line, optional)
              </label>
              <textarea
                rows={2}
                value={channelsRaw}
                onChange={(e) => setChannelsRaw(e.target.value)}
                placeholder="https://www.youtube.com/@creator/videos"
                className="w-full rounded border border-[#222836] bg-[#0B0D12] px-2.5 py-1.5 text-white focus:border-[#6366F1] focus:outline-none"
              />
            </div>

            {error && <p className="text-[#FDA4AF]">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
                className="rounded border border-[#222836] px-3 py-1.5 text-[#94A3B8] hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded bg-[#6366F1] px-3.5 py-1.5 font-medium text-white hover:bg-[#5558E6]"
              >
                {editingId ? "Save Changes" : "Create Profile"}
              </button>
            </div>
          </form>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {profiles.map((p) => {
            const hasPinnedCam = Boolean(
              (p as CreatorProfile & { cam_box?: unknown }).cam_box,
            );
            return (
              <div
                key={p.id}
                className="flex flex-col justify-between rounded-xl border border-[#222836] bg-[#131720] p-4"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="truncate text-sm font-semibold">{p.name}</h2>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="rounded bg-[#1A202C] px-2 py-0.5 text-[10px] text-[#94A3B8]">
                        {p.layout_mode} · {p.reveal_mode}
                      </span>
                      <button
                        type="button"
                        onClick={() => openEdit(p)}
                        title="Edit profile"
                        className="rounded p-1 text-[#94A3B8] hover:bg-[#1A202C] hover:text-white"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {profiles.length > 1 && (
                        <button
                          type="button"
                          onClick={() => void handleDelete(p.id)}
                          title="Delete profile"
                          className="rounded p-1 text-[#94A3B8] hover:bg-[#F43F5E]/15 hover:text-[#F43F5E]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs text-[#94A3B8]">
                    {p.brief || "No brief configured."}
                  </p>
                  {hasPinnedCam && (
                    <div className="mt-2 inline-flex items-center gap-1 rounded bg-[#10B981]/10 px-2 py-0.5 text-[10px] font-medium text-[#34D399]">
                      <Pin className="h-2.5 w-2.5" />
                      Webcam Box Pinned
                    </div>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 rounded bg-[#0B0D12] px-2.5 py-1.5">
                  <span className="tabular-tc truncate text-[11px] text-[#64748B]">
                    {p.inbox_path}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(p.inbox_path);
                      setCopiedId(p.id);
                      setTimeout(() => setCopiedId(null), 1500);
                    }}
                    className="shrink-0 text-[#94A3B8] hover:text-white"
                    title="Copy inbox folder path"
                  >
                    {copiedId === p.id ? (
                      <Check className="h-3.5 w-3.5 text-[#10B981]" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
