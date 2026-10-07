/**
 * 扫描 slice（Redux Toolkit）
 * 维护扫描批次、影像件与缺页台账；批次按收藏号认拓本后把影像件挂到拓本下。
 * 批次写入幂等：同号批次重试只记 retried，不改动编目台任何数据。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, applyScanBatch, type ApplyScanResult } from '@/utils/db';
import type { ScanBatch, ScanBatchInput } from '@/types/scanBatch';
import type { ScanImage } from '@/types/scanImage';
import type { MissingPage } from '@/types/missingPage';
import { loadLosses } from './lossSlice';
import type { RootState } from './store';

export interface ScanState {
  batches: ScanBatch[];
  images: ScanImage[];
  missingPages: MissingPage[];
  loading: boolean;
  ready: boolean;
  error: string;
  /** 最近一次接批结果（用于页面提示重试跳过 / 认上 / 缺页） */
  lastResult: ApplyScanResult | null;
}

const initialState: ScanState = {
  batches: [],
  images: [],
  missingPages: [],
  loading: false,
  ready: false,
  error: '',
  lastResult: null,
};

export const loadScans = createAsyncThunk('scan/load', async () => {
  const [rawBatches, rawImages, rawMissing] = await Promise.all([
    db.scanBatches.toArray(),
    db.scanImages.toArray(),
    db.missingPages.toArray(),
  ]);
  // 兼容缺省字段的旧备份
  const batches: ScanBatch[] = rawBatches.map((batch) => ({
    ...batch,
    state: batch.state === 'skipped' ? 'skipped' : 'applied',
    retried: typeof batch.retried === 'number' ? batch.retried : 0,
    summary: batch.summary ?? '',
  }));
  const images: ScanImage[] = rawImages.map((image) => ({
    ...image,
    status:
      image.status === 'active' || image.status === 'pending' || image.status === 'superseded'
        ? image.status
        : image.rubbingId
          ? 'active'
          : 'unmatched',
    rescan: image.rescan === true,
    replacedByImageNo: image.replacedByImageNo ?? '',
    fileName: image.fileName ?? '',
    attachedAt: image.attachedAt ?? 0,
  }));
  const missingPages: MissingPage[] = rawMissing.map((page) => ({
    ...page,
    state: page.state === 'filled' ? 'filled' : 'open',
    filledBatchNo: page.filledBatchNo ?? '',
  }));
  batches.sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : a.scannedAt > b.scannedAt ? -1 : 0));
  images.sort((a, b) =>
    a.rubbingId === b.rubbingId ? a.pageNo - b.pageNo : a.collectionNo.localeCompare(b.collectionNo),
  );
  missingPages.sort((a, b) =>
    a.rubbingId === b.rubbingId ? a.pageNo - b.pageNo : a.rubbingId.localeCompare(b.rubbingId),
  );
  return { batches, images, missingPages };
});

/** 接入影像组批次（已接入的批次重试时整批跳过） */
export const ingestScanBatch = createAsyncThunk('scan/ingest', async (input: ScanBatchInput, { dispatch }) => {
  const result = await applyScanBatch(input);
  // 重扫会挂起旧字位，字位集合也要刷新
  await Promise.all([dispatch(loadScans()), dispatch(loadLosses())]);
  return result;
});

/** 字位复核确认：待复核 → 有效，清除挂起原因 */
export const resolveLossReviews = createAsyncThunk(
  'scan/resolveLossReviews',
  async (ids: string[], { dispatch }) => {
    if (ids.length === 0) return;
    const rows = await db.losses.where('id').anyOf(ids).toArray();
    const now = Date.now();
    await db.losses.bulkPut(
      rows.map((loss) => ({
        ...loss,
        reviewState: 'active' as const,
        reviewReason: '',
        updatedAt: now,
      })),
    );
    await dispatch(loadLosses());
  },
);

const scanSlice = createSlice({
  name: 'scan',
  initialState,
  reducers: {
    clearLastResult(state) {
      state.lastResult = null;
    },
    setScanError(state, action: PayloadAction<string>) {
      state.error = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadScans.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadScans.fulfilled, (state, action) => {
        state.batches = action.payload.batches;
        state.images = action.payload.images;
        state.missingPages = action.payload.missingPages;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadScans.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '扫描数据读取失败';
      })
      .addCase(ingestScanBatch.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(ingestScanBatch.fulfilled, (state, action) => {
        state.loading = false;
        state.lastResult = action.payload;
      })
      .addCase(ingestScanBatch.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '批次接入失败';
      });
  },
});

export const { clearLastResult, setScanError } = scanSlice.actions;

export const selectScanState = (state: RootState): ScanState => state.scan;
export const selectScanBatches = (state: RootState): ScanBatch[] => state.scan.batches;
export const selectScanImages = (state: RootState): ScanImage[] => state.scan.images;
export const selectMissingPages = (state: RootState): MissingPage[] => state.scan.missingPages;

/** 某拓本的影像件（含已换下留痕） */
export function selectImagesByRubbing(state: RootState, rubbingId: string): ScanImage[] {
  return state.scan.images.filter((image) => image.rubbingId === rubbingId);
}

export default scanSlice.reducer;
