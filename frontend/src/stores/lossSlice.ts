/**
 * 损泐与比对 slice（Redux Toolkit）
 * 维护字位损泐集合、比对记录与比对 A/B 选择及筛选条件。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createId, db } from '@/utils/db';
import type { Loss, LossDraft, LossSeverity, LossType } from '@/types/loss';
import type { Compare, CompareDraft } from '@/types/compare';
import { sortLosses } from '@/utils/collate';
import type { RootState } from './store';

export interface LossFilters {
  keyword: string;
  types: LossType[];
  severities: LossSeverity[];
  /** 复核状态筛选：空 = 全部 */
  reviewStates: Array<'active' | 'pending'>;
}

export interface LossState {
  items: Loss[];
  compares: Compare[];
  loading: boolean;
  ready: boolean;
  error: string;
  filters: LossFilters;
  /** 比对台选择的两个拓本 */
  compareAId: string | null;
  compareBId: string | null;
}

const initialState: LossState = {
  items: [],
  compares: [],
  loading: false,
  ready: false,
  error: '',
  filters: { keyword: '', types: [], severities: [], reviewStates: [] },
  compareAId: null,
  compareBId: null,
};

/** 查某拓本某页当前有效影像号（重扫后新标注按新件记） */
async function activeImageNo(rubbingId: string, pageNo: number): Promise<string> {
  const image = await db.scanImages
    .where('rubbingId').equals(rubbingId)
    .and((row) => row.status === 'active' && row.pageNo === pageNo)
    .first();
  return image?.imageNo ?? '';
}

export const loadLosses = createAsyncThunk('loss/load', async () => {
  const [rawLosses, compares] = await Promise.all([db.losses.toArray(), db.compares.toArray()]);
  // 兼容 v2 时代导入的备份：补齐 pageNo / 复核字段默认值
  const losses = rawLosses.map((loss) => ({
    ...loss,
    pageNo: typeof loss.pageNo === 'number' && loss.pageNo > 0 ? loss.pageNo : 1,
    reviewState: loss.reviewState === 'pending' ? ('pending' as const) : ('active' as const),
    reviewReason: loss.reviewReason ?? '',
    markedImageNo: loss.markedImageNo ?? '',
  }));
  compares.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { losses: sortLosses(losses), compares };
});

export const createLoss = createAsyncThunk('loss/create', async (draft: LossDraft, { dispatch }) => {
  const now = Date.now();
  const row: Loss = {
    ...draft,
    id: createId('loss'),
    reviewState: 'active',
    reviewReason: '',
    markedImageNo: await activeImageNo(draft.rubbingId, draft.pageNo),
    createdAt: now,
    updatedAt: now,
  };
  await db.losses.put(row);
  await dispatch(loadLosses());
  return row;
});

export const updateLoss = createAsyncThunk(
  'loss/update',
  async (payload: { id: string; patch: Partial<Loss> }, { dispatch }) => {
    // 改到别的页时，标注依据换为该页当前有效影像件；页未变则保留原影像号
    const extra: Partial<Loss> = {};
    if (typeof payload.patch.pageNo === 'number' && typeof payload.patch.rubbingId === 'string') {
      extra.markedImageNo = await activeImageNo(payload.patch.rubbingId, payload.patch.pageNo);
    }
    await db.losses.update(payload.id, { ...payload.patch, ...extra, updatedAt: Date.now() } as never);
    await dispatch(loadLosses());
  },
);

export const removeLoss = createAsyncThunk('loss/remove', async (id: string, { dispatch }) => {
  await db.losses.delete(id);
  await dispatch(loadLosses());
});

export const batchUpdateLosses = createAsyncThunk(
  'loss/batch',
  async (payload: { ids: string[]; patch: Partial<Loss> }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const now = Date.now();
    const rows = state.loss.items
      .filter((item) => payload.ids.includes(item.id))
      .map((item) => ({ ...item, ...payload.patch, updatedAt: now }));
    if (rows.length > 0) await db.losses.bulkPut(rows);
    await dispatch(loadLosses());
  },
);

export const saveCompare = createAsyncThunk('compare/save', async (draft: CompareDraft, { dispatch }) => {
  const now = Date.now();
  const row: Compare = { ...draft, id: createId('cmp'), createdAt: now, updatedAt: now };
  await db.compares.put(row);
  await dispatch(loadLosses());
  return row;
});

export const updateCompare = createAsyncThunk(
  'compare/update',
  async (payload: { id: string; patch: Partial<Compare> }, { dispatch }) => {
    await db.compares.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    await dispatch(loadLosses());
  },
);

export const removeCompare = createAsyncThunk('compare/remove', async (id: string, { dispatch }) => {
  await db.compares.delete(id);
  await dispatch(loadLosses());
});

const lossSlice = createSlice({
  name: 'loss',
  initialState,
  reducers: {
    setLossKeyword(state, action: PayloadAction<string>) {
      state.filters.keyword = action.payload;
    },
    setLossTypes(state, action: PayloadAction<LossType[]>) {
      state.filters.types = action.payload;
    },
    setLossSeverities(state, action: PayloadAction<LossSeverity[]>) {
      state.filters.severities = action.payload;
    },
    setLossReviewStates(state, action: PayloadAction<Array<'active' | 'pending'>>) {
      state.filters.reviewStates = action.payload;
    },
    resetLossFilters(state) {
      state.filters = { keyword: '', types: [], severities: [], reviewStates: [] };
    },
    setCompareA(state, action: PayloadAction<string | null>) {
      state.compareAId = action.payload;
    },
    setCompareB(state, action: PayloadAction<string | null>) {
      state.compareBId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadLosses.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadLosses.fulfilled, (state, action) => {
        state.items = action.payload.losses;
        state.compares = action.payload.compares;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadLosses.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '损泐字位读取失败';
      });
  },
});

export const {
  setLossKeyword,
  setLossTypes,
  setLossSeverities,
  setLossReviewStates,
  resetLossFilters,
  setCompareA,
  setCompareB,
} = lossSlice.actions;

export const selectLossState = (state: RootState): LossState => state.loss;
export const selectLosses = (state: RootState): Loss[] => state.loss.items;
export const selectCompares = (state: RootState): Compare[] => state.loss.compares;

/** 派生选择器：关键字 + 类型 + 程度筛选（全库维度） */
export function selectFilteredLosses(state: RootState): Loss[] {
  const { items, filters } = state.loss;
  const keyword = filters.keyword.trim();
  return items.filter((loss) => {
    if (keyword.length > 0) {
      const haystack = `${loss.lineNo}${loss.charNo}${loss.note}`;
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.types.length > 0 && !filters.types.includes(loss.type)) return false;
    if (filters.severities.length > 0 && !filters.severities.includes(loss.severity)) return false;
    return true;
  });
}

/** 某拓本在某碑刻下的损泐条数统计 */
export function selectLossCountByRubbing(state: RootState): Record<string, number> {
  const result: Record<string, number> = {};
  state.loss.items.forEach((loss) => {
    result[loss.rubbingId] = (result[loss.rubbingId] ?? 0) + 1;
  });
  return result;
}

/** 全库待复核字位（重扫换件后挂起） */
export function selectPendingLosses(state: RootState): Loss[] {
  return state.loss.items.filter((loss) => loss.reviewState === 'pending');
}

/** 某拓本待复核字数 */
export function selectPendingCountByRubbing(state: RootState): Record<string, number> {
  const result: Record<string, number> = {};
  state.loss.items.forEach((loss) => {
    if (loss.reviewState === 'pending') result[loss.rubbingId] = (result[loss.rubbingId] ?? 0) + 1;
  });
  return result;
}

export default lossSlice.reducer;
