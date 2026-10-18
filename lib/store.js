import fs from 'node:fs';
import path from 'node:path';

const TRANSIENT = new Set(['ai_review_running']);

// 轻量持久化：每次生成一个 JSON 文件。Render 免费实例的磁盘在重新部署后会清空，
// 因此仓库内附带 data/samples 下的真实样例，启动时载入，保证评审打开即有可看的完整记录。
export class Store {
  constructor(runtimeDir, samplesDir) {
    this.dir = path.join(runtimeDir, 'runs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.runs = new Map();
    this.failures = [];
    // 团队规则库与写作偏好：运行时修改写入 data/runtime/config.json，首次启动从仓库内默认配置载入
    this.configPath = path.join(runtimeDir, 'config.json');
    const defaults = path.join(path.dirname(samplesDir || runtimeDir), 'config.default.json');
    this.config = { rules: [], preferences: [] };
    for (const f of [this.configPath, defaults]) {
      try { this.config = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch { /* 下一个候选 */ }
    }
    for (const dir of [samplesDir, this.dir]) {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        try {
          const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (dir === samplesDir) run.is_sample = true;
          for (const k of TRANSIENT) delete run[k];
          this.runs.set(run.id, run);
        } catch { /* 跳过损坏文件 */ }
      }
    }
  }
  save(run) {
    this.runs.set(run.id, run);
    // 进行中的临时标记（如 AI 复核中）不落盘：实例重启后不能把稿件永久锁住
    try { fs.writeFileSync(path.join(this.dir, `${run.id}.json`), JSON.stringify(run, (k, v) => (TRANSIENT.has(k) ? undefined : v))); } catch { /* 只读文件系统时仅保留内存 */ }
    this.evict();
  }
  // 免费实例内存有限：超过上限时淘汰最旧的非样例记录
  evict(max = Number(process.env.MAX_RUNS || 300)) {
    if (this.runs.size <= max) return;
    const victims = [...this.runs.values()].filter((r) => !r.is_sample).sort((a, b) => a.created_at - b.created_at).slice(0, this.runs.size - max);
    for (const r of victims) {
      this.runs.delete(r.id);
      try { fs.unlinkSync(path.join(this.dir, `${r.id}.json`)); } catch { /* 文件可能不存在 */ }
    }
  }
  saveConfig() {
    try { fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2)); } catch { /* 只读文件系统时仅保留内存 */ }
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
