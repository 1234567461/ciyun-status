# 慈云影视 · 系统状态监控

配套 **独立监控服务**，用于实时掌握慈云影视各节点健康状况。

> 设计目标：**可部署在另一台机器上**，与主站解耦——主站挂了，看板照样能告诉你「它挂了」。

## 它能看什么

| 模块 | 说明 |
|---|---|
| 🔌 **主站接口** | 首页 / 搜索 / 直播 / 采集源等接口的**可用性 + 响应耗时**，偏慢自动标黄 |
| 📺 **直播源** | 央视各频道 m3u8 的**连通性 + 延迟**，哪个源挂了立刻可见 |
| 🖥️ **服务器资源** | 内存 / 磁盘 / 负载 / 运行时长 |
| 🔔 **事件流** | 服务「由好变坏」「由坏变好」的时间线，一目了然 |
| 📢 **公告下发** | 在此处更新公告，主站拉取后弹窗展示给用户 |

看板含**迷你趋势图**，展示近期平均响应耗时的变化，卡不卡一眼看出。

## 快速开始

```bash
# 1. 复制配置
cp config.example.json config.json

# 2. 改配置（至少把 targets[0].url 改成你的主站地址）
vi config.json

# 3. 启动
node server.js
```

打开 `http://你的机器IP:8899/` 即可查看看板。

零依赖，不需要 `npm install`。

## 配置说明

### 监控主站

```json
"targets": [
  { "id": "main", "name": "慈云影视 · 主站", "url": "http://1.2.3.4:8811" }
]
```

可配多个目标，会被同时监控。

### 巡检哪些接口

```json
"apis": [
  { "path": "/",          "name": "首页",     "expect": 200 },
  { "path": "/api/search?q=测试", "name": "搜索", "expect": 200, "warnMs": 3000 }
]
```

- `expect`：期望的 HTTP 状态码
- `warnMs`：超过该耗时记为「偏慢」（黄色），不设则不判定

### 巡检哪些流源

```json
"streams": [
  { "name": "CCTV-1", "url": "https://.../index.m3u8" }
]
```

建议把主站实际在用的直播源都列上，源一挂就能第一时间发现。

### 巡检频率与告警阈值

```json
"probe": { "intervalSec": 60, "timeoutMs": 8000, "historySize": 120 },
"alert": { "failThreshold": 2, "recoverNotify": true }
```

- `failThreshold: 2` 表示**连续失败 2 次**才判定故障——避免网络抖动造成误报
- `recoverNotify` 开启后，恢复时也会记一条事件

### 访问口令（可选）

```json
"authToken": "你的口令"
```

留空则**任何人可访问看板**（仅建议内网使用）。设置后需通过 `?token=口令` 访问。

## 环境变量（容器部署友好）

全部可覆盖配置文件，方便 Docker / systemd 部署：

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口 |
| `TARGET_URL` | 主站地址（会覆盖 `targets`） |
| `TARGET_NAME` | 主站显示名 |
| `PROBE_INTERVAL` | 巡检间隔（秒） |
| `AUTH_TOKEN` | 访问口令 |
| `STATUS_TITLE` | 看板标题 |

```bash
PORT=8899 TARGET_URL=http://10.0.0.5:8811 node server.js
```

## 接口

| 接口 | 说明 |
|---|---|
| `GET /api/status` | 完整状态快照（看板用，受口令保护） |
| `GET /api/announcement` | 公告内容（**无需口令**，供主站跨域拉取） |
| `GET /api/ping` | 存活探测 |
| `POST /api/probe-now` | 手动触发一次巡检 |

## 与主站联动

### 1. 公告下发

编辑 `config.json` 的 `announcement` 字段并重启，主站即可拉到：

```json
"announcement": "今晚 22:00-23:00 进行系统维护，期间可能短暂中断。\n新增 CCTV-16 奥林匹克频道。"
```

**多行 = 多条公告**。主站使用内容哈希做版本号，公告改了才会重新弹窗，没改不打扰用户。

### 2. 状态入口

主站页面可放置指向本看板的入口链接，让用户/运维随时查看系统状况。

## 部署建议

放在**与主站不同的机器**上（或至少不同进程），这样：

- 主站 OOM / 进程崩溃时，监控仍在运行，能准确记录「它什么时候挂的」
- 避免监控消耗主站资源
- 可跨越网络位置，从外部视角验证可用性

用 systemd 常驻：

```ini
[Unit]
Description=Ciyun Status Monitor
After=network.target

[Service]
WorkingDirectory=/opt/ciyun-status
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 说明

- 历史数据存在**内存**中，重启即清空——无需数据库，也避免磁盘增长
- 请求遵循最小读取原则（只读 64KB 即可判定存活），避免探测本身消耗带宽
- 允许自签证书，适配内网 HTTPS 部署
