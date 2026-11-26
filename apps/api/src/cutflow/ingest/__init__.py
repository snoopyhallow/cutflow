"""Media ingestion subsystems: SSRF-checked yt-dlp, hardlink inbox watcher, Smart Feed."""

from .downloader import (
    DownloadedVideo,
    DownloadError,
    UnsupportedSiteError,
    build_ytdlp_download_argv,
    chapters_to_heatmap,
    detect_url_platform,
    download_video_url,
    fetch_url_metadata,
    find_ytdlp,
    probe_url_metadata,
)
from .feed import poll_all_feeds, poll_profile_feed
from .watcher import VIDEO_EXTENSIONS, InboxWatcher, ingest_local_file_to_media

__all__ = [
    "DownloadError",
    "DownloadedVideo",
    "InboxWatcher",
    "UnsupportedSiteError",
    "VIDEO_EXTENSIONS",
    "build_ytdlp_download_argv",
    "chapters_to_heatmap",
    "detect_url_platform",
    "download_video_url",
    "fetch_url_metadata",
    "find_ytdlp",
    "ingest_local_file_to_media",
    "poll_all_feeds",
    "poll_profile_feed",
    "probe_url_metadata",
]
