/**
 * /scans 扫描批次台（影像组 ↔ 编目台对接）
 * - 按批次接收影像组 JSON：按收藏号认拓本，认上的影像件挂到拓本下
 * - 批次幂等：影像组写库失败重试同批（同 batchNo），编目台整批拒收、不跟着改
 * - 重扫换件后旧件转「已替换」，旧件页上的损泐字位挂出待复核
 * - 页序（含缺页登记）凑齐才算数字化完成
 * - 认不上的件与旧数据补不上的待扫占位单列认领
 * 消费 ScanBatch、ScanImage、Rubbing、Loss。
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  FileSearchOutlined,
  PaperClipOutlined,
  ScanOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings, loadRubbings } from '@/stores/rubbingSlice';
import { selectLosses, loadLosses } from '@/stores/lossSlice';
import {
  claimPlaceholder,
  loadScans,
  receiveBatch,
  resolveLossRecheck,
  selectScanBatches,
  selectScanImages,
} from '@/stores/scanSlice';
import {
  DIGITIZATION_STATE_COLOR,
  DIGITIZATION_STATE_LABEL,
  SCAN_IMAGE_STATE_COLOR,
  SCAN_IMAGE_STATE_LABEL,
  type DigitizationState,
  type ScanBatch,
  type ScanImage,
} from '@/types/scan';
import {
  describeReceiveResult,
  digitizationStateOf,
  liveImagesOf,
  missingPageSeqs,
  normalizeCollectionNo,
  pendingPlaceholdersOf,
  registeredMissingPages,
  scannedPageCount,
  totalPageSeqs,
  validateScanBatchInput,
  type ScanBatchInput,
} from '@/utils/scan';
import { LOSS_REVIEW_LABEL, LOSS_TYPE_LABEL, type Loss } from '@/types/loss';
import { encodeCoord } from '@/utils/collate';

/** 批次 JSON 示例（同时作为下载模板） */
const SAMPLE_BATCH: ScanBatchInput = {
  batchNo: 'SB20261008',
  scannedAt: '2026-10-08',
  source: '影像组',
  note: '批次说明（可空）',
  items: [
    { collectionNo: 'TB-0101', pageSeq: 1, imageNo: 'IMG-0101-01', fileName: 'TB-0101_p1.tif', scanRound: 1 },
    { collectionNo: 'TB-0101', pageSeq: 2, imageNo: 'IMG-0101-02-R1', fileName: 'TB-0101_p2_rescan.tif', scanRound: 2, note: '重扫换件' },
    { collectionNo: 'TB-0202', pageSeq: 1, missing: true, note: '折角待重扫' },
  ],
};

export default function ScanDesk() {
  const { message, modal } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const fileRef = useRef<HTMLInputElement>(null);
  const [claimForm] = Form.useForm<{ collectionNo: string }>();
  const [reviewForm] = Form.useForm<{ reviewNote: string }>();
  const [claiming, setClaiming] = useState<ScanImage | null>(null);
  const [reviewing, setReviewing] = useState<Loss | null>(null);

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const losses = useAppSelector(selectLosses);
  const batches = useAppSelector(selectScanBatches);
  const images = useAppSelector(selectScanImages);

  const steleTitle = useMemo(
    () => (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? steleId,
    [steles],
  );

  const digitization = useMemo(() => {
    const map = new Map<string, DigitizationState>();
    rubbings.forEach((rubbing) => map.set(rubbing.id, digitizationStateOf(images, rubbing.id)));
    return map;
  }, [images, rubbings]);

  const pendingLosses = useMemo(() => losses.filter((loss) => loss.reviewState === 'pending'), [losses]);
  const unmatched = useMemo(() => images.filter((image) => image.rubbingId === null), [images]);
  const unclaimable = useMemo(
    () => images.filter((image) => image.state === 'pendingScan' && normalizeCollectionNo(image.collectionNo).length === 0),
    [images],
  );

  const stat = useMemo(() => {
    const complete = rubbings.filter((rubbing) => digitization.get(rubbing.id) === 'complete').length;
    const incomplete = rubbings.filter((rubbing) => digitization.get(rubbing.id) === 'incomplete').length;
    const pending = rubbings.filter((rubbing) => digitization.get(rubbing.id) === 'pending').length;
    const attached = images.filter((image) => image.state === 'attached').length;
    const missing = images.filter((image) => image.state === 'missing').length;
    const superseded = images.filter((image) => image.state === 'superseded').length;
    return { complete, incomplete, pending, attached, missing, superseded };
  }, [digitization, images, rubbings]);

  const refreshAll = async (): Promise<void> => {
    await Promise.all([dispatch(loadScans()), dispatch(loadRubbings()), dispatch(loadLosses())]);
  };

  const pickFile = (): void => fileRef.current?.click();

  const handleFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      message.error('JSON 解析失败，请确认批次文件格式');
      return;
    }
    const invalid = validateScanBatchInput(parsed);
    if (invalid) {
      message.error(invalid);
      return;
    }
    const input = parsed as ScanBatchInput;
    const existed = batches.some((batch) => batch.batchNo === input.batchNo);
    modal.confirm({
      title: `接收扫描批次 ${input.batchNo}`,
      content: existed
        ? '该批次号已接收过。影像组写库失败后重试同一批，编目台保留原批次、不会跟着改；确定再次尝试将被整批拒收。'
        : `共 ${input.items.length} 条明细，将按收藏号认拓本并挂接影像件；重扫换件会把旧损泐字位挂出待复核。`,
      okText: '接收批次',
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await dispatch(receiveBatch(input)).unwrap();
          await refreshAll();
          message.success(describeReceiveResult(result));
        } catch (error) {
          message.error(error instanceof Error ? error.message : '批次接收失败');
        }
      },
    });
  };

  const downloadTemplate = (): void => {
    const blob = new Blob([JSON.stringify(SAMPLE_BATCH, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '扫描批次模板.json';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const openClaim = (image: ScanImage): void => {
    setClaiming(image);
    claimForm.setFieldsValue({ collectionNo: image.collectionNo });
  };

  const submitClaim = async (): Promise<void> => {
    if (!claiming) return;
    const values = await claimForm.validateFields();
    const collectionNo = normalizeCollectionNo(values.collectionNo);
    if (!collectionNo) {
      message.warning('请填写收藏号');
      return;
    }
    const duplicated = rubbings.some(
      (rubbing) => normalizeCollectionNo(rubbing.collectionNo) === collectionNo && rubbing.id !== claiming.rubbingId,
    );
    if (duplicated) {
      message.error(`收藏号 ${collectionNo} 已被其他拓本占用`);
      return;
    }
    await dispatch(
      claimPlaceholder({ imageId: claiming.id, collectionNo, rubbingId: claiming.rubbingId }),
    ).unwrap();
    await refreshAll();
    message.success(claiming.rubbingId ? `已补写收藏号 ${collectionNo}，待下一批扫描件来认` : '已登记收藏号，待下一批扫描件来认');
    setClaiming(null);
  };

  const openReview = (loss: Loss): void => {
    setReviewing(loss);
    reviewForm.setFieldsValue({ reviewNote: loss.reviewNote });
  };

  const submitReview = async (reviewState: 'reconfirmed' | 'active'): Promise<void> => {
    if (!reviewing) return;
    const values = reviewForm.getFieldsValue();
    await dispatch(
      resolveLossRecheck({ id: reviewing.id, reviewState, reviewNote: values.reviewNote ?? '' }),
    ).unwrap();
    await refreshAll();
    message.success(reviewState === 'reconfirmed' ? '该字位已对照新影像件确认' : '已退回现行标注');
    setReviewing(null);
  };

  const rubbingColumns: ColumnsType<{ rubbingId: string; state: DigitizationState }> = [
    {
      title: '拓本',
      dataIndex: 'rubbingId',
      render: (rubbingId: string) => {
        const rubbing = rubbings.find((item) => item.id === rubbingId);
        if (!rubbing) return '已删除';
        return (
          <Space size={4} wrap>
            <Tag color="#2f3a34">第 {rubbing.versionNo} 版</Tag>
            <span>{steleTitle(rubbing.steleId)}</span>
          </Space>
        );
      },
    },
    { title: '收藏号', width: 120, render: (_v, record) => rubbings.find((item) => item.id === record.rubbingId)?.collectionNo || '未编' },
    {
      title: '页序',
      width: 130,
      render: (_v, record) => {
        const seqs = totalPageSeqs(images, record.rubbingId);
        const scanned = scannedPageCount(images, record.rubbingId);
        const missing = registeredMissingPages(images, record.rubbingId);
        return (
          <Space size={4} wrap>
            <span>{seqs === 0 ? '—' : `1-${seqs}`}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              影像 {scanned} 页
            </Typography.Text>
            {missing.length > 0 ? <Tag color="#b03a2e">缺页 {missing.join('、')}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '数字化状态',
      dataIndex: 'state',
      width: 140,
      render: (value: DigitizationState) => (
        <Tag color={DIGITIZATION_STATE_COLOR[value]}>{DIGITIZATION_STATE_LABEL[value]}</Tag>
      ),
    },
    {
      title: '当前影像件',
      key: 'images',
      render: (_v, record) => {
        const live = liveImagesOf(images, record.rubbingId);
        if (live.length === 0) {
          const placeholders = pendingPlaceholdersOf(images, record.rubbingId);
          return placeholders.length > 0 ? <Tag>待扫占位（等影像组批次）</Tag> : <Typography.Text type="secondary">无记录</Typography.Text>;
        }
        return (
          <Space size={4} wrap>
            {live.map((image) => (
              <Tag key={image.id} color={SCAN_IMAGE_STATE_COLOR[image.state]}>
                第 {image.pageSeq} 页{image.state === 'attached' ? ` · ${image.imageNo}` : ` · ${SCAN_IMAGE_STATE_LABEL[image.state]}`}
              </Tag>
            ))}
          </Space>
        );
      },
    },
  ];

  const rubbingRows = rubbings.map((rubbing) => ({
    key: rubbing.id,
    rubbingId: rubbing.id,
    state: digitization.get(rubbing.id) ?? 'pending',
  }));

  const batchColumns: ColumnsType<ScanBatch> = [
    { title: '批次号', dataIndex: 'batchNo', width: 190, render: (value: string) => <Tag color={value.startsWith('LEGACY') ? '#8c8c8c' : '#2f3a34'}>{value}</Tag> },
    { title: '扫描日期', dataIndex: 'scannedAt', width: 120, render: (value: string) => value || '—' },
    { title: '来源', dataIndex: 'source', width: 140 },
    {
      title: '明细',
      key: 'items',
      width: 220,
      render: (_v, record) => {
        const rows = images.filter((image) => image.batchId === record.id);
        return (
          <Space size={4} wrap>
            <Tag color="#2f6f4f">挂接 {rows.filter((image) => image.state === 'attached').length}</Tag>
            <Tag color="#b03a2e">缺页 {rows.filter((image) => image.state === 'missing').length}</Tag>
            <Tag color="#7a6a4f">替换 {rows.filter((image) => image.state === 'superseded').length}</Tag>
            <Tag>占位 {rows.filter((image) => image.state === 'pendingScan').length}</Tag>
          </Space>
        );
      },
    },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' },
  ];

  const pendingColumns: ColumnsType<Loss> = [
    {
      title: '拓本',
      dataIndex: 'rubbingId',
      width: 150,
      render: (value: string) => {
        const rubbing = rubbings.find((item) => item.id === value);
        return rubbing ? `${steleTitle(rubbing.steleId)} · 第 ${rubbing.versionNo} 版` : '已删除';
      },
    },
    { title: '页序', dataIndex: 'pageSeq', width: 80, render: (value: number) => `第 ${value} 页` },
    {
      title: '字位',
      key: 'coord',
      width: 110,
      render: (_v, record) => <Tag color="#2f3a34">{encodeCoord(record.lineNo, record.charNo)}</Tag>,
    },
    { title: '原标注', dataIndex: 'type', width: 120, render: (_v, record) => `${LOSS_TYPE_LABEL[record.type]}·${LOSS_REVIEW_LABEL[record.reviewState] === '待复核' ? '' : ''}${record.severity}` },
    { title: '触发批次', dataIndex: 'pendingFromBatchNo', width: 150, render: (value: string) => value || '—' },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_v, record) => (
        <Button size="small" type="link" icon={<FileSearchOutlined />} onClick={() => openReview(record)}>
          对照新件复核
        </Button>
      ),
    },
  ];

  const unmatchedColumns: ColumnsType<ScanImage> = [
    { title: '批次', dataIndex: 'batchNo', width: 160 },
    { title: '收藏号', dataIndex: 'collectionNo', width: 120, render: (value: string) => value || <Tag color="red">空号</Tag> },
    { title: '页序', dataIndex: 'pageSeq', width: 80, render: (value: number) => `第 ${value} 页` },
    { title: '影像号', dataIndex: 'imageNo', render: (value: string) => value || '—' },
    {
      title: '状态',
      dataIndex: 'state',
      width: 120,
      render: (value: ScanImage['state']) => <Tag color={SCAN_IMAGE_STATE_COLOR[value]}>{SCAN_IMAGE_STATE_LABEL[value]}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_v, record) => (
        <Button size="small" type="link" onClick={() => openClaim(record)}>
          {record.rubbingId ? '补写收藏号' : '登记认领'}
        </Button>
      ),
    },
  ];

  const tabItems = [
    {
      key: 'rubbings',
      label: (
        <span>
          <PaperClipOutlined /> 拓本数字化（{rubbings.length}）
        </span>
      ),
      children:
        rubbingRows.length === 0 ? (
          <EmptyPanel title="还没有拓本" description="先在拓本登记页录入拓本与收藏号，再接收影像组批次。" size="small" />
        ) : (
          <Table rowKey="key" size="small" pagination={{ pageSize: 8 }} columns={rubbingColumns} dataSource={rubbingRows} />
        ),
    },
    {
      key: 'batches',
      label: (
        <span>
          <ScanOutlined /> 扫描批次（{batches.length}）
        </span>
      ),
      children:
        batches.length === 0 ? (
          <EmptyPanel title="还没有接收过扫描批次" description="用右上角「接收批次」导入影像组的批次 JSON。" size="small" />
        ) : (
          <Table rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={batchColumns} dataSource={batches} />
        ),
    },
    {
      key: 'pending',
      label: (
        <Badge count={pendingLosses.length} size="small" offset={[6, -2]}>
          <WarningOutlined /> 待复核字位
        </Badge>
      ),
      children:
        pendingLosses.length === 0 ? (
          <EmptyPanel
            title="没有待复核字位"
            description="重扫换件后，编目员按旧件标的损泐字位会自动挂到这里，对照新影像件确认后恢复参与比对。"
            size="small"
          />
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 10 }}
              message={`${pendingLosses.length} 处字位按旧影像件标注，所在页已重扫换件`}
              description="这些位置已从差异字数中剔除并挂出；请对照新影像件逐条确认，确认无误标「已复核」，新件确无此损泐则「退回现行」。"
            />
            <Table rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={pendingColumns} dataSource={pendingLosses} />
          </>
        ),
    },
    {
      key: 'claim',
      label: (
        <Badge count={unmatched.length + unclaimable.length} size="small" offset={[6, -2]}>
          <FileSearchOutlined /> 认不上 / 待认领
        </Badge>
      ),
      children:
        unmatched.length + unclaimable.length === 0 ? (
          <EmptyPanel title="没有认不上的影像件" description="批次明细都已按收藏号认到拓本；旧拓本也都有收藏号。" size="small" />
        ) : (
          <>
            {unmatched.length > 0 ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 10 }}
                message={`${unmatched.length} 件扫描件认不上拓本（收藏号在编目台找不到）`}
                description="批次明细已留存、单列在此，不会改动任何拓本；补登记拓本或登记正确收藏号后，下一批同号件即可认上。"
              />
            ) : null}
            <Table
              rowKey="id"
              size="small"
              pagination={{ pageSize: 8 }}
              columns={unmatchedColumns}
              dataSource={[...unmatched, ...unclaimable]}
            />
          </>
        ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>扫描批次台</h2>
          <p>
            接收影像组批次：按收藏号认拓本、挂接影像件，页序（含缺页登记）凑齐才算数字化完成；
            重扫换件后旧字位挂出待复核，缺页所在字位不进差异字数。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ScanOutlined />} onClick={downloadTemplate}>
            下载批次模板
          </Button>
          <Button type="primary" icon={<CloudUploadOutlined />} onClick={pickFile}>
            接收批次
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => void handleFile(event)}
          />
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="数字化完成" value={stat.complete} suffix="份" tone="success" />
        <StatBadge label="页序未齐" value={stat.incomplete} suffix="份" tone="warning" />
        <StatBadge label="待扫" value={stat.pending} suffix="份" tone="default" />
        <StatBadge label="挂接影像" value={stat.attached} suffix="件" tone="primary" />
        <StatBadge label="缺页登记" value={stat.missing} suffix="处" tone="danger" />
        <StatBadge label="待复核字位" value={pendingLosses.length} suffix="处" tone="warning" />
        <StatBadge label="认不上 / 待认领" value={unmatched.length + unclaimable.length} suffix="件" tone="danger" />
      </div>

      <Row gutter={16} style={{ marginBottom: 14 }}>
        <Col xs={24} xl={12}>
          <Alert
            type="info"
            showIcon
            message="批次幂等"
            description="同一批次号只接收一次。影像组写库失败后重试这一批，编目台保留原批次不跟着改，重复接收会被整批拒收。"
          />
        </Col>
        <Col xs={24} xl={12}>
          <Alert
            type="warning"
            showIcon
            message="重扫与缺页"
            description="重扫换件会保留旧件记录（已替换），并把该页旧损泐字位挂起待复核；缺页登记与页序断档上的字位不进版本差异字数。"
          />
        </Col>
      </Row>

      <Card className="gb-table-card" styles={{ body: { padding: 12 } }}>
        <Tabs items={tabItems} />
      </Card>

      <Modal
        open={claiming !== null}
        title={claiming?.rubbingId ? '补写收藏号（旧拓本待扫占位）' : '登记认领认不上的影像件'}
        onCancel={() => setClaiming(null)}
        onOk={() => void submitClaim()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={claimForm} layout="vertical" preserve={false}>
          <Typography.Paragraph type="secondary">
            {claiming?.rubbingId
              ? '该拓本是旧数据、没有收藏号，待扫占位补不上。补上收藏号（同时写入拓本）后，等影像组下一批扫描件即可认上。'
              : '该件收藏号在编目台找不到对应拓本。先登记一个收藏号占位，待对应拓本入库 / 批次重发后认挂。'}
          </Typography.Paragraph>
          <Form.Item name="collectionNo" label="收藏号" rules={[{ required: true, message: '请填写收藏号' }]}>
            <Input placeholder="如：TB-0302" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={reviewing !== null}
        title={reviewing ? `复核字位 ${encodeCoord(reviewing.lineNo, reviewing.charNo)}（第 ${reviewing.pageSeq} 页）` : ''}
        onCancel={() => setReviewing(null)}
        footer={
          <Space>
            <Button onClick={() => setReviewing(null)}>取消</Button>
            <Button danger onClick={() => void submitReview('active')}>
              退回现行（新件无此损泐）
            </Button>
            <Button type="primary" onClick={() => void submitReview('reconfirmed')}>
              确认无误（已复核）
            </Button>
          </Space>
        }
        destroyOnClose
      >
        <Form form={reviewForm} layout="vertical" preserve={false}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`该字位所在页由批次 ${reviewing?.pendingFromBatchNo ?? ''} 重扫换件`}
            description="请对照新影像件确认旧标注是否仍然成立；复核期间该字位不参与差异字数统计。"
          />
          <Form.Item name="reviewNote" label="复核备注">
            <Input.TextArea rows={3} placeholder="如：新件字口清晰，原「缺末笔」不成立 / 新件仍有漫漶，位置一致" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
