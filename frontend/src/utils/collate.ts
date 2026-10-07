/**
 * 校勘工具
 * - 字位坐标编解码（lineNo / charNo ↔ L03C07）
 * - 损泐程度排序权重与字位排序
 * - 两份拓本损泐集合的差异清单与断代规则匹配
 */
import {
  LOSS_SEVERITY_LABEL,
  LOSS_TYPE_LABEL,
  type Loss,
  type LossSeverity,
  type LossType,
} from '@/types/loss';
import type { CompareConclusion } from '@/types/compare';

/** 字位坐标 → 可读编码 L03C07 */
export function encodeCoord(lineNo: number, charNo: number): string {
  const pad = (n: number): string => String(Math.max(1, Math.trunc(n))).padStart(2, '0');
  return `L${pad(lineNo)}C${pad(charNo)}`;
}

/** 可读编码 → 字位坐标；解析失败返回 null */
export function decodeCoord(code: string): { lineNo: number; charNo: number } | null {
  const matched = /^L(\d{1,3})C(\d{1,3})$/i.exec(code.trim());
  if (!matched) return null;
  const lineNo = Number.parseInt(matched[1] as string, 10);
  const charNo = Number.parseInt(matched[2] as string, 10);
  if (!Number.isFinite(lineNo) || !Number.isFinite(charNo)) return null;
  return { lineNo, charNo };
}

/** 严重程度权重：重 > 中 > 轻 */
export function severityWeight(severity: LossSeverity): number {
  if (severity === 'heavy') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

/** 按行号、字位排序（同字位按严重程度降序） */
export function sortLosses(losses: Loss[]): Loss[] {
  return [...losses].sort((a, b) => {
    if (a.lineNo !== b.lineNo) return a.lineNo - b.lineNo;
    if (a.charNo !== b.charNo) return a.charNo - b.charNo;
    return severityWeight(b.severity) - severityWeight(a.severity);
  });
}

/** 字位键：同一坐标视为同一字位 */
export function coordKey(loss: Pick<Loss, 'lineNo' | 'charNo'>): string {
  return `${loss.lineNo}:${loss.charNo}`;
}

export interface LossDiffRow {
  key: string;
  lineNo: number;
  charNo: number;
  /** A 拓本在该字位的损泐（可能为多条，取最重） */
  lossA: Loss | null;
  /** B 拓本在该字位的损泐 */
  lossB: Loss | null;
  /** 差异类型：仅 A / 仅 B / 程度不同 / 一致 */
  diffKind: 'onlyA' | 'onlyB' | 'severity' | 'same';
  severityDelta: number;
  /**
   * 是否因缺页被排除在差异字数之外：
   * 该字位所在页在 A / B 任一方属于待补扫缺页时，页序本身对不齐，不能算版本差异。
   */
  excluded: boolean;
  /** 排除原因（缺页方与页码） */
  excludedReason: string;
}

export interface LossDiffResult {
  rows: LossDiffRow[];
  /** 差异字数：仅 A + 仅 B + 程度不同（已剔除缺页字位，缺页不会让比对结果失真） */
  diffCount: number;
  onlyACount: number;
  onlyBCount: number;
  severityDiffCount: number;
  sameCount: number;
  /** 因页序缺失被排除的差异字位数（不计入 diffCount，单独挂出提示） */
  excludedCount: number;
  /** 涉及的拓本损泐总条数 */
  totalA: number;
  totalB: number;
}

/** 取同一字位上最严重的损泐记录 */
function heaviest(list: Loss[]): Loss | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))[0] ?? null;
}

export interface DiffLossesOptions {
  /** A 拓本待补扫的页序集合（页序缺的那几处） */
  missingPagesA?: ReadonlySet<number>;
  /** B 拓本待补扫的页序集合 */
  missingPagesB?: ReadonlySet<number>;
}

/**
 * 按字位坐标比对两个拓本的损泐集合，输出差异清单与差异计数。
 * 差异定义：一方有损泐另一方没有，或双方损泐严重程度不同。
 * 任一方该页缺扫时，字位所在页序对不齐，该行标记 excluded 且不计入差异字数。
 */
export function diffLosses(
  lossesA: Loss[],
  lossesB: Loss[],
  options: DiffLossesOptions = {},
): LossDiffResult {
  const missingPagesA = options.missingPagesA ?? new Set<number>();
  const missingPagesB = options.missingPagesB ?? new Set<number>();

  const mapA = new Map<string, Loss[]>();
  const mapB = new Map<string, Loss[]>();
  lossesA.forEach((loss) => {
    const key = coordKey(loss);
    mapA.set(key, [...(mapA.get(key) ?? []), loss]);
  });
  lossesB.forEach((loss) => {
    const key = coordKey(loss);
    mapB.set(key, [...(mapB.get(key) ?? []), loss]);
  });

  const keys = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).sort((a, b) => {
    const [la, ca] = a.split(':').map((item) => Number.parseInt(item, 10));
    const [lb, cb] = b.split(':').map((item) => Number.parseInt(item, 10));
    if (la !== lb) return (la as number) - (lb as number);
    return (ca as number) - (cb as number);
  });

  const rows: LossDiffRow[] = keys.map((key) => {
    const [lineNo, charNo] = key.split(':').map((item) => Number.parseInt(item, 10)) as [number, number];
    const lossA = heaviest(mapA.get(key) ?? []);
    const lossB = heaviest(mapB.get(key) ?? []);
    const weightA = lossA ? severityWeight(lossA.severity) : 0;
    const weightB = lossB ? severityWeight(lossB.severity) : 0;
    const severityDelta = weightA - weightB;
    let diffKind: LossDiffRow['diffKind'] = 'same';
    if (lossA && !lossB) diffKind = 'onlyA';
    else if (!lossA && lossB) diffKind = 'onlyB';
    else if (severityDelta !== 0) diffKind = 'severity';

    // 缺页排除优先于 diffKind：即便双方坐标上都有标注，只要页序对不齐（缺扫 / 页码错位），
    // 该字位就不能作为版本差异依据。
    const pageA = lossA?.pageNo;
    const pageB = lossB?.pageNo;
    const reasons: string[] = [];
    let excluded = false;
    if (pageA !== undefined && missingPagesA.has(pageA)) {
      excluded = true;
      reasons.push(`A 缺第 ${pageA} 页`);
    }
    if (pageB !== undefined && missingPagesB.has(pageB)) {
      excluded = true;
      reasons.push(`B 缺第 ${pageB} 页`);
    }
    if (lossA && !lossB && pageA !== undefined && missingPagesB.has(pageA)) {
      excluded = true;
      reasons.push(`B 缺第 ${pageA} 页，无法核对`);
    }
    if (lossB && !lossA && pageB !== undefined && missingPagesA.has(pageB)) {
      excluded = true;
      reasons.push(`A 缺第 ${pageB} 页，无法核对`);
    }
    if (pageA !== undefined && pageB !== undefined && pageA !== pageB) {
      excluded = true;
      reasons.push(`页序错位（A 第 ${pageA} 页 / B 第 ${pageB} 页）`);
    }

    return {
      key,
      lineNo,
      charNo,
      lossA,
      lossB,
      diffKind,
      severityDelta,
      excluded,
      excludedReason: Array.from(new Set(reasons)).join('、'),
    };
  });

  const countable = rows.filter((row) => !row.excluded);
  const onlyACount = countable.filter((row) => row.diffKind === 'onlyA').length;
  const onlyBCount = countable.filter((row) => row.diffKind === 'onlyB').length;
  const severityDiffCount = countable.filter((row) => row.diffKind === 'severity').length;
  const excludedCount = rows.filter((row) => row.excluded).length;

  return {
    rows,
    diffCount: onlyACount + onlyBCount + severityDiffCount,
    onlyACount,
    onlyBCount,
    severityDiffCount,
    sameCount: rows.filter((row) => row.diffKind === 'same').length,
    excludedCount,
    totalA: lossesA.length,
    totalB: lossesB.length,
  };
}

/**
 * 断代规则匹配：拓本 A 相对 B 多出的损泐（仅 A 有损）说明 A 拓制更晚、石面更损；
 * 反之则 A 更早。差异全部为程度不同时按程度权重之和判断。
 */
export function matchConclusion(result: LossDiffResult): CompareConclusion {
  if (result.diffCount === 0) return 'same';
  const weightA = result.rows.reduce((sum, row) => sum + Math.max(0, row.severityDelta), 0);
  const weightB = result.rows.reduce((sum, row) => sum + Math.max(0, -row.severityDelta), 0);
  const scoreB = result.onlyACount * 2 + weightB;
  const scoreA = result.onlyBCount * 2 + weightA;
  if (scoreB === scoreA) return 'pending';
  // B 的损泐更多 → B 拓制更晚 → A 为早本
  return scoreB > scoreA ? 'early' : 'late';
}

/** 差异清单文本，用于编目卡与比对记录（缺页排除项单列说明，不混进差异字数） */
export function describeDiffRows(result: LossDiffResult, limit = 20): string[] {
  return result.rows
    .filter((row) => row.diffKind !== 'same' && !row.excluded)
    .slice(0, limit)
    .map((row) => {
      const a = row.lossA
        ? `${LOSS_TYPE_LABEL[row.lossA.type as LossType]}(${LOSS_SEVERITY_LABEL[row.lossA.severity]})`
        : '无损泐';
      const b = row.lossB
        ? `${LOSS_TYPE_LABEL[row.lossB.type as LossType]}(${LOSS_SEVERITY_LABEL[row.lossB.severity]})`
        : '无损泐';
      return `${encodeCoord(row.lineNo, row.charNo)}　A：${a}　B：${b}`;
    });
}

/** 把损泐按行分组，用于网格标注 */
export function groupByLine(losses: Loss[]): Array<{ lineNo: number; items: Loss[] }> {
  const map = new Map<number, Loss[]>();
  sortLosses(losses).forEach((loss) => {
    map.set(loss.lineNo, [...(map.get(loss.lineNo) ?? []), loss]);
  });
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([lineNo, items]) => ({ lineNo, items }));
}

/** 网格最大字位，用于渲染标注网格 */
export function maxCharNo(losses: Loss[]): number {
  return losses.reduce((max, loss) => Math.max(max, loss.charNo), 8);
}

/** 拓本版本序号展示文案 */
export function versionLabel(versionNo: number): string {
  return `第 ${versionNo} 版`
}
