export const EAT_OFFSET_SECONDS = 3 * 3600;

export function fmtEat(unixTs: number): string {
  const d = new Date((unixTs + EAT_OFFSET_SECONDS) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s} EAT`;
}

export function fmtEatDate(unixTs: number): string {
  const d = new Date((unixTs + EAT_OFFSET_SECONDS) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fmtEatTime(unixTs: number): string {
  const d = new Date((unixTs + EAT_OFFSET_SECONDS) * 1000);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${min}:${s}`;
}
