'use strict';
const path = require('node:path');

/**
 * 全局配置。所有路径集中于本地目录：
 *  - assets/portraits  预置占位人像素材（只读）
 *  - data/             SQLite 数据库与各订单输出文件（运行时生成）
 */
function loadConfig(overrides = {}) {
  const root = overrides.root || path.resolve(__dirname, '..');
  const dataDir = overrides.dataDir || process.env.DATA_DIR || path.join(root, 'data');
  return {
    root,
    dataDir,
    dbFile: overrides.dbFile || path.join(dataDir, 'idphoto.db'),
    portraitsDir: overrides.portraitsDir || path.join(root, 'assets', 'portraits'),
    ordersDir: path.join(dataDir, 'orders'),
    printoutsDir: path.join(dataDir, 'printouts'),
    receiptsDir: path.join(dataDir, 'receipts'),
    publicDir: path.join(root, 'public'),
    port: Number(overrides.port ?? process.env.PORT ?? 3000),

    maxRounds: overrides.maxRounds ?? 3,          // 单订单允许的拍摄轮次
    shotsPerRound: overrides.shotsPerRound ?? 3,  // 每轮产出候选数
    maxCopies: overrides.maxCopies ?? 8,          // 冲印份数上限
    pickupTtlMs: Number(overrides.pickupTtlMs ?? process.env.PICKUP_TTL_MS ?? 30 * 60 * 1000),
    sweepIntervalMs: Number(overrides.sweepIntervalMs ?? process.env.SWEEP_INTERVAL_MS ?? 5000),
    printMaxAttempts: overrides.printMaxAttempts ?? 5,

    priceBaseCents: 2000,        // 基础价 ¥20（含 1 份冲印）
    priceExtraCopyCents: 1000,   // 每加 1 份 +¥10

    paperInitial: overrides.paperInitial ?? 20,   // 打印机初始纸张
  };
}

module.exports = { loadConfig };
