/**
 * <DigitizeTag> 数字化进度标签
 * 待扫（无件）/ 扫描中（有件但页序未齐）/ 数字化完成（页序凑齐）。
 * 被扫描页、拓本登记页与碑刻台账消费。
 */
import { Tag, Tooltip } from 'antd';
import {
  DIGITIZE_STATE_COLOR,
  DIGITIZE_STATE_LABEL,
  type DigitizeState,
} from '@/types/scanImage';

export interface DigitizeTagProps {
  state: DigitizeState;
  /** 悬浮补充：如「缺第 2 页」 */
  detail?: string;
}

export function DigitizeTag({ state, detail }: DigitizeTagProps) {
  const tag = <Tag color={DIGITIZE_STATE_COLOR[state]}>{DIGITIZE_STATE_LABEL[state]}</Tag>;
  return detail ? <Tooltip title={detail}>{tag}</Tooltip> : tag;
}

export default DigitizeTag;
