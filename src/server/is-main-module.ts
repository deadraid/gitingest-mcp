import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;

  try {
    return (
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
    );
  } catch {
    return false;
  }
}
