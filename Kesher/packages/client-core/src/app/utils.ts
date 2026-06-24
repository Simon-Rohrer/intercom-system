export function sourceUserIDFromTrackID(trackID: string): string {
  const prefix = "audio-user-";
  if (!trackID.startsWith(prefix)) return "";
  const raw = trackID.slice(prefix.length);
  const sourceMarker = "--source-";
  const markerIndex = raw.indexOf(sourceMarker);
  return markerIndex >= 0 ? raw.slice(0, markerIndex) : raw;
}

export function sourceIDFromTrackID(trackID: string): string {
  const marker = "--source-";
  const markerIndex = trackID.indexOf(marker);
  if (markerIndex < 0) return "main";
  return trackID.slice(markerIndex + marker.length) || "main";
}

export function sourceUserIDFromRemoteSDPMid(
  pc: RTCPeerConnection | null,
  mid: string | null | undefined,
): string {
  if (!pc || !mid) return "";
  const sdp = pc.remoteDescription?.sdp;
  if (!sdp) return "";
  const sections = sdp.split(/\r?\nm=/);
  for (let i = 0; i < sections.length; i += 1) {
    const section = i === 0 ? sections[i] : `m=${sections[i]}`;
    if (!section.startsWith("m=audio")) continue;
    const lines = section.split(/\r?\n/);
    const midLine = lines.find((line) => line.startsWith("a=mid:"));
    if (!midLine || midLine.slice("a=mid:".length).trim() !== mid) continue;
    const msidLine = lines.find((line) => line.startsWith("a=msid:"));
    if (!msidLine) return "";
    const msidParts = msidLine.slice("a=msid:".length).trim().split(/\s+/);
    if (msidParts.length < 2) return "";
    return sourceUserIDFromTrackID(msidParts[1] || "");
  }
  return "";
}

export function sameStringArray(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function sameStringSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sameStringArray(sortedA, sortedB);
}
