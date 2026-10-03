'use strict';
/**
 * 慈云影视 · 状态监控 —— 探测核心（零依赖）
 * ============================================================
 * 职责：
 *   1. 接口巡检：对主站各接口发请求，记录状态码 / 耗时 / 是否超预期
 *   2. 流源探测：对 m3u8 地址发 HEAD/GET，确认是否可访问、响应多快
 *   3. 时序存储：环形缓冲区保存历史，供前端画曲线
 *   4. 状态判定：UP / DEGRADED / DOWN，含连续失败阈值与恢复识别
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/* ============================================================
 * 通用请求（带超时、重定向跟随）
 * ============================================================ */
function request(url, { timeout = 8000, method = 'GET', headers = {}, maxRedirect = 3 } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ ok: false, status: 0, ms: 0, error: 'invalid url' });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    let settled = false;

    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, ms: Date.now() - started });
    };

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CiyunStatusBot/1.0)',
          Accept: '*/*',
          ...headers,
        },
        rejectUnauthorized: false, // 容忍自签证书（内网部署常见）
      },
      (res) => {
        // 跟随重定向
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirect > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          settled = true;
          clearTimeout(timer);
          return request(next, { timeout, method, headers, maxRedirect: maxRedirect - 1 }).then((r) =>
            resolve({ ...r, ms: Date.now() - started })
          );
        }
        // 只取少量字节即可判定存活（避免大文件拖满带宽）
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 65536) {
            res.destroy();
            done({ ok: true, status: res.statusCode, size, headers: res.headers });
          }
        });
        res.on('end', () => done({ ok: true, status: res.statusCode, size, headers: res.headers }));
        res.on('error', (e) => done({ ok: false, status: res.statusCode, error: e.message }));
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, status: 0, error: 'timeout' });
    }, timeout);

    req.on('error', (e) => done({ ok: false, status: 0, error: e.message }));
    req.end();
  });
}

/* ============================================================
 * 巡检器：一个目标对应一个 Checker
 * ============================================================ */
class Checker {
  constructor(config) {
    this.cfg = config;
    this.history = [];              // [{ ts, apis:{}, streams:{}, sys:{} }]
    this.maxHistory = (config.probe && config.probe.historySize) || 120;
    this.failStreak = new Map();    // key -> 连续失败次数
    this.state = new Map();         // key -> 'up' | 'degraded' | 'down'
    this.announcement = (config.announcement || '').trim();
    this.events = [];               // 状态变化事件（供前端提示）
  }

  /** 单次全量巡检 */
  async runProbe() {
    const targets = this.cfg.targets || [];
    const apis = this.cfg.apis || [];
    const streams = this.cfg.streams || [];
    const timeout = (this.cfg.probe && this.cfg.probe.timeoutMs) || 8000;
    const failThreshold = (this.cfg.alert && this.cfg.alert.failThreshold) || 2;

    const snap = { ts: Date.now(), apis: {}, streams: {}, targets: {} };

    // 逐个主站目标 × 接口
    for (const t of targets) {
      const base = t.url.replace(/\/+$/, '');
      const apiResults = await Promise.all(
        apis.map(async (a) => {
          const url = base + a.path;
          const r = await request(url, { timeout });
          const expect = a.expect === undefined ? 200 : a.expect;
          const ok = r.ok && r.status === expect;
          const slow = ok && a.warnMs && r.ms > a.warnMs;
          return {
            key: t.id + '|' + a.path,
            target: t.id,
            name: a.name || a.path,
            path: a.path,
            ok,
            slow: !!slow,
            status: r.status,
            ms: r.ms,
            error: r.error || '',
            warnMs: a.warnMs || 0,
          };
        })
      );
      apiResults.forEach((r) => {
        snap.apis[r.key] = r;
        this._track(r.key, r.ok ? (r.slow ? 'degraded' : 'up') : 'down', failThreshold, r.name);
      });
    }

    // 流源探测（直连 CDN，不经主站）
    const streamResults = await Promise.all(
      streams.map(async (s) => {
        const r = await request(s.url, { timeout, method: 'GET' });
        // m3u8 判定：200 且有内容
        const ok = r.ok && r.status === 200 && (r.size || 0) > 0;
        return {
          key: 'stream|' + s.name,
          name: s.name,
          url: s.url,
          ok,
          status: r.status,
          ms: r.ms,
          size: r.size || 0,
          error: r.error || '',
        };
      })
    );
    streamResults.forEach((r) => {
      snap.streams[r.key] = r;
      this._track(r.key, r.ok ? 'up' : 'down', failThreshold, r.name);
    });

    snap.sys = this._sysInfo();

    this.history.push(snap);
    if (this.history.length > this.maxHistory) this.history.shift();
    return snap;
  }

  /**
   * 临时（一次性）探测指定地址 —— 供看板「即时侦测」使用。
   * 不写入 history / state，纯粹按需检测，避免污染正常巡检曲线。
   * @param {string[]} urls  目标地址（http/https/m3u8 均可）
   * @param {object}   opts  { timeout, method }
   */
  async probeUrls(urls, opts = {}) {
    const timeout = opts.timeout || (this.cfg.probe && this.cfg.probe.timeoutMs) || 8000;
    const method = (opts.method || 'GET').toUpperCase();
    const list = (urls || []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, 20);
    if (!list.length) return [];

    return Promise.all(
      list.map(async (raw) => {
        // 容错：用户可能只写 IP / 域名 / host:port，自动补协议
        let url = raw;
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        const r = await request(url, { timeout, method });
        const isM3u8 = /\.m3u8(\?|$)/i.test(url);
        // 判定：HTTP 2xx/3xx 且有响应体（HEAD 无 body 时只看状态码）
        const ok = r.ok && r.status > 0 && r.status < 400 && (method === 'HEAD' || (r.size || 0) > 0);
        return {
          url: raw,
          normalized: url,
          kind: isM3u8 ? 'stream' : 'http',
          ok,
          status: r.status,
          ms: r.ms,
          size: r.size || 0,
          contentType: (r.headers && r.headers['content-type']) || '',
          error: r.error || '',
          ts: Date.now(),
        };
      })
    );
  }

  /** 状态跟踪：含连续失败阈值、恢复识别 */
  _track(key, rawState, threshold, label) {
    const prev = this.state.get(key) || 'unknown';
    let next = rawState;

    if (rawState === 'down') {
      const streak = (this.failStreak.get(key) || 0) + 1;
      this.failStreak.set(key, streak);
      // 未达阈值前维持原状态，避免网络抖动造成误报
      if (streak < threshold && prev === 'up') next = 'up';
    } else {
      this.failStreak.set(key, 0);
      if (prev === 'down' && rawState === 'up' && this.cfg.alert && this.cfg.alert.recoverNotify) {
        this.events.push({ ts: Date.now(), type: 'recover', key, label, text: label + ' 已恢复' });
      }
    }

    if (prev !== next && next === 'down') {
      this.events.push({ ts: Date.now(), type: 'down', key, label, text: label + ' 异常' });
    }
    this.state.set(key, next);
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
  }

  /** 服务器资源（不引入依赖，读 /proc 与 os） */
  _sysInfo() {
    const os = require('os');
    const fs = require('fs');
    const mem = { total: os.totalmem(), free: os.freemem() };
    let load = [0, 0, 0];
    try { load = os.loadavg().map((n) => +n.toFixed(2)); } catch {}
    let disk = null;
    try {
      const stat = require('fs').statfsSync ? require('fs').statfsSync('/') : null;
      if (stat) {
        disk = {
          total: stat.blocks * stat.bsize,
          free: stat.bavail * stat.bsize,
        };
      }
    } catch {}
    const uptime = os.uptime();
    return {
      host: os.hostname(),
      platform: os.platform() + ' ' + os.arch(),
      cpus: os.cpus().length,
      load,
      memTotal: mem.total,
      memUsed: mem.total - mem.free,
      memPercent: +(((mem.total - mem.free) / mem.total) * 100).toFixed(1),
      diskTotal: disk ? disk.total : 0,
      diskFree: disk ? disk.free : 0,
      diskPercent: disk ? +(((disk.total - disk.free) / disk.total) * 100).toFixed(1) : 0,
      uptime,
      nodeVersion: process.version,
      rss: process.memoryUsage().rss,
    };
  }

  /** 汇总当前总体状态 */
  summary() {
    const last = this.history[this.history.length - 1];
    if (!last) return { status: 'unknown', up: 0, degraded: 0, down: 0, checkedAt: null, total: 0 };

    let up = 0, degraded = 0, down = 0;
    const collect = (obj) => {
      Object.values(obj).forEach((r) => {
        const st = this.state.get(r.key) || (r.ok ? 'up' : 'down');
        if (st === 'down') down++;
        else if (st === 'degraded' || r.slow) degraded++;
        else up++;
      });
    };
    collect(last.apis);
    collect(last.streams);

    const total = up + degraded + down;
    let status = 'up';
    if (down > 0) status = down >= Math.ceil(total / 2) ? 'down' : 'degraded';
    else if (degraded > 0) status = 'degraded';

    // 主站整体是否可达（以首页接口为准）
    const homeKey = Object.keys(last.apis).find((k) => k.endsWith('|/'));
    const reachable = homeKey ? !!last.apis[homeKey].ok : true;

    return { status, up, degraded, down, total, checkedAt: last.ts, reachable };
  }

  /** 供前端使用的完整快照 */
  snapshot() {
    return {
      title: this.cfg.title || '系统状态',
      summary: this.summary(),
      latest: this.history[this.history.length - 1] || null,
      history: this.history.slice(-60),
      events: this.events.slice(-30),
      announcement: this.announcement,
      intervalSec: (this.cfg.probe && this.cfg.probe.intervalSec) || 60,
    };
  }
}

module.exports = { request, Checker };
