'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { id, nowIso } = require('./util');

/* ------------------------------------------------------------------ *
 * 模拟适配器：相机 / 打印机 / 付款。
 * 真实部署时替换为硬件 SDK 与支付网关，接口保持不变。
 * ------------------------------------------------------------------ */

/** 预置占位人像（900×1200 SVG），种子初始化时生成 */
function portraitSvg(i) {
  const bgs = ['#dbe7f7', '#f3f4f6', '#fde8e8', '#e3f2e9', '#eef0f3', '#e8e6fb', '#fdf3e0', '#e0f0f7'];
  const skins = ['#e8c39e', '#f0cfa8', '#deb490', '#e5bd96', '#eec7a2', '#d9ad85', '#f2d4ae', '#e2b892'];
  const bg = bgs[i % bgs.length];
  const skin = skins[i % skins.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 1200" width="900" height="1200">
  <rect width="900" height="1200" fill="${bg}"/>
  <ellipse cx="450" cy="1150" rx="340" ry="380" fill="#2f333a"/>
  <rect x="388" y="640" width="124" height="150" rx="46" fill="${skin}"/>
  <circle cx="450" cy="500" r="215" fill="${skin}"/>
  <text x="880" y="40" text-anchor="end" font-family="sans-serif" font-size="30" fill="#9aa0a8">占位人像 P${i + 1} · 900×1200</text>
</svg>
`;
}

function ensurePortraits(dir, count = 8) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const f = path.join(dir, `p${i + 1}.svg`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, portraitSvg(i));
  }
}

/**
 * 相机适配器：从预置素材轮询取片，拷贝为订单候选文件。
 * simulate: 'blink' 模拟眨眼（废片，需重拍）；'small' 模拟低像素片（触发规格不符）。
 */
function createCameraAdapter({ portraitsDir }) {
  let cursor = 0;
  return {
    shoot({ destFile, simulate } = {}) {
      if (simulate === 'blink') return { ok: false, reason: 'BLINK' };
      if (simulate === 'small') {
        const svg = portraitSvg(0).replace('viewBox="0 0 900 1200"', 'viewBox="0 0 260 360"')
          .replace('width="900" height="1200"', 'width="260" height="360"');
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.writeFileSync(destFile, svg);
        return { ok: true, width: 260, height: 360, file: destFile };
      }
      const files = fs.readdirSync(portraitsDir).filter((f) => f.endsWith('.svg')).sort();
      const src = path.join(portraitsDir, files[cursor++ % files.length]);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(src, destFile);
      return { ok: true, width: 900, height: 1200, file: destFile };
    },
  };
}

/**
 * 打印机适配器：按份数耗纸，缺纸返回 OUT_OF_PAPER；
 * 成功时把成品文件复制到 printouts/ 作为「冲印输出」。
 */
function createPrinterAdapter({ outDir, paper = 20 }) {
  const state = { paper };
  return {
    state,
    print({ srcFile, copies, taskId }) {
      if (state.paper < copies) return { ok: false, reason: 'OUT_OF_PAPER' };
      state.paper -= copies;
      fs.mkdirSync(outDir, { recursive: true });
      for (let i = 1; i <= copies; i++) {
        fs.copyFileSync(srcFile, path.join(outDir, `${taskId}-${i}.svg`));
      }
      return { ok: true, jobId: id('job') };
    },
    refill(sheets) { state.paper += sheets; },
    deplete() { state.paper = 0; },
  };
}

/**
 * 付款适配器：开具付款回执（落盘 receipts/），退款返回退款单号。
 * stats 供测试断言「退款只执行一次」。
 */
function createPaymentAdapter({ receiptsDir }) {
  let seq = 1000;
  const stats = { charges: 0, refunds: 0 };
  return {
    stats,
    charge({ orderId, amountCents }) {
      const receiptNo = `PAY${++seq}`;
      const receipt = { receiptNo, orderId, amountCents, channel: 'MOCK', paidAt: nowIso() };
      fs.mkdirSync(receiptsDir, { recursive: true });
      fs.writeFileSync(path.join(receiptsDir, `${receiptNo}.json`), JSON.stringify(receipt, null, 2));
      stats.charges += 1;
      return receipt;
    },
    refund({ receiptNo, amountCents }) {
      stats.refunds += 1;
      const refundNo = `RFD${1000 + stats.refunds}`;
      const record = { refundNo, receiptNo, amountCents, refundedAt: nowIso() };
      fs.mkdirSync(receiptsDir, { recursive: true });
      fs.writeFileSync(path.join(receiptsDir, `${refundNo}.json`), JSON.stringify(record, null, 2));
      return record;
    },
  };
}

module.exports = { ensurePortraits, createCameraAdapter, createPrinterAdapter, createPaymentAdapter };
