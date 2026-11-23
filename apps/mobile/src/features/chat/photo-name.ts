/**
 * The name a picked or taken photo travels under (the PC shows it on the attachment): the
 * library's file name with a .jpg ending (the picker re-encodes to JPEG), else "Photo 14:05.jpg",
 * numbered when several come from one pick.
 */
export function photoName(fileName: string | null | undefined, atMs: number, index = 0): string {
  const base = fileName?.trim().replace(/\.[^./\\]+$/u, "");
  if (base) return `${base}.jpg`;
  const date = new Date(atMs);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return index > 0 ? `Photo ${time} (${index + 1}).jpg` : `Photo ${time}.jpg`;
}
