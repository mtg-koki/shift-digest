import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Lock, Storage } from "./types";

/** ローカル開発用。書き込みは一時ファイル→rename で原子的に置き換える。 */
export class FsStorage implements Storage {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    const p = path.resolve(this.baseDir, key);
    if (!p.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return p;
  }

  async getText(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(key), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async putText(key: string, text: string): Promise<void> {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, p);
  }

  async tryLock(key: string, ttlSeconds: number): Promise<Lock | null> {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const token = randomUUID();
    const body = JSON.stringify({ token, expiresAt: Date.now() + ttlSeconds * 1000 });
    const create = async () => {
      await fs.writeFile(p, body, { flag: "wx" });
    };
    try {
      await create();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // 期限切れのロック（異常終了の残骸）なら奪う
      try {
        const cur = JSON.parse(await fs.readFile(p, "utf8")) as { expiresAt?: number };
        if (typeof cur.expiresAt === "number" && cur.expiresAt < Date.now()) {
          await fs.rm(p, { force: true });
          await create();
        } else {
          return null;
        }
      } catch {
        return null;
      }
    }
    return {
      release: async () => {
        try {
          const cur = JSON.parse(await fs.readFile(p, "utf8")) as { token?: string };
          if (cur.token === token) await fs.rm(p, { force: true });
        } catch {
          /* already gone */
        }
      },
    };
  }
}
