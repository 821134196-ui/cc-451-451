# 蓝证照相馆 · 自助证件照门店系统

门店自助证件照全流程：开单取号 → 叫号锁设备 → 多轮拍摄/眨眼重拍 → 候选确认 → 裁切 → 人工修正 → 冲印/加印 → 取件核验 → 退款复核。

零外部依赖（Node.js ≥ 22 内置 `node:http` / `node:sqlite` / `node:test`），人像使用预置占位 SVG 素材，SQLite 持久化订单状态，本地目录管理候选照片与输出文件。

## 一条命令启动

```bash
npm start          # 初始化目录/数据库/素材/种子数据并启动，默认 http://localhost:3000
```

```bash
npm test           # 运行全部测试（设备锁/确认竞态/规格校验/加印关联/退款幂等/取件码）
```

环境变量（均可选）：`PORT`（默认 3000）、`DATA_DIR`（默认 `./data`）、`PICKUP_TTL_MS`（取件码有效期，默认 30 分钟）、`SWEEP_INTERVAL_MS`（后台任务间隔，默认 5 秒）。

## 页面（八个交付终端）

| 页面 | 路径 | 说明 |
|---|---|---|
| 总览导航 | `/` | 全页面入口 + 门店状态 |
| 叫号屏 | `/display.html` | 正在服务号码、等待队列、设备状态，2 秒轮询 |
| 拍摄终端 | `/terminal.html` | 开单取号、叫号、拍摄/重拍；**主操作按钮固定在屏幕下方** |
| 候选选择 | `/select.html?order=<id>` | 候选**同尺寸网格、无滤镜**；规格预览显示**毫米尺寸与裁切安全线** |
| 修正队列 | `/retouch.html` | 修图人员认领/完成；**不展示任何付款明细** |
| 冲印任务 | `/print.html` | 冲印队列、缺纸重试、加纸、**加印** |
| 取件核验 | `/pickup.html` | **只保留大号数字键盘与结果提示**，6 位取件码自动核验 |
| 退款复核 | `/refunds.html` | 店员发起（误操作等），**店长批准/驳回**，幂等 |

页面右上角切换角色（顾客/店员/修图人员/店长），经 `x-role` 请求头生效，服务端逐接口鉴权。

## 业务规则

- **状态机**：`WAITING → SHOOTING → SELECTING → RETOUCH_PENDING → PRINT_PENDING → READY → PICKED_UP`，任意前置环节可 `REFUNDED`。
- **设备锁**：叫号时原子占用拍摄亭（`UPDATE ... WHERE locked_by IS NULL`）；设备离线拒绝叫号与拍摄；确认选片后自动释放。
- **拍摄轮次**：单订单默认 3 轮，每轮 3 张候选；眨眼废片自动重拍且**不消耗轮次**。
- **确认竞态**：两台终端同时确认时，条件更新保证**只接收首个版本**，后到者收到 `409 ALREADY_CONFIRMED`。
- **规格校验**：裁切框越界 → `422 CROP_OUT_OF_BOUNDS`；比例/像素不满足规格（300dpi）→ `422 SPEC_MISMATCH`。
- **重开选择**：仅店员/店长且**必须填写原因**（写审计日志）；**已冲印订单禁止改选原片**，只能创建加印任务（`REPRINT`，关联原始冲印任务，不改变订单状态与取件码）。
- **取件码**：冲印成功签发 6 位数字码，到期由进程内任务标记失效；店员可重发；核验即核销，重复核销 `409`。
- **退款**：店员发起 → 店长复核；`refunds.order_id UNIQUE` + 条件状态翻转保证**重复/并发批准只退款一次**；批准后作废取件码、释放设备、取消未完成任务。
- **权限**：修图人员响应中剥离付款字段；退款批准/驳回仅店长。

## 异常路径

| 场景 | 处理 |
|---|---|
| 设备离线 | 叫号/拍摄返回 `409 DEVICE_OFFLINE`，终端页可模拟离线/恢复 |
| 眨眼重拍 | 相机适配器返回 `BLINK`，当轮自动重拍，不计轮次 |
| 规格不符 | `422 SPEC_MISMATCH`（比例错误 / 像素不足），终端可模拟低像素片 |
| 裁切越界 | `422 CROP_OUT_OF_BOUNDS`，选片页微调按钮可复现 |
| 打印缺纸 | 任务标记 `FAILED/OUT_OF_PAPER`，后台任务每 5 秒自动重试，加纸后恢复 |
| 取件码失效 | 后台任务到期标记 `EXPIRED`，核验返回 `410`，店员可重发 |
| 误操作退款 | 店员发起 → 店长审核 → 模拟付款适配器原路退回，全程幂等 |

## 目录结构

```
src/
  config.js    配置（路径/轮次/价格/有效期）
  db.js        SQLite schema 与审计
  adapters.js  模拟适配器：相机（占位人像/眨眼/低像素）、打印机（缺纸）、付款（回执/退款）
  service.js   领域逻辑：状态机、设备锁、竞态确认、校验、加印、取件、退款
  tasks.js     进程内任务：取件码到期、打印重试
  http.js      路由 + 角色鉴权 + 静态服务
  app.js       组装；server.js 启动入口；seed.js 幂等初始化
assets/portraits/   预置占位人像（900×1200 SVG）
data/               运行时生成：idphoto.db、orders/<id>/{候选,crop,retouched}.svg、printouts/、receipts/
public/             八个页面 + 统一样式（中性白/石墨黑/证件蓝）
test/               node:test 测试（隔离临时目录 + 随机端口）
```

## API 摘要

`POST /api/orders` 下单取号（含模拟付款回执） · `POST /api/queue/call-next` 叫号锁设备 · `POST /api/orders/:id/shoot` 拍摄一轮（`simulate: blink|small` 故障注入） · `POST /api/orders/:id/confirm` 确认候选（原子，先者胜） · `POST /api/orders/:id/reopen` 重开选择（需原因） · `POST /api/retouch/:taskId/complete` 修正完成并冲印 · `POST /api/orders/:id/reprints` 加印 · `POST /api/pickup/verify` 取件核验 · `POST /api/orders/:id/refund-requests` + `POST /api/refunds/:id/approve|reject` 退款复核。错误统一为 `{error:{code,message}}`。
