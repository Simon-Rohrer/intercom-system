export function isWebHidSupported(): boolean {
  return typeof navigator !== "undefined" && "hid" in navigator;
}
