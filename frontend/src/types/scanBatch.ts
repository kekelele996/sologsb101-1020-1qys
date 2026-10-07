/**
 * 扫描批次（ScanBatch）数据模型
 * 影像组按批次管理扫描件、缺页与重扫记录；编目台按批次接入。
 * 批次写入幂等：已接入的批次重试时整批跳过（retried + 1），不重复改动编目台数据。
 */

/** 批次状态：已接入（写库成功）/ 重试跳过（影像组写库失败后重试，编目台不再改） */
export type ScanBatchState = 'applied' | 'skipped';

export interface ScanBatch {
  id: string;
  /** 影像组批次号，同号重复接入时整批跳过 */
  batchNo: string;
  /** 扫描操作员（影像组） */
  operator: string;
  /** 批次生成日期 yyyy-MM-dd */
  scannedAt: string;
  /** applied：首次接入；skipped：重复批次重试，编目台未跟随修改 */
  state: ScanBatchState;
  /** 重试次数：首次接入为 0，每重试一次同号批次 +1 */
  retried: number;
  /** 接入时的汇总信息（条数、认上 / 未认上等） */
  summary: string;
  createdAt: number;
  updatedAt: number;
}

/** 批次明细（影像组提交格式，随批次一起接入） */
export interface ScanBatchItemInput {
  /** 收藏号：编目台据此认拓本 */
  collectionNo: string;
  /** 影像号（影像组侧唯一编号） */
  imageNo: string;
  /** 页序，从 1 开始；页序凑齐才算数字化完成 */
  pageNo: number;
  /** 是否重扫件：true 时替换同页旧影像件并触发旧标注待复核 */
  rescan?: boolean;
  /** 该拓本声明的总页数（用于页序齐全判定与缺页台账） */
  pageCount: number;
  /** 文件名 / 备注 */
  fileName?: string;
}

/** 影像组提交的一批数据 */
export interface ScanBatchInput {
  batchNo: string;
  operator?: string;
  scannedAt?: string;
  items: ScanBatchItemInput[];
}

export const SCAN_BATCH_STATE_LABEL: Record<ScanBatchState, string> = {
  applied: '已接入',
  skipped: '重试跳过',
};

export const SCAN_BATCH_STATE_COLOR: Record<ScanBatchState, string> = {
  applied: '#2f6f4f',
  skipped: '#8c8c8c',
};

/** 校验影像组批次文件结构，返回错误文案（空串表示通过） */
export function validateScanBatchInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '批次文件不是合法的 JSON 对象';
  const batch = input as Partial<ScanBatchInput>;
  if (typeof batch.batchNo !== 'string' || batch.batchNo.trim().length === 0) return '批次缺少 batchNo（批次号）';
  if (!Array.isArray(batch.items)) return '批次缺少 items 明细数组';
  for (let i = 0; i < batch.items.length; i += 1) {
    const item = batch.items[i] as Partial<ScanBatchItemInput> | undefined;
    const where = `第 ${i + 1} 条明细`;
    if (!item || typeof item !== 'object') return `${where} 不是对象`;
    if (typeof item.collectionNo !== 'string' || item.collectionNo.trim().length === 0) return `${where} 缺少收藏号`;
    if (typeof item.imageNo !== 'string' || item.imageNo.trim().length === 0) return `${where} 缺少影像号`;
    if (typeof item.pageNo !== 'number' || !Number.isInteger(item.pageNo) || item.pageNo < 1) {
      return `${where} 页序必须为 ≥ 1 的整数`;
    }
    if (typeof item.pageCount !== 'number' || !Number.isInteger(item.pageCount) || item.pageCount < 1) {
      return `${where} 总页数必须为 ≥ 1 的整数`;
    }
    if (item.pageNo > item.pageCount) return `${where} 页序超出声明总页数`;
  }
  return '';
}
