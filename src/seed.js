'use strict';
const { nowIso } = require('./util');
const { ensurePortraits } = require('./adapters');

/** 幂等初始化：占位人像素材、证件规格、拍摄亭设备 */
function seed(ctx) {
  const { db, config } = ctx;
  ensurePortraits(config.portraitsDir);

  const specs = [
    // id, 名称, 宽mm, 高mm, 300dpi 像素
    ['id-1inch', '一寸', 25, 35, 295, 413, '#ffffff'],
    ['id-2inch', '二寸', 35, 49, 413, 579, '#ffffff'],
    ['passport', '护照', 33, 48, 390, 567, '#ffffff'],
    ['visa-us', '美国签证', 51, 51, 602, 602, '#ffffff'],
    ['driver', '驾驶证', 22, 32, 260, 378, '#ffffff'],
  ];
  const insSpec = db.prepare(
    `INSERT INTO specs (id, name, width_mm, height_mm, px_width, px_height, bg_color, active)
     VALUES (?,?,?,?,?,?,?,1)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, width_mm=excluded.width_mm, height_mm=excluded.height_mm,
       px_width=excluded.px_width, px_height=excluded.px_height`
  );
  for (const s of specs) insSpec.run(...s);

  const devices = [
    ['booth-1', '拍摄亭 1'],
    ['booth-2', '拍摄亭 2'],
  ];
  const insDev = db.prepare(
    `INSERT INTO devices (id, name, status, updated_at) VALUES (?,?, 'online', ?)
     ON CONFLICT(id) DO NOTHING`
  );
  for (const [devId, name] of devices) insDev.run(devId, name, nowIso());
}

module.exports = { seed };
