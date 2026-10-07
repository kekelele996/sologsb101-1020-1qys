/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Loss 增加 charNo 与复合索引，并按行号顺序重建历史字位记录
 *   v2 → v3：接入扫描批次 —— 新增 scanBatches / scanImages / missingPages 三张表，
 *            Loss 增加 pageNo / reviewState；旧拓本无影像号，按收藏号补「待扫」占位，补不上（无收藏号）不单列占位。
 * - 业务表的增删改查、扫描批次幂等接入与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import type { ScanBatch, ScanBatchInput } from '@/types/scanBatch';
import type { ScanImage } from '@/types/scanImage';
import type { MissingPage } from '@/types/missingPage';
import { sortLosses } from './collate';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbrubbing';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbrubbing:db-version',
  lastBackupAt: 'gbrubbing:last-backup-at',
  uiPrefs: 'gbrubbing:ui-prefs',
} as const;

export interface UiPrefs {
  lastSteleId: string | null;
  lastRubbingId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastSteleId: null, lastRubbingId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      lastSteleId: typeof parsed.lastSteleId === 'string' ? parsed.lastSteleId : null,
      lastRubbingId: typeof parsed.lastRubbingId === 'string' ? parsed.lastRubbingId : null,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class RubbingDatabase extends Dexie {
  steles!: Table<Stele, string>;
  rubbings!: Table<Rubbing, string>;
  losses!: Table<Loss, string>;
  seals!: Table<Seal, string>;
  compares!: Table<Compare, string>;
  scanBatches!: Table<ScanBatch, string>;
  scanImages!: Table<ScanImage, string>;
  missingPages!: Table<MissingPage, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史字位记录仅有 lineNo）
    this.version(1).stores({
      steles: 'id, title, era, form, updatedAt',
      rubbings: 'id, steleId, versionNo, method, state, updatedAt',
      losses: 'id, rubbingId, lineNo, type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, updatedAt',
    });

    // v2：Loss 增加 charNo 与 [rubbingId+lineNo+charNo] 复合索引，并按行号顺序重建历史字位记录
    this.version(2)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const table = tx.table<Loss>('losses');
        const all = await table.toArray();
        const byRubbing = new Map<string, Loss[]>();
        all.forEach((loss) => {
          byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]);
        });
        const rebuilt: Loss[] = [];
        byRubbing.forEach((list) => {
          // 按行号排序后，为缺失 charNo 的历史记录在行内顺序补位
          const sorted = [...list].sort((a, b) => a.lineNo - b.lineNo);
          const counter = new Map<number, number>();
          sorted.forEach((loss) => {
            const used = counter.get(loss.lineNo) ?? 0;
            const charNo = typeof loss.charNo === 'number' && loss.charNo > 0 ? loss.charNo : used + 1;
            counter.set(loss.lineNo, Math.max(used, charNo));
            rebuilt.push({ ...loss, charNo, updatedAt: Date.now() });
          });
        });
        await table.bulkPut(sortLosses(rebuilt));
      });

    // v3：接入扫描批次 —— 新增 scanBatches / scanImages / missingPages；
    // Loss 增加 pageNo 与 reviewState；旧拓本按收藏号补一条「待扫」占位，无收藏号的补不上。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, collectionNo, updatedAt',
        losses:
          'id, rubbingId, lineNo, charNo, pageNo, reviewState, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
        scanBatches: 'id, batchNo, state, scannedAt, updatedAt',
        scanImages: 'id, rubbingId, collectionNo, imageNo, batchNo, pageNo, status, updatedAt',
        missingPages: 'id, rubbingId, state, batchNo, pageNo, updatedAt',
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        const lossTable = tx.table<Loss>('losses');
        const legacyLosses = await lossTable.toArray();
        // 历史字位没有页序与复核状态：默认第 1 页、有效
        await lossTable.bulkPut(
          sortLosses(
            legacyLosses.map((loss) => ({
              ...loss,
              pageNo: typeof loss.pageNo === 'number' && loss.pageNo > 0 ? loss.pageNo : 1,
              reviewState: loss.reviewState === 'pending' ? 'pending' : 'active',
              reviewReason: loss.reviewReason ?? '',
              markedImageNo: loss.markedImageNo ?? '',
              updatedAt: now,
            })),
          ),
        );

        // 旧数据没写影像号：按收藏号补一条「待扫」占位，补不上（无收藏号）留待扫描页单列
        const rubbingTable = tx.table<Rubbing>('rubbings');
        const imageTable = tx.table<ScanImage>('scanImages');
        const legacyRubbings = await rubbingTable.toArray();
        const placeholders: ScanImage[] = legacyRubbings
          .filter((rubbing) => rubbing.collectionNo.trim().length > 0)
          .map((rubbing) => ({
            id: `img_ph_${rubbing.id}`,
            rubbingId: rubbing.id,
            collectionNo: rubbing.collectionNo.trim(),
            imageNo: '',
            pageNo: 0,
            pageCount: 0,
            rescan: false,
            batchNo: '',
            status: 'pending',
            replacedByImageNo: '',
            fileName: '旧数据升级补登：待扫',
            attachedAt: 0,
            createdAt: now,
            updatedAt: now,
          }));
        if (placeholders.length > 0) await imageTable.bulkPut(placeholders);
      });
  }
}

export const db = new RubbingDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/* ------------------------------ 扫描批次接入 ------------------------------ */

/** 接批结果：供页面汇总「认上几页 / 未认上 / 缺页 / 重扫 / 重试跳过」 */
export interface ApplyScanResult {
  batchNo: string;
  /** applied：本批首次接入；skipped：影像组写库失败后重试，整批跳过，编目台未跟随修改 */
  outcome: 'applied' | 'skipped';
  retried: number;
  matchedImages: number;
  unmatchedImages: number;
  rescannedImages: number;
  pendingLosses: number;
  filledPages: number;
  openMissingPages: number;
  /** 未认上的收藏号（补不上，单列） */
  unmatchedCollectionNos: string[];
}

/**
 * 接入一个扫描批次（影像组写库的本地对应物）。
 * 幂等：批次号已接入时只把 retried + 1、批次状态置 skipped，不动任何影像 / 缺页 / 字位 ——
 * 即「影像组写库失败后重试这一批，编目台那份不跟着改」。
 */
export async function applyScanBatch(input: ScanBatchInput): Promise<ApplyScanResult> {
  const batchNo = input.batchNo.trim();
  const now = Date.now();

  return db.transaction(
    'rw',
    [db.scanBatches, db.scanImages, db.missingPages, db.losses, db.rubbings],
    async (): Promise<ApplyScanResult> => {
      const existed = await db.scanBatches.where('batchNo').equals(batchNo).first();
      if (existed) {
        const retried = existed.retried + 1;
        await db.scanBatches.put({
          ...existed,
          state: 'skipped',
          retried,
          updatedAt: now,
        });
        return {
          batchNo,
          outcome: 'skipped',
          retried,
          matchedImages: 0,
          unmatchedImages: 0,
          rescannedImages: 0,
          pendingLosses: 0,
          filledPages: 0,
          openMissingPages: 0,
          unmatchedCollectionNos: [],
        };
      }

      const allRubbings = await db.rubbings.toArray();
      const byCollectionNo = new Map<string, Rubbing>();
      allRubbings.forEach((rubbing) => {
        const no = rubbing.collectionNo.trim();
        if (no.length > 0 && !byCollectionNo.has(no)) byCollectionNo.set(no, rubbing);
      });

      const result: ApplyScanResult = {
        batchNo,
        outcome: 'applied',
        retried: 0,
        matchedImages: 0,
        unmatchedImages: 0,
        rescannedImages: 0,
        pendingLosses: 0,
        filledPages: 0,
        openMissingPages: 0,
        unmatchedCollectionNos: [],
      };

      const imagesToPut: ScanImage[] = [];
      /** 本批认上的拓本 → 该拓本本批各页的最新影像件 */
      const touched = new Map<
        string,
        { collectionNo: string; pageCount: number; pages: Map<number, ScanBatchInput['items'][number]> }
      >();

      input.items.forEach((item) => {
        const collectionNo = item.collectionNo.trim();
        const imageNo = item.imageNo.trim();
        const rescan = item.rescan === true;
        const unmatchedRubbing = byCollectionNo.get(collectionNo);
        const seq = imagesToPut.length;

        if (!unmatchedRubbing) {
          // 认不上：单列，不挂任何拓本
          imagesToPut.push({
            id: `img_${batchNo}_${seq}`,
            rubbingId: '',
            collectionNo,
            imageNo,
            pageNo: item.pageNo,
            pageCount: item.pageCount,
            rescan,
            batchNo,
            status: 'unmatched',
            replacedByImageNo: '',
            fileName: item.fileName ?? '',
            attachedAt: 0,
            createdAt: now,
            updatedAt: now,
          });
          result.unmatchedImages += 1;
          if (!result.unmatchedCollectionNos.includes(collectionNo)) result.unmatchedCollectionNos.push(collectionNo);
          return;
        }

        result.matchedImages += 1;
        if (rescan) result.rescannedImages += 1;
        imagesToPut.push({
          id: `img_${batchNo}_${seq}`,
          rubbingId: unmatchedRubbing.id,
          collectionNo,
          imageNo,
          pageNo: item.pageNo,
          pageCount: item.pageCount,
          rescan,
          batchNo,
          status: 'active',
          replacedByImageNo: '',
          fileName: item.fileName ?? '',
          attachedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        const entry =
          touched.get(unmatchedRubbing.id) ??
          { collectionNo, pageCount: item.pageCount, pages: new Map() };
        entry.pageCount = Math.max(entry.pageCount, item.pageCount);
        entry.pages.set(item.pageNo, item);
        touched.set(unmatchedRubbing.id, entry);
      });

      // 换上同页旧影像件：有效件 → superseded；该拓本首次认到真实扫描件时，
      // 升级时按收藏号补的「待扫」占位（pageNo=0）一并换下。重扫仅发生在本批标了 rescan 的页。
      const existingImages = await db.scanImages.toArray();
      const superseded: ScanImage[] = [];
      touched.forEach((entry, rubbingId) => {
        // 首次接批：待扫占位整体换下
        existingImages
          .filter((image) => image.rubbingId === rubbingId && image.status === 'pending')
          .forEach((placeholder) => {
            superseded.push({
              ...placeholder,
              status: 'superseded',
              replacedByImageNo: entry.pages.values().next().value?.imageNo.trim() ?? '',
              updatedAt: now,
            });
          });
        entry.pages.forEach((item) => {
          const current = existingImages.find(
            (image) => image.rubbingId === rubbingId && image.pageNo === item.pageNo && image.status === 'active',
          );
          if (current) {
            superseded.push({
              ...current,
              status: 'superseded',
              replacedByImageNo: item.imageNo.trim(),
              updatedAt: now,
            });
          }
        });
      });

      // 缺页台账：本批覆盖到的 open 缺页补齐；仍缺的页保留 / 新建 open 记录。
      // 判定页序要并入库中已有的 active 影像 —— 补扫批通常只交缺的那几页，不能把旧页误判成新缺页。
      const allMissing = await db.missingPages.toArray();
      const missingToPut: MissingPage[] = [];
      touched.forEach((entry, rubbingId) => {
        const presentBefore = new Set(
          existingImages
            .filter((image) => image.rubbingId === rubbingId && image.status === 'active')
            .map((image) => image.pageNo),
        );
        entry.pages.forEach((_item, pageNo) => presentBefore.add(pageNo));
        for (let pageNo = 1; pageNo <= entry.pageCount; pageNo += 1) {
          const openRow = allMissing.find(
            (row) => row.rubbingId === rubbingId && row.pageNo === pageNo && row.state === 'open',
          );
          if (entry.pages.has(pageNo) && openRow) {
            missingToPut.push({
              ...openRow,
              state: 'filled',
              filledBatchNo: batchNo,
              updatedAt: now,
            });
            result.filledPages += 1;
          } else if (!presentBefore.has(pageNo) && !openRow) {
            const filledBefore = allMissing.some(
              (row) => row.rubbingId === rubbingId && row.pageNo === pageNo && row.state === 'filled',
            );
            if (!filledBefore) {
              missingToPut.push({
                id: `mp_${rubbingId}_${pageNo}`,
                rubbingId,
                pageNo,
                pageCount: entry.pageCount,
                batchNo,
                state: 'open',
                filledBatchNo: '',
                createdAt: now,
                updatedAt: now,
              });
              result.openMissingPages += 1;
            }
          }
        }
      });

      // 重扫换件：按旧件标的损泐字位先挂出来待复核（只挂不删），缺页那几处不动差异结论
      const allLosses = await db.losses.toArray();
      const lossesToPut: Loss[] = [];
      touched.forEach((entry, rubbingId) => {
        const rescannedPages = new Set(
          Array.from(entry.pages.values())
            .filter((item) => item.rescan === true)
            .map((item) => item.pageNo),
        );
        if (rescannedPages.size === 0) return;
        allLosses
          .filter((loss) => loss.rubbingId === rubbingId && rescannedPages.has(loss.pageNo))
          .forEach((loss) => {
            lossesToPut.push({
              ...loss,
              reviewState: 'pending',
              reviewReason: `批次 ${batchNo} 重扫第 ${Array.from(rescannedPages).join('、')} 页后挂起，原按影像 ${loss.markedImageNo || '旧件'} 标注`,
              updatedAt: now,
            });
            result.pendingLosses += 1;
          });
      });

      const scannedAt = input.scannedAt?.trim() || new Date().toISOString().slice(0, 10);
      const batchRow: ScanBatch = {
        id: `batch_${batchNo}`,
        batchNo,
        operator: input.operator?.trim() || '',
        scannedAt,
        state: 'applied',
        retried: 0,
        summary:
          `认上 ${result.matchedImages} 页` +
          (result.unmatchedImages > 0 ? `，未认上 ${result.unmatchedImages} 页` : '') +
          (result.rescannedImages > 0 ? `，重扫 ${result.rescannedImages} 页` : '') +
          (result.openMissingPages > 0 ? `，新增缺页 ${result.openMissingPages} 处` : ''),
        createdAt: now,
        updatedAt: now,
      };

      if (superseded.length > 0) await db.scanImages.bulkPut(superseded);
      if (imagesToPut.length > 0) await db.scanImages.bulkPut(imagesToPut);
      if (missingToPut.length > 0) await db.missingPages.bulkPut(missingToPut);
      if (lossesToPut.length > 0) await db.losses.bulkPut(lossesToPut);
      await db.scanBatches.put(batchRow);

      return result;
    },
  );
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.steles.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Stele → Rubbing →（Loss / Seal）＋ Stele → Compare */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const day = 86400000;

  const steles: Stele[] = [
    {
      id: 'stele_01',
      title: '礼器碑',
      era: '东汉永寿二年',
      location: '山东曲阜孔庙',
      form: 'stele',
      sizeCm: '227×93',
      calligrapher: '佚名（隶书）',
      createdAt: now - day * 60,
      updatedAt: now - day * 3,
    },
    {
      id: 'stele_02',
      title: '石门颂',
      era: '东汉建和二年',
      location: '陕西汉中石门',
      form: 'cliff',
      sizeCm: '261×205',
      calligrapher: '王升（隶书）',
      createdAt: now - day * 48,
      updatedAt: now - day * 2,
    },
    {
      id: 'stele_03',
      title: '颜勤礼碑',
      era: '唐大历十四年',
      location: '陕西西安碑林',
      form: 'stele',
      sizeCm: '268×92',
      calligrapher: '颜真卿（楷书）',
      createdAt: now - day * 36,
      updatedAt: now - day,
    },
  ];

  const rubbings: Rubbing[] = [
    { id: 'rub_0101', steleId: 'stele_01', versionNo: 1, method: 'rub', paperType: '宣纸', inkTone: 'thick', sizeCm: '210×88', collectionNo: 'TB-0101', dateGuess: '明拓', state: 'cataloged', createdAt: now - day * 50, updatedAt: now - day * 10 },
    { id: 'rub_0102', steleId: 'stele_01', versionNo: 2, method: 'cicada', paperType: '棉连纸', inkTone: 'light', sizeCm: '208×86', collectionNo: 'TB-0102', dateGuess: '清拓', state: 'toCompare', createdAt: now - day * 44, updatedAt: now - day * 6 },
    { id: 'rub_0201', steleId: 'stele_02', versionNo: 1, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '250×196', collectionNo: 'TB-0201', dateGuess: '清中期拓', state: 'cataloged', createdAt: now - day * 40, updatedAt: now - day * 5 },
    { id: 'rub_0202', steleId: 'stele_02', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '248×194', collectionNo: 'TB-0202', dateGuess: '清晚期拓', state: 'toCatalog', createdAt: now - day * 34, updatedAt: now - day * 4 },
    { id: 'rub_0301', steleId: 'stele_03', versionNo: 1, method: 'rub', paperType: '净皮宣', inkTone: 'thick', sizeCm: '260×90', collectionNo: '', dateGuess: '民国拓', state: 'toCatalog', createdAt: now - day * 20, updatedAt: now - day * 2 },
  ];

  // 字位均落在第 1 页（演示拓本损泐集中于首页）；重扫后被挂起的字位见下方扫描批次
  const losses: Loss[] = [
    { id: 'loss_010101', rubbingId: 'rub_0101', lineNo: 3, charNo: 7, type: 'blur', severity: 'light', note: '「壽」字右下漫漶', pageNo: 1, reviewState: 'active', reviewReason: '', markedImageNo: 'IMG-0101-01', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'loss_010102', rubbingId: 'rub_0101', lineNo: 5, charNo: 2, type: 'stoneFlower', severity: 'medium', note: '石花漫及「年」字', pageNo: 1, reviewState: 'active', reviewReason: '', markedImageNo: 'IMG-0101-01', createdAt: now - day * 30, updatedAt: now - day * 29 },
    { id: 'loss_010103', rubbingId: 'rub_0101', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字缺末笔', pageNo: 1, reviewState: 'active', reviewReason: '', markedImageNo: 'IMG-0101-01', createdAt: now - day * 28, updatedAt: now - day * 28 },
    { id: 'loss_010201', rubbingId: 'rub_0102', lineNo: 3, charNo: 7, type: 'blur', severity: 'medium', note: '晚拓，「壽」字已损', pageNo: 1, reviewState: 'pending', reviewReason: `批次 SB-20260915-02 重扫第 1 页后挂起，原按影像 IMG-0102-01 标注`, markedImageNo: 'IMG-0102-01', createdAt: now - day * 24, updatedAt: now - day * 1 },
    { id: 'loss_010202', rubbingId: 'rub_0102', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字全缺（位于第 2 页，该页缺扫未补）', pageNo: 2, reviewState: 'active', reviewReason: '', markedImageNo: '', createdAt: now - day * 24, updatedAt: now - day * 22 },
    { id: 'loss_010203', rubbingId: 'rub_0102', lineNo: 12, charNo: 4, type: 'crack', severity: 'medium', note: '碑面斜裂一道', pageNo: 3, reviewState: 'active', reviewReason: '', markedImageNo: 'IMG-0102-03', createdAt: now - day * 22, updatedAt: now - day * 22 },
    { id: 'loss_020101', rubbingId: 'rub_0201', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂', pageNo: 1, reviewState: 'active', reviewReason: '', markedImageNo: 'IMG-0201-01', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_020201', rubbingId: 'rub_0202', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂（同前）', pageNo: 1, reviewState: 'active', reviewReason: '', markedImageNo: '', createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'loss_020202', rubbingId: 'rub_0202', lineNo: 6, charNo: 3, type: 'blur', severity: 'medium', note: '晚拓，「頌」字已漫漶', pageNo: 1, reviewState: 'active', reviewReason: '', markedImageNo: '', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_030101', rubbingId: 'rub_0301', lineNo: 4, charNo: 3, type: 'blur', severity: 'heavy', note: '民国拓，字口已平', pageNo: 1, reviewState: 'active', reviewReason: '', markedImageNo: '', createdAt: now - day * 10, updatedAt: now - day * 10 },
  ];

  const seals: Seal[] = [
    { id: 'seal_0101', rubbingId: 'rub_0101', sealText: '端方藏碑', position: '右下角', transcription: '端方（匋斋）收藏印', sealType: 'collection', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0102', rubbingId: 'rub_0101', sealText: '匋斋鉴赏', position: '左下角', transcription: '端方鉴赏印', sealType: 'appraisal', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0103', rubbingId: 'rub_0102', sealText: '艺风堂', position: '卷尾', transcription: '缪荃孙艺风堂藏书印', sealType: 'collection', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'seal_0201', rubbingId: 'rub_0201', sealText: '石门旧拓', position: '左上角', transcription: '藏家自钤印', sealType: 'author', createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  const compares: Compare[] = [
    // rub_0102 第 2 页缺扫：双方 L09C11 分别落在 A 第 1 页 / B 第 2 页，页序错位被排除，
    // 不计入差异字数；计入差异 3 字（L03C07 程度 / L05C02 仅 A / L12C04 仅 B）
    { id: 'cmp_0101', steleId: 'stele_01', rubbingIdA: 'rub_0101', rubbingIdB: 'rub_0102', diffCount: 3, conclusion: 'early', operator: '傅砚', date: '2026-09-20', createdAt: now - day * 5, updatedAt: now - day * 5 },
    { id: 'cmp_0201', steleId: 'stele_02', rubbingIdA: 'rub_0201', rubbingIdB: 'rub_0202', diffCount: 1, conclusion: 'late', operator: '傅砚', date: '2026-09-22', createdAt: now - day * 3, updatedAt: now - day * 3 },
  ];

  /* 扫描批次演示：
     SB-20260901-01 首批 —— rub_0101 三页齐（数字化完成）、rub_0102 缺第 2 页、rub_0201 两页齐、
     rub_0202 仅扫 1/4；另含一条收藏号 TB-9999 认不上（单列）。
     SB-20260915-02 重扫批 —— rub_0102 第 1 页重扫（旧字位挂待复核），第 2 页仍缺。
     SB-20260920-03 与首批同号的「影像组重试」由页面按钮模拟；此处再放一批补扫 rub_0202 第 2 页。 */
  const scanBatches: ScanBatch[] = [
    {
      id: 'batch_SB-20260901-01',
      batchNo: 'SB-20260901-01',
      operator: '影像组·辛夷',
      scannedAt: '2026-09-01',
      state: 'applied',
      retried: 0,
      summary: '认上 10 页，未认上 1 页，新增缺页 4 处',
      createdAt: now - day * 26,
      updatedAt: now - day * 26,
    },
    {
      id: 'batch_SB-20260915-02',
      batchNo: 'SB-20260915-02',
      operator: '影像组·辛夷',
      scannedAt: '2026-09-15',
      state: 'applied',
      retried: 0,
      summary: '认上 1 页，重扫 1 页',
      createdAt: now - day * 12,
      updatedAt: now - day * 12,
    },
    {
      id: 'batch_SB-20260918-03',
      batchNo: 'SB-20260918-03',
      operator: '影像组·青阁',
      scannedAt: '2026-09-18',
      state: 'applied',
      retried: 0,
      summary: '认上 1 页，补齐缺页 1 处，新增缺页 2 处',
      createdAt: now - day * 9,
      updatedAt: now - day * 9,
    },
  ];

  const b1 = 'SB-20260901-01';
  const b2 = 'SB-20260915-02';
  const b3 = 'SB-20260918-03';
  const scanImages: ScanImage[] = [
    // rub_0101：3 页齐
    { id: 'img_0101_01', rubbingId: 'rub_0101', collectionNo: 'TB-0101', imageNo: 'IMG-0101-01', pageNo: 1, pageCount: 3, rescan: false, batchNo: b1, status: 'active', replacedByImageNo: '', fileName: 'TB-0101_p1.tif', attachedAt: now - day * 26, createdAt: now - day * 26, updatedAt: now - day * 26 },
    { id: 'img_0101_02', rubbingId: 'rub_0101', collectionNo: 'TB-0101', imageNo: 'IMG-0101-02', pageNo: 2, pageCount: 3, rescan: false, batchNo: b1, status: 'active', replacedByImageNo: '', fileName: 'TB-0101_p2.tif', attachedAt: now - day * 26, createdAt: now - day * 26, updatedAt: now - day * 26 },
    { id: 'img_0101_03', rubbingId: 'rub_0101', collectionNo: 'TB-0101', imageNo: 'IMG-0101-03', pageNo: 3, pageCount: 3, rescan: false, batchNo: b1, status: 'active', replacedByImageNo: '', fileName: 'TB-0101_p3.tif', attachedAt: now - day * 26, createdAt: now - day * 26, updatedAt: now - day * 26 },
    // rub_0102：首批扫 1、3（缺 2）；第 1 页在 b2 重扫，旧件被换下
    { id: 'img_0102_01_old', rubbingId: 'rub_0102', collectionNo: 'TB-0102', imageNo: 'IMG-0102-01', pageNo: 1, pageCount: 3, rescan: false, batchNo: b1, status: 'superseded', replacedByImageNo: 'IMG-0102-01R', fileName: 'TB-0102_p1.tif', attachedAt: now - day * 26, createdAt: now - day * 26, updatedAt: now - day * 12 },
    { id: 'img_0102_01_new', rubbingId: 'rub_0102', collectionNo: 'TB-0102', imageNo: 'IMG-0102-01R', pageNo: 1, pageCount: 3, rescan: true, batchNo: b2, status: 'active', replacedByImageNo: '', fileName: 'TB-0102_p1_rescan.tif', attachedAt: now - day * 12, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'img_0102_03', rubbingId: 'rub_0102', collectionNo: 'TB-0102', imageNo: 'IMG-0102-03', pageNo: 3, pageCount: 3, rescan: false, batchNo: b1, status: 'active', replacedByImageNo: '', fileName: 'TB-0102_p3.tif', attachedAt: now - day * 26, createdAt: now - day * 26, updatedAt: now - day * 26 },
    // rub_0201：2 页齐
    { id: 'img_0201_01', rubbingId: 'rub_0201', collectionNo: 'TB-0201', imageNo: 'IMG-0201-01', pageNo: 1, pageCount: 2, rescan: false, batchNo: b1, status: 'active', replacedByImageNo: '', fileName: 'TB-0201_p1.tif', attachedAt: now - day * 26, createdAt: now - day * 26, updatedAt: now - day * 26 },
    { id: 'img_0201_02', rubbingId: 'rub_0201', collectionNo: 'TB-0201', imageNo: 'IMG-0201-02', pageNo: 2, pageCount: 2, rescan: false, batchNo: b1, status: 'active', replacedByImageNo: '', fileName: 'TB-0201_p2.tif', attachedAt: now - day * 26, createdAt: now - day * 26, updatedAt: now - day * 26 },
    // rub_0202：4 页，b1 扫第 1 页，b3 补第 2 页，仍缺 3、4
    { id: 'img_0202_01', rubbingId: 'rub_0202', collectionNo: 'TB-0202', imageNo: 'IMG-0202-01', pageNo: 1, pageCount: 4, rescan: false, batchNo: b1, status: 'active', replacedByImageNo: '', fileName: 'TB-0202_p1.tif', attachedAt: now - day * 26, createdAt: now - day * 26, updatedAt: now - day * 26 },
    { id: 'img_0202_02', rubbingId: 'rub_0202', collectionNo: 'TB-0202', imageNo: 'IMG-0202-02', pageNo: 2, pageCount: 4, rescan: false, batchNo: b3, status: 'active', replacedByImageNo: '', fileName: 'TB-0202_p2.tif', attachedAt: now - day * 9, createdAt: now - day * 9, updatedAt: now - day * 9 },
    // 认不上的影像件（收藏号在编目台不存在）
    { id: 'img_unmatched_01', rubbingId: '', collectionNo: 'TB-9999', imageNo: 'IMG-9999-01', pageNo: 1, pageCount: 2, rescan: false, batchNo: b1, status: 'unmatched', replacedByImageNo: '', fileName: 'TB-9999_p1.tif', attachedAt: 0, createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  const missingPages: MissingPage[] = [
    // rub_0102 第 2 页两批都未补
    { id: 'mp_rub_0102_2', rubbingId: 'rub_0102', pageNo: 2, pageCount: 3, batchNo: b1, state: 'open', filledBatchNo: '', createdAt: now - day * 26, updatedAt: now - day * 26 },
    // rub_0202 第 2 页已在 b3 补齐，3、4 仍缺
    { id: 'mp_rub_0202_2', rubbingId: 'rub_0202', pageNo: 2, pageCount: 4, batchNo: b1, state: 'filled', filledBatchNo: b3, createdAt: now - day * 26, updatedAt: now - day * 9 },
    { id: 'mp_rub_0202_3', rubbingId: 'rub_0202', pageNo: 3, pageCount: 4, batchNo: b1, state: 'open', filledBatchNo: '', createdAt: now - day * 26, updatedAt: now - day * 26 },
    { id: 'mp_rub_0202_4', rubbingId: 'rub_0202', pageNo: 4, pageCount: 4, batchNo: b1, state: 'open', filledBatchNo: '', createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.scanBatches, db.scanImages, db.missingPages],
    async () => {
      await db.steles.bulkPut(steles);
      await db.rubbings.bulkPut(rubbings);
      await db.losses.bulkPut(losses);
      await db.seals.bulkPut(seals);
      await db.compares.bulkPut(compares);
      await db.scanBatches.bulkPut(scanBatches);
      await db.scanImages.bulkPut(scanImages);
      await db.missingPages.bulkPut(missingPages);
    },
  );
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RubbingSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
  scanBatches?: ScanBatch[];
  scanImages?: ScanImage[];
  missingPages?: MissingPage[];
}

export async function exportSnapshot(): Promise<RubbingSnapshot> {
  const [steles, rubbings, losses, seals, compares, scanBatches, scanImages, missingPages] = await Promise.all([
    db.steles.toArray(),
    db.rubbings.toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.toArray(),
    db.scanBatches.toArray(),
    db.scanImages.toArray(),
    db.missingPages.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    steles,
    rubbings,
    losses,
    seals,
    compares,
    scanBatches,
    scanImages,
    missingPages,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<RubbingSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof RubbingSnapshot> = ['steles', 'rubbings', 'losses', 'seals', 'compares'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.scanBatches, db.scanImages, db.missingPages],
    async () => {
      await Promise.all([
        db.steles.clear(),
        db.rubbings.clear(),
        db.losses.clear(),
        db.seals.clear(),
        db.compares.clear(),
        db.scanBatches.clear(),
        db.scanImages.clear(),
        db.missingPages.clear(),
      ]);
    },
  );
}

export async function importSnapshot(snapshot: RubbingSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.scanBatches, db.scanImages, db.missingPages],
    async () => {
      await db.steles.bulkPut(snapshot.steles);
      await db.rubbings.bulkPut(snapshot.rubbings);
      await db.losses.bulkPut(snapshot.losses);
      await db.seals.bulkPut(snapshot.seals);
      await db.compares.bulkPut(snapshot.compares);
      // 扫描三表允许旧版备份缺省（导入后重新接批即可）
      if (snapshot.scanBatches) await db.scanBatches.bulkPut(snapshot.scanBatches);
      if (snapshot.scanImages) await db.scanImages.bulkPut(snapshot.scanImages);
      if (snapshot.missingPages) await db.missingPages.bulkPut(snapshot.missingPages);
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [steles, rubbings, losses, seals, compares, scanBatches, scanImages, missingPages] = await Promise.all([
    db.steles.count(),
    db.rubbings.count(),
    db.losses.count(),
    db.seals.count(),
    db.compares.count(),
    db.scanBatches.count(),
    db.scanImages.count(),
    db.missingPages.count(),
  ]);
  return { steles, rubbings, losses, seals, compares, scanBatches, scanImages, missingPages };
}

/** 级联删除碑刻 → 拓本 → 损泐 / 钤印 / 影像件 / 缺页 / 比对 */
export async function removeSteleCascade(steleId: string): Promise<void> {
  const rubbingIds = (await db.rubbings.where('steleId').equals(steleId).toArray()).map((row) => row.id);
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.scanImages, db.missingPages],
    async () => {
      if (rubbingIds.length > 0) {
        await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
        await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
        await db.missingPages.where('rubbingId').anyOf(rubbingIds).delete();
        await db.scanImages.where('rubbingId').anyOf(rubbingIds).delete();
      }
      await db.rubbings.where('steleId').equals(steleId).delete();
      await db.compares.where('steleId').equals(steleId).delete();
      await db.steles.delete(steleId);
    },
  );
}

/** 级联删除拓本 → 损泐 / 钤印 / 影像件 / 缺页 / 涉及的比对记录 */
export async function removeRubbingCascade(rubbingId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.rubbings, db.losses, db.seals, db.compares, db.scanImages, db.missingPages],
    async () => {
      await db.losses.where('rubbingId').equals(rubbingId).delete();
      await db.seals.where('rubbingId').equals(rubbingId).delete();
      await db.missingPages.where('rubbingId').equals(rubbingId).delete();
      await db.scanImages.where('rubbingId').equals(rubbingId).delete();
      const compares = await db.compares.toArray();
      const affected = compares.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId);
      if (affected.length > 0) await db.compares.bulkDelete(affected.map((row) => row.id));
      await db.rubbings.delete(rubbingId);
    },
  );
}

/** 重排某碑刻下拓本的版本序号，保证连续 */
export async function renumberRubbings(steleId: string): Promise<void> {
  const rows = await db.rubbings.where('steleId').equals(steleId).toArray();
  const sorted = [...rows].sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  await db.rubbings.bulkPut(sorted.map((row, index) => ({ ...row, versionNo: index + 1, updatedAt: Date.now() })));
}
