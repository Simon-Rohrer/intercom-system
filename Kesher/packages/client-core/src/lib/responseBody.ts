/**
 * Releases the body of a fetch response that is not going to be read.
 *
 * Chromium backs every response body with a shared-memory data pipe (2 MB) and
 * only frees it once the body is read, cancelled or the Response is garbage
 * collected. A poll that returns early without touching the body (401, wrong
 * content type) therefore piles up one region per request – on the Raspberry Pi
 * (Kamera-1) that filled /tmp with ~8 MB per minute until Chromium had to restart.
 */
export function discardBody(res: Response): void {
  if (res.bodyUsed || !res.body) return;
  res.body.cancel().catch(() => undefined);
}
