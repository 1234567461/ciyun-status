'use strict';
/**
 * 慈云影视 · 配套状态监控服务
 * ============================================================
 * 独立部署（可与主站不同机器），零依赖。
 *   · 定时巡检主站接口 + 外部流源
 *   · 暴露 /api/status 供看板与主站读取
 *   · 提供 /api/announcement 供主站拉取公告
 *   · 内存存储历史时序，重启即清空（无需数据库）
 *
 * 启动：node server.js
 * 配置：config.json（不存在则读 config.example.json 并在控制台提示）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Checker } = require('./lib/probe');

/* ============================================================
 * 配置加载（配置文件 + 环境变量覆盖）
 * ============================================================ */
function loadConfig() {
  const dir = __dirname;
  const userPath = path.join(dir, 'config.json');
  const exPath = path.join(dir, 'config.example.json');
  let cfg = {};
  let used = '(内置默认)';

  try {
    if (fs.existsSync(userPath)) {
      cfg = JSON.parse(fs.readFileSync(userPath, 'utf8'));
      used = 'config.json';
    } else if (fs.existsSync(exPath)) {
      cfg = JSON.parse(fs.readFileSync(exPath, 'utf8'));
      used = 'config.example.json（建议复制为 config.json 再改）';
    }
  } catch (e) {
    console.error('[config] 解析失败：' + e.message + '，改用内置默认值');
    cfg = {};
  }

  // 环境变量覆盖（便于容器化部署）
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10);
  if (process.env.STATUS_TITLE) cfg.title = process.env.STATUS_TITLE;
  if (process.env.TARGET_URL) {
    cfg.targets = [{ id: 'main', name: process.env.TARGET_NAME || '主站', url: process.env.TARGET_URL }];
  }
  if (process.env.AUTH_TOKEN !== undefined) cfg.authToken = process.env.AUTH_TOKEN;
  if (process.env.PROBE_INTERVAL) {
    cfg.probe = cfg.probe || {};
    cfg.probe.intervalSec = parseInt(process.env.PROBE_INTERVAL, 10);
  }

  cfg.port = cfg.port || 8899;
  cfg.title = cfg.title || '慈云影视 · 系统状态';
  cfg.targets = cfg.targets && cfg.targets.length ? cfg.targets : [{ id: 'main', name: '主站', url: 'http://127.0.0.1:8811' }];
  cfg.probe = Object.assign({ intervalSec: 60, timeoutMs: 8000, historySize: 120 }, cfg.probe || {});
  cfg.apis = cfg.apis || [];
  cfg.streams = cfg.streams || [];
  cfg.alert = Object.assign({ failThreshold: 2, recoverNotify: true }, cfg.alert || {});

  return { cfg, used };
}

const { cfg, used } = loadConfig();
const checker = new Checker(cfg);

/* ============================================================
 * 工具
 * ============================================================ */
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',   // 供主站跨域读取
    'Access-Control-Allow-Headers': 'Authorization',
  });
  res.end(body);
}

function authorized(req, url) {
  if (!cfg.authToken) return true; // 未设口令则放行（内网场景）
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const q = url.searchParams.get('token') || '';
  return bearer === cfg.authToken || q === cfg.authToken;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ============================================================
 * 路由
 * ============================================================ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  // ---- 公开接口（供主站跨域读取，无需口令）----
  if (p === '/api/announcement') {
    return json(res, 200, {
      announcement: checker.announcement,
      updatedAt: Date.now(),
    });
  }
  if (p === '/api/ping') {
    return json(res, 200, { ok: true, ts: Date.now() });
  }

  // ---- 需鉴权的状态接口 ----
  if (p === '/api/status') {
    if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, checker.snapshot());
  }
  if (p === '/api/probe-now' && req.method === 'POST') {
    if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' });
    try {
      await checker.runProbe();
      return json(res, 200, { ok: true, summary: checker.summary() });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // ---- 静态资源（看板页）----
  if (p === '/' || p === '/index.html') {
    return serveFile(res, path.join(__dirname, 'public', 'index.html'));
  }
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, 'public', safe);
  if (filePath.startsWith(path.join(__dirname, 'public')) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveFile(res, filePath);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

function serveFile(res, filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('read error: ' + e.message);
  }
}

/* ============================================================
 * 巡检调度
 * ============================================================ */
let timer = null;
async function tick() {
  try {
    const snap = await checker.runProbe();
    const s = checker.summary();
    const icon = s.status === 'up' ? '✅' : s.status === 'degraded' ? '⚠️' : '❌';
    console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] ' + icon + ' ' +
      s.up + ' 正常 / ' + s.degraded + ' 降级 / ' + s.down + ' 异常' +
      (snap.sys ? ' | 内存 ' + snap.sys.memPercent + '%' : ''));
  } catch (e) {
    console.error('[probe] 巡检异常：' + e.message);
  }
}

server.listen(cfg.port, () => {
  console.log('');
  console.log('  慈云影视 · 系统状态监控');
  console.log('  ─────────────────────────────────────────');
  console.log('  配置来源 : ' + used);
  console.log('  监听端口 : ' + cfg.port);
  console.log('  看板地址 : http://localhost:' + cfg.port + '/');
  console.log('  监控目标 : ' + cfg.targets.map((t) => t.name + ' (' + t.url + ')').join(', '));
  console.log('  巡检间隔 : ' + cfg.probe.intervalSec + 's   接口 ' + cfg.apis.length + ' 个 / 流源 ' + cfg.streams.length + ' 个');
  console.log('  访问口令 : ' + (cfg.authToken ? '已启用' : '未设置（内网可接受）'));
  console.log('  ─────────────────────────────────────────');
  console.log('');
  tick(); // 启动即跑一次，别让用户等一个周期
  timer = setInterval(tick, Math.max(10, cfg.probe.intervalSec) * 1000);
});

process.on('SIGTERM', () => { clearInterval(timer); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { clearInterval(timer); server.close(() => process.exit(0)); });
