/* Minimal leveled logging with a consistent prefix. */

export const log = {
  info: (msg: string) => console.log(msg),
  step: (msg: string) => console.log(`\n→ ${msg}`),
  ok: (msg: string) => console.log(`  ✓ ${msg}`),
  warn: (msg: string) => console.warn(`  ! ${msg}`),
};
