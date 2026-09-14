import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const isAssetDeclaration = (name: string): boolean =>
  name.endsWith('.meta.json') || name.endsWith('.pack.ts') || name.endsWith('.pack.json');

const TEMPLATE_TEST_DIRECTORY = '__tests__';

/**
 * Collect the deterministic declaration closure for a template asset tree.
 *
 * The Pack plugin accepts both self-contained Pack files and importer
 * sidecars. Raw source files remain outside this list; the sidecar's `source`
 * field is the single authority for resolving them during import.
 */
export function collectAssetDeclarationRoots(root: string): readonly string[] {
  const roots: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        // Tests validate the template source but are not part of its shipped
        // asset closure. Skip the directory at every nesting level so a
        // fixture pack cannot become a production Catalog row by accident.
        if (entry.name === TEMPLATE_TEST_DIRECTORY) continue;
        visit(path);
      } else if (entry.isFile() && isAssetDeclaration(entry.name)) {
        roots.push(path);
      }
    }
  };
  visit(root);
  return roots;
}
