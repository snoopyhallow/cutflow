import { TimelineProjectSchema, type TimelineProject } from "../edl";
import type {
  ClipProjectSummary,
  ClipStatus,
  CoEditorRequest,
  CoEditorResponse,
  CreatorProfile,
  DoctorReport,
  ExportRequestOptions,
  ExportSummary,
  FeedItem,
  HealthResponse,
  IngestResult,
  JobProgressEvent,
  JobSummary,
  PostCopyResponse,
  ProfileCreateInput,
  ProjectPeaks,
  SettingsResponse,
  SourceSummary,
  StorageSummary,
  StudioTransport,
  TimelineResponse,
} from "./types";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(detail);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export class HttpTransport implements StudioTransport {
  readonly mode = "local" as const;

  constructor(private readonly baseUrl = "/api/v1") {}

  health(): Promise<HealthResponse> {
    return requestJson<HealthResponse>(`${this.baseUrl}/health`);
  }

  listProfiles(): Promise<CreatorProfile[]> {
    return requestJson<CreatorProfile[]>(`${this.baseUrl}/profiles`);
  }

  createProfile(input: ProfileCreateInput): Promise<CreatorProfile> {
    return requestJson<CreatorProfile>(`${this.baseUrl}/profiles`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listSources(): Promise<SourceSummary[]> {
    return requestJson<SourceSummary[]>(`${this.baseUrl}/sources`);
  }

  uploadVideo(file: File, profileId?: string): Promise<IngestResult> {
    const form = new FormData();
    form.append("file", file);
    if (profileId) form.append("profile_id", profileId);
    form.append("auto_clip", "true");
    return requestJson<IngestResult>(`${this.baseUrl}/sources/upload`, {
      method: "POST",
      body: form,
    });
  }

  ingestUrl(url: string, profileId?: string): Promise<IngestResult> {
    return requestJson<IngestResult>(`${this.baseUrl}/sources/url`, {
      method: "POST",
      body: JSON.stringify({ url, profileId, autoClip: true }),
    });
  }

  archiveSource(
    sourceId: string,
  ): Promise<{ sourceId: string; archived: boolean; reclaimedBytes: number }> {
    return requestJson(
      `${this.baseUrl}/sources/${encodeURIComponent(sourceId)}/archive`,
      { method: "POST" },
    );
  }

  getStorageSummary(): Promise<StorageSummary> {
    return requestJson<StorageSummary>(`${this.baseUrl}/storage`);
  }

  listJobs(): Promise<JobSummary[]> {
    return requestJson<JobSummary[]>(`${this.baseUrl}/jobs`);
  }

  subscribeJobEvents(
    jobId: string,
    onEvent: (evt: JobProgressEvent) => void,
  ): () => void {
    if (typeof EventSource === "undefined") {
      return () => undefined;
    }
    const source = new EventSource(
      `${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/events`,
    );
    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as JobProgressEvent;
        onEvent(parsed);
        if (parsed.status === "done" || parsed.status === "failed") {
          source.close();
        }
      } catch {
        // ignore malformed keepalives
      }
    };
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }

  listProjects(jobId?: string): Promise<ClipProjectSummary[]> {
    const qs = jobId ? `?job_id=${encodeURIComponent(jobId)}` : "";
    return requestJson<ClipProjectSummary[]>(`${this.baseUrl}/projects${qs}`);
  }

  async getTimeline(projectId: string): Promise<TimelineResponse> {
    const raw = await requestJson<{
      edl: unknown;
      totalDurationMs: number;
      sliceOriginMs?: number;
    }>(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/timeline`);
    return {
      edl: TimelineProjectSchema.parse(raw.edl),
      totalDurationMs: raw.totalDurationMs,
      sliceOriginMs: raw.sliceOriginMs ?? 0,
    };
  }

  async saveTimeline(
    projectId: string,
    edl: TimelineProject,
  ): Promise<TimelineResponse> {
    const validated = TimelineProjectSchema.parse(edl);
    const raw = await requestJson<{ edl: unknown; totalDurationMs: number }>(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/timeline`,
      {
        method: "PUT",
        body: JSON.stringify(validated),
      },
    );
    return {
      edl: TimelineProjectSchema.parse(raw.edl),
      totalDurationMs: raw.totalDurationMs,
    };
  }

  getProjectPeaks(projectId: string): Promise<ProjectPeaks> {
    return requestJson<ProjectPeaks>(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/peaks`,
    );
  }

  projectMediaUrl(projectId: string): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/media`;
  }

  projectThumbUrl(projectId: string): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/thumb`;
  }

  exportProject(
    projectId: string,
    opts?: ExportRequestOptions,
  ): Promise<ExportSummary> {
    return requestJson<ExportSummary>(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/export`,
      {
        method: "POST",
        body: JSON.stringify(opts ?? {}),
      },
    );
  }

  async runCoEditor(
    projectId: string,
    req: CoEditorRequest,
  ): Promise<CoEditorResponse> {
    const raw = await requestJson<CoEditorResponse>(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/coeditor`,
      {
        method: "POST",
        body: JSON.stringify(req),
      },
    );
    return {
      ...raw,
      edl: TimelineProjectSchema.parse(raw.edl),
      previousEdl: TimelineProjectSchema.parse(raw.previousEdl),
    };
  }

  updateProjectStatus(
    projectId: string,
    status: ClipStatus,
  ): Promise<ClipProjectSummary> {
    return requestJson<ClipProjectSummary>(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/status`,
      {
        method: "PATCH",
        body: JSON.stringify({ status }),
      },
    );
  }

  generatePostCopy(
    projectId: string,
    platform: "tiktok" | "shorts" | "reels" | "all" = "all",
  ): Promise<PostCopyResponse> {
    return requestJson<PostCopyResponse>(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/post-copy`,
      {
        method: "POST",
        body: JSON.stringify({ platform }),
      },
    );
  }

  listExports(projectId?: string): Promise<ExportSummary[]> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return requestJson<ExportSummary[]>(`${this.baseUrl}/exports${qs}`);
  }

  exportDownloadUrl(exportId: string): string {
    return `${this.baseUrl}/exports/${encodeURIComponent(exportId)}/download`;
  }

  async deleteExport(exportId: string): Promise<void> {
    await requestJson<void>(
      `${this.baseUrl}/exports/${encodeURIComponent(exportId)}`,
      { method: "DELETE" },
    );
  }

  scanInbox(profileId?: string): Promise<{ count: number }> {
    const qs = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : "";
    return requestJson<{ count: number }>(`${this.baseUrl}/inbox/scan${qs}`, {
      method: "POST",
    });
  }

  listFeed(): Promise<FeedItem[]> {
    return requestJson<FeedItem[]>(`${this.baseUrl}/feed`);
  }

  pollFeed(): Promise<{ count: number }> {
    return requestJson<{ count: number }>(`${this.baseUrl}/feed/poll`, {
      method: "POST",
    });
  }

  clipFeedItem(feedId: string): Promise<IngestResult> {
    return requestJson<IngestResult>(
      `${this.baseUrl}/feed/${encodeURIComponent(feedId)}/clip`,
      { method: "POST" },
    );
  }

  async dismissFeedItem(feedId: string): Promise<void> {
    await requestJson(
      `${this.baseUrl}/feed/${encodeURIComponent(feedId)}/dismiss`,
      { method: "POST" },
    );
  }

  getSettings(): Promise<SettingsResponse> {
    return requestJson<SettingsResponse>(`${this.baseUrl}/settings`);
  }

  saveSettings(patch: Record<string, unknown>): Promise<SettingsResponse> {
    return requestJson<SettingsResponse>(`${this.baseUrl}/settings`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }

  getDoctor(): Promise<DoctorReport> {
    return requestJson<DoctorReport>(`${this.baseUrl}/system/doctor`);
  }

  async setSecret(key: string, value: string): Promise<void> {
    await requestJson<void>(`${this.baseUrl}/settings/secrets`, {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
  }

  async deleteSecret(key: string): Promise<void> {
    await requestJson<void>(
      `${this.baseUrl}/settings/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
  }
}
