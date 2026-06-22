type DeviceChannelSource = {
  label?: string;
  inputChannels?: unknown;
};

function normalizeChannelCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(1, Math.min(32, Math.floor(value)));
}

function rangeMax(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  return normalizeChannelCount((value as { max?: unknown }).max);
}

function inferKnownInterfaceChannelCount(label: string): number | null {
  const normalized = label.toLowerCase();
  const compact = normalized.replace(/[\s_-]+/g, "");

  const focusriteMatch = compact.match(
    /(?:scarlett|clarett|focusrite)?([24])i[24]/,
  );
  if (
    focusriteMatch &&
    /(scarlett|clarett|focusrite|\b[24]i[24]\b)/.test(normalized)
  ) {
    return normalizeChannelCount(Number(focusriteMatch[1]));
  }

  const umcMatch = compact.match(/umc(202|204|404)hd?/);
  if (umcMatch) return umcMatch[1] === "404" ? 4 : 2;

  if (/\bur22\b|\bur242\b/.test(compact)) return 2;
  if (/\bur44\b/.test(compact)) return 4;
  if (/\baudioboxusb96\b|\bmtrackduo\b|\bkompleteaudio2\b/.test(compact)) {
    return 2;
  }
  if (/\bmtrackquad\b/.test(compact)) return 4;

  const explicitInputMatch = normalized.match(
    /\b([24])\s*(?:x|in|input|inputs)\b/,
  );
  if (
    explicitInputMatch &&
    /(interface|usb|audio|input|inputs)/.test(normalized)
  ) {
    return normalizeChannelCount(Number(explicitInputMatch[1]));
  }

  return null;
}

export function resolveInputDeviceChannelCount(
  device?: DeviceChannelSource | null,
): number | null {
  const nativeCount = normalizeChannelCount(device?.inputChannels);
  if (nativeCount) return nativeCount;
  const label = typeof device?.label === "string" ? device.label.trim() : "";
  return label ? inferKnownInterfaceChannelCount(label) : null;
}

export function resolveTrackInputChannelCount(
  track: MediaStreamTrack,
  fallbackHint?: number | null,
): number {
  let settingsCount: number | null = null;
  try {
    settingsCount = normalizeChannelCount(track.getSettings().channelCount);
  } catch {
    settingsCount = null;
  }

  let capabilityCount: number | null = null;
  const trackWithCapabilities = track as MediaStreamTrack & {
    getCapabilities?: () => { channelCount?: unknown };
  };
  if (typeof trackWithCapabilities.getCapabilities === "function") {
    try {
      capabilityCount = rangeMax(
        trackWithCapabilities.getCapabilities().channelCount,
      );
    } catch {
      capabilityCount = null;
    }
  }

  return Math.max(
    1,
    settingsCount ?? 1,
    capabilityCount ?? 1,
    normalizeChannelCount(fallbackHint) ?? 1,
  );
}
