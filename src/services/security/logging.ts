export function sanitizeForLog(value: unknown): string {
  return String(value).replace(/[\r\n\t]/g, " ").slice(0, 200);
}
