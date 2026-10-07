/**
 * 缺页记录（MissingPage）数据模型
 * 影像组在批次里声明总页数与实际扫到的页，编目台据此登记缺页台账。
 * 页序缺的那几处不算进损泐差异字数（见 utils/collate.ts 的比对排除规则）。
 * 后续批次补扫到该页后状态置为 filled，页序凑齐拓本才算数字化完成。
 */

/** 缺页状态：待补扫 / 已补齐 */
export type MissingPageState = 'open' | 'filled';

export interface MissingPage {
  id: string;
  /** 所属拓本 id */
  rubbingId: string;
  /** 缺的页序 */
  pageNo: number;
  /** 该拓本声明的总页数 */
  pageCount: number;
  /** 来源批次号（发现缺页的批次） */
  batchNo: string;
  /** open：仍缺；filled：后续批次已补扫 */
  state: MissingPageState;
  /** 补齐该页的批次号（未补齐为空串） */
  filledBatchNo: string;
  createdAt: number;
  updatedAt: number;
}

export const MISSING_PAGE_STATE_LABEL: Record<MissingPageState, string> = {
  open: '待补扫',
  filled: '已补齐',
};

export const MISSING_PAGE_STATE_COLOR: Record<MissingPageState, string> = {
  open: '#b03a2e',
  filled: '#2f6f4f',
};
