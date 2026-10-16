const BYTES_PER_GB = 1024 ** 3;

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0GB";
  }
  return `${round(bytes / BYTES_PER_GB)}GB`;
}

export function formatDateTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
    timeZoneName: "short",
  });
}

export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0ms";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${round(seconds - minutes * 60)}s`;
}

export function formatNumber(value: number, suffix = "") {
  if (!Number.isFinite(value)) {
    return `0${suffix}`;
  }
  return `${round(value)}${suffix}`;
}

export function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
