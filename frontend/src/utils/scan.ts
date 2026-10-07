/**
 * 扫描批次领域逻辑（纯函数 + 一笔入账事务）
 * - 影像件挂接 / 缺页 / 待扫占位的判定
 * - 页序连续性与数字化完成状态（缺页登记与页序断档都算未齐）
 * - 比对缺页序集合：缺页所在字位不进差异字数
 * - 批次接收：按收藏号认拓本、重扫换件、旧字位挂起待复核、占位核销
 * - 影像组重试同批（同 batchNo）：编目台一份不跟着改，整批拒收
 */
import type { ScanBatch, ScanImage, ScanImageState } from '@/types/scan';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import { db } from './db';

/** 收藏号归一化：去空白，作为「按收藏号认拓本」的匹配键 */
export function normalizeCollectionNo(value: string): string {
  return value.replace(/\s+/g, '');
}

/** 当前有效影像件：已挂接（缺页登记也是页序的一部分） */
export function isLiveImage(image: ScanImage): boolean {
  return image.state === 'attached' || image.state === 'missing';
}

/** 某拓本当前生效的扫描记录（已挂接 + 缺页），按页序排列 */
export function liveImagesOf(images: ScanImage[], rubbingId: string): ScanImage[] {
  return images
    .filter((image) => image.rubbingId === rubbingId && isLiveImage(image))
    .sort((a, b) => a.pageSeq - b.pageSeq);
}

/** 实际影像页数（缺页登记不算影像） */
export function scannedPageCount(images: ScanImage[], rubbingId: string): number {
  return images.filter((image) => image.rubbingId === rubbingId && image.state === 'attached').length;
}

/** 已登记缺页页序（批次内报备的缺页） */
export function registeredMissingPages(images: ScanImage[], rubbingId: string): number[] {
  return images
    .filter((image) => image.rubbingId === rubbingId && image.state === 'missing')
    .map((image) => image.pageSeq)
    .sort((a, b) => a - b);
}

/**
 * 页序缺的页序集合：既包括已登记缺页，也包括 1..最大页序 中间的断档。
 * 这些页上的字位不能算进版本差异字数。
 */
export function missingPageSeqs(images: ScanImage[], rubbingId: string): Set<number> {
  const live = liveImagesOf(images, rubbingId);
  const result = new Set<number>();
  if (live.length === 0) return result;
  const occupied = new Set(live.map((image) => image.pageSeq));
  const maxSeq = Math.max(...occupied);
  for (let seq = 1; seq <= maxSeq; seq += 1) {
    if (!occupied.has(seq)) result.add(seq);
  }
  return result;
}

/** 数字化完成状态：一页都没有=待扫；有缺/有断档=页序未齐；1..max 连续且都有影像=完成 */
export function digitizationStateOf(images: ScanImage[], rubbingId: string): 'pending' | 'incomplete' | 'complete' {
  const live = liveImagesOf(images, rubbingId);
  if (live.length === 0) return 'pending';
  if (missingPageSeqs(images, rubbingId).size > 0) return 'incomplete';
  if (live.some((image) => image.state !== 'attached')) return 'incomplete';
  return 'complete';
}

/** 拓本总页序：数字化完成时等于实际影像页数；未完成时按最大页序计 */
export function totalPageSeqs(images: ScanImage[], rubbingId: string): number {
  const live = liveImagesOf(images, rubbingId);
  return live.length === 0 ? 0 : Math.max(...live.map((image) => image.pageSeq));
}

/** 某拓本的待扫占位记录（旧数据升级补的） */
export function pendingPlaceholdersOf(images: ScanImage[], rubbingId: string): ScanImage[] {
  return images.filter((image) => image.rubbingId === rubbingId && image.state === 'pendingScan');
}

/* ------------------------------ 批次接收 ------------------------------ */

/** 影像组批次明细的单行（导入 JSON 结构） */
export interface ScanBatchItemInput {
  collectionNo: string;
  pageSeq: number;
  imageNo?: string;
  fileName?: string;
  /** 扫描轮次：缺省 1（首扫），>=2 表示重扫 */
  scanRound?: number;
  /** true 表示该页缺页登记（无影像件，占页序） */
  missing?: boolean;
  note?: string;
}

export interface ScanBatchInput {
  batchNo: string;
  scannedAt?: string;
  source?: string;
  note?: string;
  items: ScanBatchItemInput[];
}

export interface ReceiveBatchResult {
  batch: ScanBatch;
  /** 认上并挂接 / 替换 / 缺页登记的件数 */
  attachedCount: number;
  /** 重扫换件数（旧件转 superseded） */
  rescanCount: number;
  /** 缺页登记件数 */
  missingCount: number;
  /** 核销的待扫占位数 */
  placeholderClosedCount: number;
  /** 重扫后挂起待复核的旧字位数 */
  pendingLossCount: number;
  /** 认不上拓本、单列待认领的明细行 */
  unmatched: ScanBatchItemInput[];
}

/** 批次接收结果的概要文案 */
export function describeReceiveResult(result: ReceiveBatchResult): string {
  return [
    `认挂 ${result.attachedCount} 件`,
    `重扫换件 ${result.rescanCount}`,
    `缺页登记 ${result.missingCount}`,
    `核销占位 ${result.placeholderClosedCount}`,
    `挂起待复核字位 ${result.pendingLossCount}`,
    result.unmatched.length > 0 ? `认不上 ${result.unmatched.length} 件（已单列）` : '',
  ]
    .filter((part) => part.length > 0)
    .join('　');
}

function validateItem(item: ScanBatchItemInput, index: number): string {
  if (typeof item !== 'object' || item === null) return `第 ${index + 1} 行不是对象`;
  if (normalizeCollectionNo(String(item.collectionNo ?? '')).length === 0)
    return `第 ${index + 1} 行缺少收藏号 collectionNo`;
  if (!Number.isFinite(item.pageSeq) || item.pageSeq < 1) return `第 ${index + 1} 行页序 pageSeq 非法`;
  if (!item.missing && normalizeCollectionNo(String(item.imageNo ?? '')).length === 0)
    return `第 ${index + 1} 行（${item.collectionNo} 第 ${item.pageSeq} 页）缺少影像号 imageNo`;
  return '';
}

/** 校验影像组批次 JSON，返回错误文案（空串表示通过） */
export function validateScanBatchInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const batch = input as Partial<ScanBatchInput>;
  if (normalizeCollectionNo(String(batch.batchNo ?? '')).length === 0) return '批次缺少批次号 batchNo';
  if (!Array.isArray(batch.items) || batch.items.length === 0) return '批次明细 items 为空';
  const seen = new Set<string>();
  for (let index = 0; index < batch.items.length; index += 1) {
    const item = batch.items[index] as ScanBatchItemInput;
    const error = validateItem(item, index);
    if (error) return error;
    const dedupeKey = `${normalizeCollectionNo(item.collectionNo)}#${item.pageSeq}#${item.missing ? 'm' : 'i'}`;
    if (seen.has(dedupeKey)) return `第 ${index + 1} 行收藏号 + 页序重复：${item.collectionNo} 第 ${item.pageSeq} 页`;
    seen.add(dedupeKey);
  }
  return '';
}

/**
 * 接收一批扫描件（在一个 IndexedDB 事务内完成，失败整体回滚）。
 * 幂等边界：batchNo 已存在即整批拒收 —— 影像组写库失败后重试同批，编目台不跟着改。
 */
export async function receiveScanBatch(input: ScanBatchInput): Promise<ReceiveBatchResult> {
  const existed = await db.scanBatches.where('batchNo').equals(input.batchNo).first();
  if (existed) {
    throw new Error(`批次 ${input.batchNo} 已接收过；影像侧重试同一批不会在编目台重复入账`);
  }

  const now = Date.now();
  const batchId = `scanbatch_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const batch: ScanBatch = {
    id: batchId,
    batchNo: input.batchNo,
    scannedAt: input.scannedAt ?? new Date().toISOString().slice(0, 10),
    source: input.source ?? '影像组',
    note: input.note ?? '',
    createdAt: now,
    updatedAt: now,
  };

  const result: ReceiveBatchResult = {
    batch,
    attachedCount: 0,
    rescanCount: 0,
    missingCount: 0,
    placeholderClosedCount: 0,
    pendingLossCount: 0,
    unmatched: [],
  };

  const newImages: ScanImage[] = [];
  const supersedeImageIds: string[] = [];
  const pendingLossIds = new Set<string>();
  const removePlaceholderIds: string[] = [];

  // 同批内（收藏号,页序）只取首条，重复明细忽略，避免重试 / 脏数据重复挂接
  const seenKeys = new Set<string>();

  await db.transaction(
    'rw',
    [db.scanBatches, db.scanImages, db.rubbings, db.losses],
    async () => {
      const rubbings = await db.rubbings.toArray();
      const byCollectionNo = new Map<string, Rubbing>();
      rubbings.forEach((rubbing) => {
        const key = normalizeCollectionNo(rubbing.collectionNo);
        if (key.length > 0 && !byCollectionNo.has(key)) byCollectionNo.set(key, rubbing);
      });

      for (const item of input.items) {
        const collectionNo = normalizeCollectionNo(String(item.collectionNo));
        const rubbing = byCollectionNo.get(collectionNo);
        if (!rubbing) {
          result.unmatched.push(item);
          continue;
        }

        const missing = Boolean(item.missing);
        const scanRound = missing ? 1 : Math.max(1, Math.trunc(item.scanRound ?? 1));
        const dedupeKey = `${rubbing.id}#${item.pageSeq}#${missing ? 'm' : 'i'}#${scanRound}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);

        // 认上后核销该拓本的待扫占位（升级补的占位等真扫描件）
        const rubbingImages = await db.scanImages.where('rubbingId').equals(rubbing.id).toArray();
        rubbingImages
          .filter((image) => image.state === 'pendingScan')
          .forEach((image) => removePlaceholderIds.push(image.id));

        const liveSamePage = rubbingImages.filter(
          (image) => isLiveImage(image) && image.pageSeq === item.pageSeq,
        );

        const baseImage: ScanImage = {
          id: `scanimg_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          batchId,
          batchNo: input.batchNo,
          pageSeq: item.pageSeq,
          imageNo: missing ? '' : normalizeCollectionNo(String(item.imageNo ?? '')),
          fileName: missing ? '' : String(item.fileName ?? item.imageNo ?? ''),
          scanRound: missing ? 1 : scanRound,
          rescanBatchNo: scanRound > 1 ? input.batchNo : '',
          collectionNo,
          rubbingId: rubbing.id,
          state: missing ? 'missing' : 'attached',
          replacesImageId: null,
          note: String(item.note ?? ''),
          createdAt: now,
          updatedAt: now,
        };

        if (missing) {
          // 重扫把缺页补上时会发一条非缺页的新轮次件，走替换分支；这里只处理报备缺页
          if (liveSamePage.some((image) => image.state === 'missing')) continue;
          newImages.push(baseImage);
          result.missingCount += 1;
          continue;
        }

        // 重扫换件：同页已有影像（非缺页），旧件转已替换，新件挂接
        const attachedSamePage = liveSamePage.filter((image) => image.state === 'attached');
        if (scanRound > 1 && attachedSamePage.length > 0) {
          const newest = [...attachedSamePage].sort((a, b) => b.scanRound - a.scanRound)[0] as ScanImage;
          baseImage.replacesImageId = newest.id;
          supersedeImageIds.push(newest.id);
          result.rescanCount += 1;

          // 旧件页上按旧件标的损泐字位全部挂起待复核（已复核的不重复挂）
          const pageLosses = await db.losses.where('rubbingId').equals(rubbing.id).toArray();
          pageLosses
            .filter((loss) => loss.pageSeq === item.pageSeq && loss.reviewState !== 'pending')
            .forEach((loss) => pendingLossIds.add(loss.id));
        }

        newImages.push(baseImage);
        result.attachedCount += 1;
      }

      if (removePlaceholderIds.length > 0) {
        const uniqueIds = Array.from(new Set(removePlaceholderIds));
        await db.scanImages.bulkDelete(uniqueIds);
        result.placeholderClosedCount = uniqueIds.length;
      }
      if (supersedeImageIds.length > 0) {
        const rows = await db.scanImages.bulkGet(supersedeImageIds);
        await db.scanImages.bulkPut(
          rows
            .filter((row): row is ScanImage => row !== undefined)
            .map((row) => ({ ...row, state: 'superseded' as ScanImageState, updatedAt: now })),
        );
      }
      if (pendingLossIds.size > 0) {
        const rows = await db.losses.bulkGet(Array.from(pendingLossIds));
        await db.losses.bulkPut(
          rows
            .filter((row): row is Loss => row !== undefined)
            .map((row) => ({
              ...row,
              reviewState: 'pending' as const,
              pendingFromBatchNo: input.batchNo,
              updatedAt: now,
            })),
        );
        result.pendingLossCount = pendingLossIds.size;
      }
      await db.scanImages.bulkPut(newImages);
      await db.scanBatches.put(batch);
    },
  );

  return result;
}
