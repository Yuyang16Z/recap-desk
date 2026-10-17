import fs from 'node:fs';
import path from 'node:path';

// 轻量持久化：每次生成一个 JSON 文件。Render 免费实例的磁盘在重新部署后会清空，
// 因此仓库内附带 data/samples 下的真实样例，启动时载入，保证评审打开即有可看的完整记录。
export class Store {
  constructor(runtimeDir, samplesDir) {
    this.dir = path.join(runtimeDir, 'runs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.runs = new Map();
    this.failures = [];
    for (const dir of [samplesDir, this.dir]) {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        try {
          const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (dir === samplesDir) run.is_sample = true;
          this.runs.set(run.id, run);
        } catch { /* 跳过损坏文件 */ }
      }
    }
  }
  save(run) {
    this.runs.set(run.id, run);
    try { fs.writeFileSync(path.join(this.dir, `${run.id}.json`), JSON.stringify(run)); } catch { /* 只读文件系统时仅保留内存 */ }
  }
  get(id) { return this.runs.get(id); }
  list() {
    return [...this.runs.values()].sort((a, b) => b.created_at - a.created_at).map((r) => ({
      id: r.id, created_at: r.created_at, date: r.trading?.date, audience: r.input?.audience, status: r.status,
      title: r.draft?.title, is_sample: !!r.is_sample, simulate: r.input?.simulate || [], gate: r.gate, degraded: !!r.writer?.fallback,
    }));
  }
  recordFailure(f) { this.failures.push({ at: Date.now(), ...f }); }
}
