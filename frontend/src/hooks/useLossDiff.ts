/**
 * useLossDiff()：按字位坐标比对两个拓本的损泐集合，输出差异清单与差异计数
 * 被比对页（/compare）与字位页（/losses）消费。
 * 扫描页序缺页（已登记缺页或页序断档）所在字位只展示、不计差异字数；
 * 重扫换件后挂起待复核的旧字位同样先挂出，由编目员人工确认。
 */
import { useCallback, useMemo } from 'react';
import { useAppSelector } from '@/stores/store';
import { selectLosses } from '@/stores/lossSlice';
import { selectScanImages } from '@/stores/scanSlice';
import { diffLosses, matchConclusion, type LossDiffResult, type LossDiffRow } from '@/utils/collate';
import { missingPageSeqs } from '@/utils/scan';
import type { CompareConclusion } from '@/types/compare';

export interface UseLossDiffResult {
  /** 当前 A/B 选择的比对结果 */
  result: LossDiffResult;
  /** 差异行（仅 A / 仅 B / 程度不同） */
  diffRows: LossDiffRow[];
  /** 因缺页或待复核挂出的行（不计差异字数） */
  excludedRows: LossDiffRow[];
  /** 一致性行 */
  sameRows: LossDiffRow[];
  /** 由差异推得的断代结论 */
  suggestedConclusion: CompareConclusion;
  /** 差异字数（缺页字位已剔除） */
  diffCount: number;
  /** 指定两个拓本做比对（供字位页按需调用） */
  diffOf: (rubbingIdA: string, rubbingIdB: string) => LossDiffResult;
  /** 指定拓本的损泐条数 */
  lossCountOf: (rubbingId: string) => number;
}

export function useLossDiff(rubbingIdA?: string, rubbingIdB?: string): UseLossDiffResult {
  const losses = useAppSelector(selectLosses);
  const images = useAppSelector(selectScanImages);

  const diffOf = useCallback(
    (idA: string, idB: string): LossDiffResult =>
      diffLosses(
        losses.filter((loss) => loss.rubbingId === idA),
        losses.filter((loss) => loss.rubbingId === idB),
        {
          missingPagesByRubbing: {
            A: missingPageSeqs(images, idA),
            B: missingPageSeqs(images, idB),
          },
        },
      ),
    [images, losses],
  );

  const result = useMemo<LossDiffResult>(() => {
    if (!rubbingIdA || !rubbingIdB) {
      return {
        rows: [],
        diffCount: 0,
        onlyACount: 0,
        onlyBCount: 0,
        severityDiffCount: 0,
        sameCount: 0,
        excludedCount: 0,
        totalA: 0,
        totalB: 0,
      };
    }
    return diffOf(rubbingIdA, rubbingIdB);
  }, [diffOf, rubbingIdA, rubbingIdB]);

  const diffRows = useMemo(() => result.rows.filter((row) => row.diffKind !== 'same' && row.diffKind !== 'excluded'), [result]);
  const excludedRows = useMemo(() => result.rows.filter((row) => row.diffKind === 'excluded'), [result]);
  const sameRows = useMemo(() => result.rows.filter((row) => row.diffKind === 'same'), [result]);

  const lossCountOf = useCallback(
    (rubbingId: string): number => losses.filter((loss) => loss.rubbingId === rubbingId).length,
    [losses],
  );

  return {
    result,
    diffRows,
    excludedRows,
    sameRows,
    suggestedConclusion: matchConclusion(result),
    diffCount: result.diffCount,
    diffOf,
    lossCountOf,
  };
}

export default useLossDiff;
