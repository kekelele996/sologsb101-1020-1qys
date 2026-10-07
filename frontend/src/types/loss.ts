/**
 * 损泐字位（Loss）数据模型
 * 按行号 + 字位坐标标注的损泐情况，是同碑多版本比对的比对单元。
 */

/** 损泐类型：缺字 / 裂痕 / 漫漶 / 石花 */
export type LossType = 'missing' | 'crack' | 'blur' | 'stoneFlower';

/** 严重程度：轻 / 中 / 重 */
export type LossSeverity = 'light' | 'medium' | 'heavy';

/**
 * 复核状态（重扫对账）：
 * - active      现行有效，可参与差异比对
 * - pending     待复核：该字位所在页被重扫换件，按旧件标的位置需对照新件复核；
 *               不直接算作差异，只挂出待人工确认
 * - reconfirmed 已复核：编目员已对照新影像件确认过位置
 */
export type LossReviewState = 'active' | 'pending' | 'reconfirmed';

export interface Loss {
  id: string;
  /** 所属拓本 id */
  rubbingId: string;
  /** 行号，从 1 开始 */
  lineNo: number;
  /** 字位，行内第几字，从 1 开始 */
  charNo: number;
  /** 所在扫描页序，从 1 开始（重扫按页换件、缺页按页剔除均据此） */
  pageSeq: number;
  /** 损泐类型 */
  type: LossType;
  /** 严重程度 */
  severity: LossSeverity;
  /** 复核状态 */
  reviewState: LossReviewState;
  /** 触发待复核的重扫批次号 */
  pendingFromBatchNo: string;
  /** 复核备注 */
  reviewNote: string;
  /** 释文备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type LossDraft = Omit<Loss, 'id' | 'createdAt' | 'updatedAt'>;

export const LOSS_TYPE_LABEL: Record<LossType, string> = {
  missing: '缺字',
  crack: '裂痕',
  blur: '漫漶',
  stoneFlower: '石花',
};

export const LOSS_TYPE_COLOR: Record<LossType, string> = {
  missing: '#b03a2e',
  crack: '#a8623a',
  blur: '#7a6a4f',
  stoneFlower: '#3f5d6b',
};

export const LOSS_SEVERITY_LABEL: Record<LossSeverity, string> = {
  light: '轻',
  medium: '中',
  heavy: '重',
};

export const LOSS_SEVERITY_COLOR: Record<LossSeverity, string> = {
  light: '#8fa88f',
  medium: '#c9963c',
  heavy: '#b03a2e',
};

export const LOSS_TYPE_OPTIONS: ReadonlyArray<{ value: LossType; label: string }> = [
  { value: 'missing', label: '缺字' },
  { value: 'crack', label: '裂痕' },
  { value: 'blur', label: '漫漶' },
  { value: 'stoneFlower', label: '石花' },
];

export const LOSS_SEVERITY_OPTIONS: ReadonlyArray<{ value: LossSeverity; label: string }> = [
  { value: 'light', label: '轻' },
  { value: 'medium', label: '中' },
  { value: 'heavy', label: '重' },
];

export const LOSS_REVIEW_LABEL: Record<LossReviewState, string> = {
  active: '现行',
  pending: '待复核',
  reconfirmed: '已复核',
};

export function createEmptyLossDraft(rubbingId: string, lineNo: number, charNo: number, pageSeq = 1): LossDraft {
  return {
    rubbingId,
    lineNo,
    charNo,
    pageSeq,
    type: 'missing',
    severity: 'medium',
    reviewState: 'active',
    pendingFromBatchNo: '',
    reviewNote: '',
    note: '',
  };
}
