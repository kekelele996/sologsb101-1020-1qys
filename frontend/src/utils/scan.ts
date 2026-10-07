/**
 * 扫描接批工具
 * - 拓本数字化进度派生：待扫 / 扫描中 / 数字化完成（active 影像页序 1..pageCount 凑齐）
 * - 缺页页序集合（供损泐比对排除：页序缺的那几处不计入差异字数）
 * 纯函数，不触碰 Dexie；写库逻辑在 utils/db.ts 的 applyScanBatch。
 */
import type { DigitizeState } from '@/types/scanImage';
import type { MissingPage } from '@/types/missingPage';
import type { ScanImage } from '@/types/scanImage';

export interface DigitizationInfo {
  /** 数字化进度 */
  state: DigitizeState;
  /** 声明总页数（取影像件最大声明，无件为 0） */
  pageCount: number;
  /** 已有有效影像件的页序 */
  presentPages: number[];
  /** 待补扫页序（缺页台账 open 与页序实缺的并集） */
  missingPageNos: number[];
  /** 有效影像件数 */
  activeCount: number;
  /** 历史重扫次数（被换下的影像件数） */
  rescanCount: number;
}

/** 按拓本聚合数字化进度（仅认 active 影像件；待扫占位 / 已换下 / 未认上均不计） */
export function deriveDigitization(images: ScanImage[], missing: MissingPage[]): DigitizationInfo {
  const active = images.filter((image) => image.status === 'active');
  const pageCount = active.reduce((max, image) => Math.max(max, image.pageCount), 0);
  const presentSet = new Set<number>();
  active.forEach((image) => presentSet.add(image.pageNo));
  const presentPages = Array.from(presentSet).sort((a, b) => a - b);

  const missingSet = new Set<number>();
  missing
    .filter((row) => row.state === 'open')
    .forEach((row) => missingSet.add(row.pageNo));
  for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
    if (!presentSet.has(pageNo)) missingSet.add(pageNo);
  }
  const missingPageNos = Array.from(missingSet).sort((a, b) => a - b);

  let state: DigitizeState = 'waiting';
  if (active.length > 0) {
    state = missingPageNos.length === 0 && pageCount > 0 ? 'done' : 'scanning';
  }

  return {
    state,
    pageCount,
    presentPages,
    missingPageNos,
    activeCount: active.length,
    rescanCount: images.filter((image) => image.status === 'superseded').length,
  };
}

/** 某拓本待补扫页序集合（供损泐比对排除使用） */
export function openMissingPageSet(missing: MissingPage[]): Set<number> {
  return new Set(missing.filter((row) => row.state === 'open').map((row) => row.pageNo));
}

/** 页序清单文案，如「1、2、4」 */
export function formatPageNos(pages: readonly number[]): string {
  return pages.length === 0 ? '—' : pages.map((pageNo) => `第 ${pageNo} 页`).join('、');
}
