'use strict';
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createCameraAdapter, createPrinterAdapter, createPaymentAdapter } = require('./adapters');
const { createServer } = require('./http');
const { createTasks } = require('./tasks');
const { seed } = require('./seed');

/**
 * 组装应用：配置 → 目录 → SQLite → 模拟适配器 → 种子数据 → HTTP → 后台任务。
 * 测试可传入 dataDir/port 等覆盖项获得隔离实例。
 */
function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  for (const dir of [config.dataDir, config.ordersDir, config.printoutsDir, config.receiptsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = openDb(config.dbFile);
  const camera = createCameraAdapter({ portraitsDir: config.portraitsDir });
  const printer = createPrinterAdapter({ outDir: config.printoutsDir, paper: config.paperInitial });
  const payment = createPaymentAdapter({ receiptsDir: config.receiptsDir });
  const ctx = { config, db, camera, printer, payment };
  seed(ctx);
  const server = createServer(ctx);
  const tasks = createTasks(ctx);

  return {
    ctx,
    config,
    db,
    tasks,
    server,
    listen(port = config.port) {
      return new Promise((resolve) => {
        server.listen(port, () => resolve(server.address().port));
      });
    },
    close() {
      tasks.stop();
      server.close();
      db.close();
    },
  };
}

module.exports = { createApp };
