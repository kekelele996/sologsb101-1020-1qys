/**
 * 扫描批次 slice（Redux Toolkit）
 * 维护影像组批次与影像件集合；批次接收（按收藏号认拓本）、重扫换件、
 * 旧损泐字位复核结论回写、待扫占位认领均由本 slice 统一封装。
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { db } from '@/utils/db';
import {
  receiveScanBatch,
  type ReceiveBatchResult,
  type ScanBatchInput,
} from '@/utils/scan';
import type { ScanBatch, ScanImage } from '@/types/scan';
import type { LossReviewState } from '@/types/loss';
import { loadLosses } from './lossSlice';
import type { RootState } from './store';

export interface ScanState {
  batches: ScanBatch[];
  images: ScanImage[];
  loading: boolean;
  ready: boolean;
  error: string;
}

const initialState: ScanState = {
  batches: [],
  images: [],
  loading: false,
  ready: false,
  error: '',
};

export const loadScans = createAsyncThunk('scan/load', async () => {
  const [batches, images] = await Promise.all([db.scanBatches.toArray(), db.scanImages.toArray()]);
  batches.sort((a, b) => (a.scannedAt === b.scannedAt ? b.createdAt - a.createdAt : a.scannedAt < b.scannedAt ? 1 : -1));
  images.sort((a, b) => (a.rubbingId === b.rubbingId ? a.pageSeq - b.pageSeq : a.rubbingId.localeCompare(b.rubbingId)));
  return { batches, images };
});

/** 接收影像组一批扫描件（同 batchNo 幂等：重试整批拒收，编目台不跟着改） */
export const receiveBatch = createAsyncThunk('scan/receiveBatch', async (input: ScanBatchInput) => {
  const result = (await receiveScanBatch(input)) as ReceiveBatchResult;
  return result;
});

/** 待扫占位认领：把「补不上」的占位补写收藏号（并同步拓本收藏号），等后续批次来认 */
export const claimPlaceholder = createAsyncThunk(
  'scan/claimPlaceholder',
  async (payload: { imageId: string; collectionNo: string; rubbingId: string | null }, { dispatch }) => {
    const collectionNo = payload.collectionNo.trim();
    if (!collectionNo) throw new Error('请填写收藏号');
    await db.scanImages.update(payload.imageId, {
      collectionNo,
      updatedAt: Date.now(),
    } as never);
    // 占位挂在具体拓本上时（无收藏号旧拓本），同步给拓本补上收藏号
    if (payload.rubbingId) {
      await db.rubbings.update(payload.rubbingId, { collectionNo, updatedAt: Date.now() } as never);
    }
    await dispatch(loadScans());
  },
);

/** 重扫后编目员复核旧损泐字位：回写复核结论 */
export const resolveLossRecheck = createAsyncThunk(
  'loss/resolveRecheck',
  async (
    payload: { id: string; reviewState: LossReviewState; reviewNote: string },
    { dispatch },
  ) => {
    await db.losses.update(payload.id, {
      reviewState: payload.reviewState,
      reviewNote: payload.reviewNote,
      updatedAt: Date.now(),
    } as never);
    await Promise.all([dispatch(loadScans()), dispatch(loadLosses())]);
  },
);

const scanSlice = createSlice({
  name: 'scan',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadScans.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadScans.fulfilled, (state, action) => {
        state.batches = action.payload.batches;
        state.images = action.payload.images;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadScans.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '扫描批次读取失败';
      });
  },
});

export const selectScanBatches = (state: RootState): ScanBatch[] => state.scan.batches;
export const selectScanImages = (state: RootState): ScanImage[] => state.scan.images;

/** 认不上拓本的影像件（批次明细带了收藏号但编目台没有对应拓本） */
export function selectUnmatchedImages(images: ScanImage[]): ScanImage[] {
  return images.filter((image) => image.rubbingId === null);
}

/** 旧数据升级补的待扫占位中「补不上」的（无收藏号） */
export function selectUnclaimablePlaceholders(images: ScanImage[]): ScanImage[] {
  return images.filter((image) => image.state === 'pendingScan' && image.collectionNo.length === 0);
}

export default scanSlice.reducer;
