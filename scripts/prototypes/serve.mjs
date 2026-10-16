import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

const folder = path.resolve(process.argv[2] ?? 'output/OpenDesign-HTML-2026-10-16');
const port = Number(process.argv[3] ?? 5280);
const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
const files = new Set(['index.html', 'manifest.json', '使用说明.md', 'OpenDesign精修提示词.md', ...manifest.pages.map((page) => page.file)]);
// 只暴露生成清单里的文件，不能访问仓库、任意路径或用户资料。
http.createServer(async (request, response) => {
  let name;
  try { name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1)) || 'index.html'; }
  catch { response.writeHead(400).end(); return; }
  if (request.method !== 'GET' || !files.has(name)) { response.writeHead(404).end(); return; }
  try {
    const bytes = await fs.readFile(path.join(folder, name));
    response.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(bytes);
  } catch { response.writeHead(500).end(); }
}).listen(port, '127.0.0.1', () => console.log(`离线原型预览：http://127.0.0.1:${port} （仅生成清单文件）`));
