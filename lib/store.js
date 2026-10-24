/**
 * 持久化层：<DSH_HOME>/qq-persona/ 下的 JSON + JSONL。
 * - 原子写（tmp → rename），避免半截文件
 * - 每个文件一条串行写链，避免并发覆盖
 * - 所有落盘都是 JSON，不引第三方库
 */
import { mkdir, readFile, rename, writeFile, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function dshHome() {
  const fromEnv = (process.env.DSH_HOME || '').trim();
  return fromEnv || path.join(os.homedir(), '.dsh');
}

export function dataDir() {
  return path.join(dshHome(), 'qq-persona');
}

export function fileInData(...segments) {
  return path.join(dataDir(), ...segments);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/** 原子写：先写 .tmp-<pid>-<rand>，再 rename 覆盖。 */
export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

export async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function appendJsonl(file, line) {
  await ensureDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
}

export async function readJsonlTail(file, maxLines = 500) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const tail = lines.slice(-maxLines);
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // 坏行跳过：绝不因为一行坏数据丢掉整份小结
    }
  }
  return out;
}

export async function fileSize(file) {
  try {
    const s = await stat(file);
    return s.size;
  } catch {
    return 0;
  }
}

/** 带串行写链的 JSON 文档。 */
export class JsonDoc {
  #file;
  #fallback;
  #writeChain = Promise.resolve();

  constructor(file, fallback) {
    this.#file = file;
    this.#fallback = fallback;
  }

  get file() {
    return this.#file;
  }

  async load() {
    return readJson(this.#file, structuredClone(this.#fallback));
  }

  /** 读-改-写，全程串行。mutator 可返回 undefined（原地改）或新值。 */
  async update(mutator) {
    const run = this.#writeChain.then(async () => {
      const current = await this.load();
      const next = (await mutator(current)) ?? current;
      await writeJsonAtomic(this.#file, next);
      return next;
    });
    this.#writeChain = run.catch(() => undefined);
    return run;
  }
}