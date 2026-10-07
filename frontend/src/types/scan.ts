/**
 * 扫描批次（ScanBatch）与影像件（ScanImage）数据模型
 * 影像组按批次管理扫描件、缺页与重扫记录；编目台按批次接收，
 * 按收藏号认拓本，认上的影像件挂到拓本下，页序凑齐才算数字化完成。
 */

/**
 * 影像件状态：
 * - attached    已挂接：有效影像件，已挂到某份拓本下
 * - missing     缺页登记：批次内登记的缺页，占着页序但没有影像
 * - pendingScan 待扫占位：旧数据升级时按收藏号补的占位，等影像组扫描
 * - superseded  已替换：首扫件被重扫件替换后留痕（损泐字位据此挂起待复核）
 */
export type ScanImageState = 'attached' | 'missing' | 'pendingScan' | 'superseded';

export interface ScanBatch {
  id: string;
  /** 批次号：影像组侧的唯一标识，编目台按它幂等接收（重试同一批不重复入账） */
  batchNo: string;
  /** 扫描日期 yyyy-MM-dd */
  scannedAt: string;
  /** 来源，如「影像组」「旧数据升级补占位」 */
  source: string;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScanImage {
  id: string;
  /** 所属扫描批次 id */
  batchId: string;
  /** 批次号（冗余，便于列表展示） */
  batchNo: string;
  /** 页序，从 1 开始；数字化完成要求 1..max 连续无缺 */
  pageSeq: number;
  /** 影像号（影像组侧的影像 / 文件编号）；待扫占位与缺页登记为空 */
  imageNo: string;
  /** 影像文件名或引用标识（纯前端演示，不存二进制） */
  fileName: string;
  /** 扫描轮次：0=待扫占位，1=首扫，2+=重扫 */
  scanRound: number;
  /** 重扫来源批次号（首扫件被重扫后记录来自哪一批） */
  rescanBatchNo: string;
  /** 批次明细自带的收藏号，编目台据此认拓本 */
  collectionNo: string;
  /** 认上的拓本 id；认不上为 null（单列待认领）；待扫占位回填对应拓本 */
  rubbingId: string | null;
  state: ScanImageState;
  /** 重扫件指向被替换的旧影像件 id */
  replacesImageId: string | null;
  /** 单页备注（如缺页原因：折角待补扫） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ScanBatchDraft = Omit<ScanBatch, 'id' | 'createdAt' | 'updatedAt'>;

export const SCAN_IMAGE_STATE_LABEL: Record<ScanImageState, string> = {
  attached: '已挂接',
  missing: '缺页',
  pendingScan: '待扫占位',
  superseded: '已替换',
};

export const SCAN_IMAGE_STATE_COLOR: Record<ScanImageState, string> = {
  attached: '#2f6f4f',
  missing: '#b03a2e',
  pendingScan: '#8c8c8c',
  superseded: '#7a6a4f',
};

/** 数字化完成状态：待扫（一件影像都没有）/ 未齐（有缺页或页序断档）/ 已完成 */
export type DigitizationState = 'pending' | 'incomplete' | 'complete';

export const DIGITIZATION_STATE_LABEL: Record<DigitizationState, string> = {
  pending: '待扫',
  incomplete: '页序未齐',
  complete: '数字化完成',
};

export const DIGITIZATION_STATE_COLOR: Record<DigitizationState, string> = {
  pending: '#8c8c8c',
  incomplete: '#a8623a',
  complete: '#2f6f4f',
};
