import fs from 'node:fs';
import path from 'node:path';

// 读取 .env.local / .env（不覆盖平台已注入的环境变量），避免额外依赖 dotenv
export function loadEnv(root) {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const k = t.slice(0, t.indexOf('=')).trim();
      const v = t.slice(t.indexOf('=') + 1).trim();
      if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
    }
  }
}
