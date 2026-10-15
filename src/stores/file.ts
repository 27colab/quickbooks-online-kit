import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StoredTokens, TokenStore } from '../types.js';

/**
 * JSON file on disk. Writes are atomic (temp file + rename) and the file is created
 * with mode 0600. Fine for a single-process server or local development; for
 * multi-instance deployments use a database-backed store.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async get(): Promise<StoredTokens | null> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredTokens;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async delete(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
