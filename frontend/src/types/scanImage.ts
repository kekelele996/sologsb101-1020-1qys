/**
 * 扫描影像件（ScanImage）数据模型
 * 一份拓本对应若干页影像件，按收藏号从扫描批次认到拓本后挂在拓本下。
 * - active：当前有效影像件
 * - pending：旧数据没有影像号，升级时按收藏号补的「待扫」占位
 * - superseded：重扫后被换下的旧影像件（保留留痕，不直接删）
 * - unmatched：批次里认不上拓本的影像件（补不上，单列）
 */

/** 影像件状态 */
export type ScanImageStatus = 'active' | 'pending' | 'superseded' | 'unmatched';

export interface ScanImage {
  id: string;
  /** 认上的拓本 id；unmatched / pending 占位刚生成时可能为空 */
  rubbingId: string;
  /** 批次内收藏号（认拓本的依据，unmatched 时仅留存此字段） */
  collectionNo: string;
  /** 影像号（影像组侧编号，重扫件是新号） */
  imageNo: string;
  /** 页序，从 1 开始 */
  pageNo: number;
  /** 该拓本声明的总页数 */
  pageCount: number;
  /** 是否重扫件 */
  rescan: boolean;
  /** 来源批次号 */
  batchNo: string;
  /** 影像件当前状态 */
  status: ScanImageStatus;
  /** 被哪个重扫件换下（superseded 留痕） */
  replacedByImageNo: string;
  /** 文件名 / 备注 */
  fileName: string;
  /** pending 占位补挂到拓本的时间（0 表示尚未补挂） */
  attachedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type ScanImageDraft = Omit<
  ScanImage,
  'id' | 'createdAt' | 'updatedAt' | 'status' | 'replacedByImageNo' | 'attachedAt'
>;

export const SCAN_IMAGE_STATUS_LABEL: Record<ScanImageStatus, string> = {
  active: '有效',
  pending: '待扫',
  superseded: '已换下',
  unmatched: '未认上',
};

export const SCAN_IMAGE_STATUS_COLOR: Record<ScanImageStatus, string> = {
  active: '#2f6f4f',
  pending: '#8c8c8c',
  superseded: '#a8623a',
  unmatched: '#b03a2e',
};

/** 数字化进度：待扫（无任何扫描件）/ 扫描中（有件但页序未凑齐）/ 数字化完成（active 页序 1..pageCount 齐全） */
export type DigitizeState = 'waiting' | 'scanning' | 'done';

export const DIGITIZE_STATE_LABEL: Record<DigitizeState, string> = {
  waiting: '待扫',
  scanning: '扫描中',
  done: '数字化完成',
};

export const DIGITIZE_STATE_COLOR: Record<DigitizeState, string> = {
  waiting: '#8c8c8c',
  scanning: '#c9963c',
  done: '#2f6f4f',
};
