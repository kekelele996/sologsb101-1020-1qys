/**
 * useLossDiff()：按字位坐标比对两个拓本的损泐集合，输出差异清单与差异计数
 * 被比对页（/compare）与字位页（/losses）消费。
 * 缺页规则：任一方待补扫页上的字位对不齐，标记 excluded 且不计入差异字数。
 */
import { useCallback, useMemo } from 'react';
import { useAppSelector } from '@/stores/store';
import { selectLosses } from '@/stores/lossSlice';
import { selectMissingPages } from '@/stores/scanSlice';
import {
  diffLosses,
  matchConclusion,
  type LossDiffResult,
  type LossDiffRow,
} from '@/utils/collate';
import type { CompareConclusion } from '@/types/compare';

export interface UseLossDiffResult {
  /** 当前 A/B 选择的比对结果 */
  result: LossDiffResult;
  /** 差异行（仅 A / 仅 B / 程度不同；不含缺页排除项） */
  diffRows: LossDiffRow[];
  /** 因缺页被排除的差异行（挂出提示，不计入差异字数） */
  excludedRows: LossDiffRow[];
  /** 一致性行 */
  sameRows: LossDiffRow[];
  /** 由差异推得的断代结论 */
  suggestedConclusion: CompareConclusion;
  /** 差异字数（已剔除缺页字位） */
  diffCount: number;
  /** 指定两个拓本做比对（供字位页按需调用） */
  diffOf: (rubbingIdA: string, rubbingIdB: string) => LossDiffResult;
  /** 指定拓本的损泐条数 */
  lossCountOf: (rubbingId: string) => number;
}

const EMPTY_RESULT: LossDiffResult = {
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

export function useLossDiff(rubbingIdA?: string, rubbingIdB?: string): UseLossDiffResult {
  const losses = useAppSelector(selectLosses);
  const missingPages = useAppSelector(selectMissingPages);

  const missingByRubbing = useMemo(() => {
    const map = new Map<string, Set<number>>();
    missingPages.forEach((row) => {
      if (row.state !== 'open') return;
      const set = map.get(row.rubbingId) ?? new Set<number>();
      set.add(row.pageNo);
      map.set(row.rubbingId, set);
    });
    return map;
  }, [missingPages]);

  const diffOf = useCallback(
    (idA: string, idB: string): LossDiffResult =>
      diffLosses(
        losses.filter((loss) => loss.rubbingId === idA),
        losses.filter((loss) => loss.rubbingId === idB),
        {
          missingPagesA: missingByRubbing.get(idA),
          missingPagesB: missingByRubbing.get(idB),
        },
      ),
    [losses, missingByRubbing],
  );

  const result = useMemo<LossDiffResult>(() => {
    if (!rubbingIdA || !rubbingIdB) return { ...EMPTY_RESULT };
    return diffOf(rubbingIdA, rubbingIdB);
  }, [diffOf, rubbingIdA, rubbingIdB]);

  const diffRows = useMemo(
    () => result.rows.filter((row) => row.diffKind !== 'same' && !row.excluded),
    [result],
  );
  const excludedRows = useMemo(() => result.rows.filter((row) => row.excluded), [result]);
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
