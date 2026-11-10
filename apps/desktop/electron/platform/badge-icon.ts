// Windows overlay icons are raw images, so the count badge is drawn pixel by pixel:
// a red disc with a white 3x5 digit font, no canvas or asset needed.
const SIZE = 32;
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

/** BGRA pixels of a count badge, `9+` past nine. */
export function renderCountBadge(count: number): {
  readonly bitmap: Buffer;
  readonly size: number;
} {
  const label = count > 9 ? "9+" : String(Math.max(0, Math.floor(count)));
  const bitmap = Buffer.alloc(SIZE * SIZE * 4);
  const radius = SIZE / 2;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if ((x + 0.5 - radius) ** 2 + (y + 0.5 - radius) ** 2 <= radius * radius) {
        bitmap.set([0x2d, 0x2d, 0xd6, 0xff], (y * SIZE + x) * 4); // #d62d2d
      }
    }
  }
  const scale = label.length === 1 ? 4 : 3;
  const width = (label.length * 3 + (label.length - 1)) * scale;
  const left = Math.round((SIZE - width) / 2);
  const top = Math.round((SIZE - 5 * scale) / 2);
  [...label].forEach((char, index) => {
    GLYPHS[char]?.forEach((row, rowIndex) => {
      [...row].forEach((cell, columnIndex) => {
        if (cell !== "1") return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = left + (index * 4 + columnIndex) * scale + dx;
            const y = top + rowIndex * scale + dy;
            bitmap.set([0xff, 0xff, 0xff, 0xff], (y * SIZE + x) * 4);
          }
        }
      });
    });
  });
  return { bitmap, size: SIZE };
}
