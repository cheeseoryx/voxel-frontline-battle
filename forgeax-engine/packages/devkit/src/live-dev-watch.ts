/** Ignore generated outputs before scheduling a source reload. */
export function isLiveDevInputChange(filename: string | Buffer | null | undefined): boolean {
  // Windows recursive watchers can emit null for directory activity caused by
  // our own session writes. Such an event cannot identify an author input.
  if (filename === null || filename === undefined || filename.length === 0) return false;
  const name = String(filename).replace(/\\/g, '/');
  if (name.toLowerCase().endsWith('.log')) return false;
  return !name.split('/').some(segment => ['.forgeax', 'dist', 'artifacts', 'coverage', 'node_modules'].includes(segment));
}
