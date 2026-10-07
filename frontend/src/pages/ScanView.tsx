/**
 * /scans 扫描批次接入台
 * 影像组按批次提交扫描件、缺页与重扫记录；编目台按收藏号认拓本并把影像件挂到拓本下。
 * - 批次幂等：同号批次重试时整批跳过（重试跳过），编目台那份不跟着改
 * - 页序凑齐才算数字化完成；缺页单列台账
 * - 重扫换件后，原按旧件标的损泐字位挂出待复核
 * - 认不上收藏号的影像件单列
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  FileSearchOutlined,
  RedoOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import DigitizeTag from '@/components/common/DigitizeTag';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import { selectPendingLosses } from '@/stores/lossSlice';
import {
  ingestScanBatch,
  resolveLossReviews,
  selectMissingPages,
  selectScanBatches,
  selectScanImages,
} from '@/stores/scanSlice';
import {
  MISSING_PAGE_STATE_COLOR,
  MISSING_PAGE_STATE_LABEL,
} from '@/types/missingPage';
import {
  SCAN_BATCH_STATE_COLOR,
  SCAN_BATCH_STATE_LABEL,
  validateScanBatchInput,
  type ScanBatchInput,
  type ScanBatchItemInput,
} from '@/types/scanBatch';
import {
  SCAN_IMAGE_STATUS_COLOR,
  SCAN_IMAGE_STATUS_LABEL,
  type ScanImage,
} from '@/types/scanImage';
import { deriveDigitization, formatPageNos } from '@/utils/scan';
import { encodeCoord } from '@/utils/collate';

/** 演示：影像组首批（与已播种批次同号，点击接入即模拟「写库失败后重试」整批跳过） */
const DEMO_RETRY_BATCH: ScanBatchInput = {
  batchNo: 'SB-20260901-01',
  operator: '影像组·辛夷',
  scannedAt: '2026-09-01',
  items: [
    { collectionNo: 'TB-0101', imageNo: 'IMG-0101-01', pageNo: 1, pageCount: 3, fileName: 'TB-0101_p1.tif' },
  ],
};

/** 演示：补扫 TB-0102 第 2 页，缺页补齐后该拓本页序凑齐（待复核字位仍保留） */
const DEMO_REFILL_BATCH: ScanBatchInput = {
  batchNo: 'SB-20261007-09',
  operator: '影像组·青阁',
  scannedAt: '2026-10-07',
  items: [
    { collectionNo: 'TB-0102', imageNo: 'IMG-0102-02', pageNo: 2, pageCount: 3, fileName: 'TB-0102_p2.tif' },
  ],
};

export default function ScanView() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const batches = useAppSelector(selectScanBatches);
  const images = useAppSelector(selectScanImages);
  const missingPages = useAppSelector(selectMissingPages);
  const pendingLosses = useAppSelector(selectPendingLosses);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm] = Form.useForm<{
    batchNo: string;
    operator: string;
    scannedAt: string;
    collectionNo: string;
    imageNo: string;
    pageNo: number;
    pageCount: number;
    rescan: boolean;
    fileName: string;
  }>();

  const rubbingById = useMemo(() => new Map(rubbings.map((rubbing) => [rubbing.id, rubbing])), [rubbings]);
  const steleTitleOf = (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? '已删除';

  /** 按拓本聚合数字化进度 */
  const digitizeByRubbing = useMemo(() => {
    const map = new Map<string, ReturnType<typeof deriveDigitization>>();
    rubbings.forEach((rubbing) => {
      map.set(
        rubbing.id,
        deriveDigitization(
          images.filter((image) => image.rubbingId === rubbing.id),
          missingPages.filter((page) => page.rubbingId === rubbing.id),
        ),
      );
    });
    return map;
  }, [images, missingPages, rubbings]);

  const unmatched = useMemo(() => images.filter((image) => image.status === 'unmatched'), [images]);
  const noCollectionRubbings = useMemo(() => rubbings.filter((rubbing) => rubbing.collectionNo.trim().length === 0), [rubbings]);

  const stat = useMemo(() => {
    const doneCount = Array.from(digitizeByRubbing.values()).filter((info) => info.state === 'done').length;
    const scanningCount = Array.from(digitizeByRubbing.values()).filter((info) => info.state === 'scanning').length;
    const waitingCount = rubbings.length - doneCount - scanningCount;
    return {
      batches: batches.length,
      retried: batches.reduce((sum, batch) => sum + batch.retried, 0),
      doneCount,
      scanningCount,
      waitingCount,
      openMissing: missingPages.filter((page) => page.state === 'open').length,
      pendingLosses: pendingLosses.length,
      unmatched: unmatched.length,
    };
  }, [batches, digitizeByRubbing, missingPages, pendingLosses.length, rubbings.length, unmatched.length]);

  const ingest = async (input: ScanBatchInput): Promise<void> => {
    const result = await dispatch(ingestScanBatch(input)).unwrap();
    if (result.outcome === 'skipped') {
      message.warning(
        `批次 ${result.batchNo} 已接入过，本次为影像组重试（第 ${result.retried} 次）：整批跳过，编目台数据未改动。`,
      );
      return;
    }
    message.success(
      `批次 ${result.batchNo} 已接入：认上 ${result.matchedImages} 页` +
        (result.rescannedImages > 0 ? `，重扫 ${result.rescannedImages} 页` : '') +
        (result.pendingLosses > 0 ? `，挂出待复核字位 ${result.pendingLosses} 条` : '') +
        (result.filledPages > 0 ? `，补齐缺页 ${result.filledPages} 处` : '') +
        (result.openMissingPages > 0 ? `，新增缺页 ${result.openMissingPages} 处` : '') +
        (result.unmatchedImages > 0 ? `，未认上 ${result.unmatchedImages} 页（${result.unmatchedCollectionNos.join('、')}）` : ''),
    );
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      message.error('批次文件 JSON 解析失败');
      return;
    }
    const invalid = validateScanBatchInput(parsed);
    if (invalid) {
      message.error(invalid);
      return;
    }
    await ingest(parsed as ScanBatchInput);
  };

  const submitManual = async (): Promise<void> => {
    const v = await manualForm.validateFields();
    const item: ScanBatchItemInput = {
      collectionNo: v.collectionNo.trim(),
      imageNo: v.imageNo.trim(),
      pageNo: v.pageNo,
      pageCount: v.pageCount,
      rescan: v.rescan,
      fileName: v.fileName,
    };
    await ingest({
      batchNo: v.batchNo.trim(),
      operator: v.operator.trim(),
      scannedAt: v.scannedAt,
      items: [item],
    });
    setManualOpen(false);
  };

  const goRubbing = (rubbingId: string): void => {
    navigate(`${ROUTES.losses}?rubbing=${rubbingId}`);
  };

  const batchColumns: ColumnsType<(typeof batches)[number]> = [
    { title: '批次号', dataIndex: 'batchNo', width: 170 },
    { title: '扫描日期', dataIndex: 'scannedAt', width: 110 },
    { title: '影像组操作人', dataIndex: 'operator', width: 130, render: (v: string) => v || '未填' },
    {
      title: '状态',
      dataIndex: 'state',
      width: 110,
      render: (value: (typeof batches)[number]['state'], record) => (
        <TooltipState value={value} retried={record.retried} />
      ),
    },
    { title: '接入摘要', dataIndex: 'summary' },
  ];

  const digitizedColumns: ColumnsType<(typeof rubbings)[number]> = [
    {
      title: '拓本',
      key: 'rubbing',
      width: 190,
      render: (_v, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>
            {steleTitleOf(record.steleId)} · 第 {record.versionNo} 版
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            收藏号 {record.collectionNo || '未编（无法认领批次）'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '数字化进度',
      key: 'digitize',
      width: 130,
      render: (_v, record) => {
        const info = digitizeByRubbing.get(record.id);
        if (!info) return '—';
        return (
          <DigitizeTag
            state={info.state}
            detail={
              info.state === 'done'
                ? `共 ${info.pageCount} 页，页序已凑齐`
                : `缺 ${formatPageNos(info.missingPageNos)}`
            }
          />
        );
      },
    },
    {
      title: '页序',
      key: 'pages',
      render: (_v, record) => {
        const info = digitizeByRubbing.get(record.id);
        if (!info) return '—';
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text style={{ fontSize: 12 }}>
              有效 {info.activeCount} / {info.pageCount || '?'} 页
            </Typography.Text>
            {info.missingPageNos.length > 0 ? (
              <Tag color="red">{formatPageNos(info.missingPageNos)} 待补扫</Tag>
            ) : info.activeCount > 0 ? (
              <Tag color="green">页序凑齐</Tag>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                尚无影像件
              </Typography.Text>
            )}
            {info.rescanCount > 0 ? <Tag color="orange">重扫换下 {info.rescanCount} 件</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '影像件',
      key: 'images',
      width: 300,
      render: (_v, record) => (
        <Space size={4} wrap>
          {images
            .filter((image) => image.rubbingId === record.id)
            .map((image) => (
              <Tag key={image.id} color={SCAN_IMAGE_STATUS_COLOR[image.status]}>
                P{image.pageNo === 0 ? '?' : image.pageNo} · {image.imageNo || '待扫'}
                {image.status === 'active' ? '' : `（${SCAN_IMAGE_STATUS_LABEL[image.status]}）`}
              </Tag>
            ))}
          {images.filter((image) => image.rubbingId === record.id).length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              旧数据：升级时未补到待扫占位
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
  ];

  const missingColumns: ColumnsType<(typeof missingPages)[number]> = [
    {
      title: '拓本',
      key: 'rubbing',
      width: 200,
      render: (_v, record) => {
        const rubbing = rubbingById.get(record.rubbingId);
        return rubbing
          ? `${steleTitleOf(rubbing.steleId)} · 第 ${rubbing.versionNo} 版（${rubbing.collectionNo}）`
          : '已删除';
      },
    },
    { title: '缺页', dataIndex: 'pageNo', width: 90, render: (v: number) => `第 ${v} 页` },
    { title: '总页数', dataIndex: 'pageCount', width: 90 },
    { title: '发现批次', dataIndex: 'batchNo', width: 170 },
    {
      title: '状态',
      dataIndex: 'state',
      width: 110,
      render: (value: (typeof missingPages)[number]['state'], record) => (
        <Tag color={MISSING_PAGE_STATE_COLOR[value]}>
          {MISSING_PAGE_STATE_LABEL[value]}
          {value === 'filled' ? `（${record.filledBatchNo}）` : ''}
        </Tag>
      ),
    },
  ];

  const pendingColumns: ColumnsType<(typeof pendingLosses)[number]> = [
    {
      title: '拓本',
      key: 'rubbing',
      width: 190,
      render: (_v, record) => {
        const rubbing = rubbingById.get(record.rubbingId);
        return rubbing ? `${steleTitleOf(rubbing.steleId)} · 第 ${rubbing.versionNo} 版` : '已删除';
      },
    },
    {
      title: '字位',
      key: 'coord',
      width: 110,
      render: (_v, record) => <Tag color="#2f3a34">{encodeCoord(record.lineNo, record.charNo)}</Tag>,
    },
    { title: '页码', dataIndex: 'pageNo', width: 80, render: (v: number) => `第 ${v} 页` },
    { title: '待复核原因', dataIndex: 'reviewReason' },
    {
      title: '操作',
      key: 'action',
      width: 190,
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => goRubbing(record.rubbingId)}>
            去字位台
          </Button>
          <Popconfirm
            title="确认该字位已按新影像件复核"
            okText="确认有效"
            cancelText="取消"
            onConfirm={() =>
              void dispatch(resolveLossReviews([record.id]))
                .unwrap()
                .then(() => message.success('已确认为有效字位'))
            }
          >
            <Button size="small" type="link" icon={<SafetyCertificateOutlined />}>
              复核通过
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const unmatchedColumns: ColumnsType<ScanImage> = [
    { title: '收藏号', dataIndex: 'collectionNo', width: 140 },
    { title: '影像号', dataIndex: 'imageNo', width: 160 },
    { title: '页序', dataIndex: 'pageNo', width: 80, render: (v: number) => `第 ${v} 页` },
    { title: '总页数', dataIndex: 'pageCount', width: 90 },
    { title: '来源批次', dataIndex: 'batchNo', width: 170 },
    { title: '文件名', dataIndex: 'fileName', render: (v: string) => v || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: () => <Tag color={SCAN_IMAGE_STATUS_COLOR.unmatched}>{SCAN_IMAGE_STATUS_LABEL.unmatched}</Tag>,
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>扫描批次接入台</h2>
          <p>
            影像组按批次交来扫描件、缺页与重扫记录，编目台按收藏号认拓本并挂接影像；页序凑齐才算数字化完成。
          </p>
        </div>
        <Space wrap>
          <Button icon={<CloudUploadOutlined />} onClick={() => fileRef.current?.click()}>
            导入批次 JSON
          </Button>
          <Button icon={<FileSearchOutlined />} onClick={() => setManualOpen(true)}>
            手工登记一页
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
        <StatBadge label="接入批次" value={stat.batches} suffix="批" tone="primary" />
        <StatBadge label="重试跳过" value={stat.retried} suffix="次" tone="info" />
        <StatBadge label="数字化完成" value={stat.doneCount} suffix="份" tone="success" />
        <StatBadge label="扫描中" value={stat.scanningCount} suffix="份" tone="warning" />
        <StatBadge label="待扫" value={stat.waitingCount} suffix="份" />
        <StatBadge label="待补扫缺页" value={stat.openMissing} suffix="处" tone="danger" />
        <StatBadge label="待复核字位" value={stat.pendingLosses} suffix="条" tone="warning" />
        <StatBadge label="未认上影像" value={stat.unmatched} suffix="件" tone="danger" />
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="接入规则"
        description="① 批次按收藏号认拓本，认不上的影像件单列；② active 影像页序 1..总页数凑齐才算数字化完成；③ 重扫换件后原字位标注整体挂「待复核」，只挂不删；④ 缺页位置的损泐不计入版本差异字数；⑤ 同号批次重试整批跳过，编目台不跟着改。"
      />

      <Space wrap style={{ marginBottom: 14 }}>
        <Button
          size="small"
          icon={<RedoOutlined />}
          onClick={() => void ingest(DEMO_RETRY_BATCH)}
        >
          模拟影像组重试首批（应整批跳过）
        </Button>
        <Button size="small" onClick={() => void ingest(DEMO_REFILL_BATCH)}>
          模拟补扫 TB-0102 第 2 页
        </Button>
      </Space>

      <Tabs
        items={[
          {
            key: 'rubbings',
            label: `拓本数字化（${rubbings.length}）`,
            children: (
              <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
                {rubbings.length === 0 ? (
                  <EmptyPanel title="还没有拓本" description="先在拓本登记页录入拓本与收藏号，才能认领扫描批次。" size="small" />
                ) : (
                  <Table rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={digitizedColumns} dataSource={rubbings} />
                )}
              </Card>
            ),
          },
          {
            key: 'batches',
            label: `批次记录（${batches.length}）`,
            children: (
              <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
                {batches.length === 0 ? (
                  <EmptyPanel title="还没有接入任何批次" description="导入影像组批次 JSON，或手工登记一页扫描件。" size="small" />
                ) : (
                  <Table rowKey="id" size="small" pagination={false} columns={batchColumns} dataSource={batches} />
                )}
              </Card>
            ),
          },
          {
            key: 'missing',
            label: `缺页台账（${missingPages.length}）`,
            children: (
              <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
                {missingPages.length === 0 ? (
                  <EmptyPanel title="没有缺页记录" description="所有已扫拓本页序齐全。" size="small" />
                ) : (
                  <Table rowKey="id" size="small" pagination={false} columns={missingColumns} dataSource={missingPages} />
                )}
              </Card>
            ),
          },
          {
            key: 'pending',
            label: `待复核字位（${pendingLosses.length}）`,
            children: (
              <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
                {pendingLosses.length === 0 ? (
                  <EmptyPanel
                    title="没有待复核字位"
                    description="重扫换件后，编目员原先按旧件标的损泐字位会挂到这里，逐条对照新件复核。"
                    size="small"
                  />
                ) : (
                  <>
                    <Space style={{ padding: 12 }}>
                      <Popconfirm
                        title="全部按新件复核通过"
                        description="仅确认这些字位与新影像件一致；不一致请去字位台修改。"
                        okText="全部通过"
                        cancelText="取消"
                        onConfirm={() =>
                          void dispatch(resolveLossReviews(pendingLosses.map((loss) => loss.id)))
                            .unwrap()
                            .then(() => message.success('全部待复核字位已确认'))
                        }
                      >
                        <Button type="primary" size="small" icon={<SafetyCertificateOutlined />}>
                          全部复核通过（{pendingLosses.length}）
                        </Button>
                      </Popconfirm>
                    </Space>
                    <Table rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={pendingColumns} dataSource={pendingLosses} />
                  </>
                )}
              </Card>
            ),
          },
          {
            key: 'unmatched',
            label: `未认上 / 补不上（${unmatched.length + noCollectionRubbings.length}）`,
            children: (
              <Row gutter={16}>
                <Col xs={24} xl={14}>
                  <Card className="gb-table-card" title="未认上的影像件（批次收藏号在编目台不存在）" styles={{ body: { padding: 0 } }}>
                    {unmatched.length === 0 ? (
                      <EmptyPanel title="没有未认上影像件" size="small" />
                    ) : (
                      <Table rowKey="id" size="small" pagination={false} columns={unmatchedColumns} dataSource={unmatched} />
                    )}
                  </Card>
                </Col>
                <Col xs={24} xl={10}>
                  <Card title="补不上占位的拓本（旧数据无收藏号）" size="small">
                    {noCollectionRubbings.length === 0 ? (
                      <Typography.Text type="secondary">全部旧拓本均已按收藏号补到待扫占位。</Typography.Text>
                    ) : (
                      <Space direction="vertical" size={6}>
                        {noCollectionRubbings.map((rubbing) => (
                          <Tag key={rubbing.id} color="red">
                            {steleTitleOf(rubbing.steleId)} · 第 {rubbing.versionNo} 版 —— 收藏号缺失，升级时无法补待扫占位
                          </Tag>
                        ))}
                      </Space>
                    )}
                  </Card>
                </Col>
              </Row>
            ),
          },
        ]}
      />

      <Modal
        open={manualOpen}
        title="手工登记一页扫描件"
        onCancel={() => setManualOpen(false)}
        onOk={() => void submitManual()}
        okText="接入"
        cancelText="取消"
        destroyOnClose
      >
        <Form
          form={manualForm}
          layout="vertical"
          preserve={false}
          initialValues={{
            batchNo: `SB-MANUAL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
            operator: '',
            scannedAt: new Date().toISOString().slice(0, 10),
            pageNo: 1,
            pageCount: 1,
            rescan: false,
            fileName: '',
          }}
        >
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="batchNo" label="批次号" rules={[{ required: true, message: '请填写批次号' }]}>
                <Input placeholder="如：SB-20261007-01" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="scannedAt" label="扫描日期" rules={[{ required: true }]}>
                <Input type="date" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="operator" label="影像组操作人">
            <Input placeholder="如：辛夷" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="collectionNo" label="收藏号" rules={[{ required: true, message: '按收藏号认拓本' }]}>
                <Select
                  showSearch
                  placeholder="选择拓本收藏号"
                  options={rubbings
                    .filter((rubbing) => rubbing.collectionNo.trim().length > 0)
                    .map((rubbing) => ({
                      value: rubbing.collectionNo,
                      label: `${rubbing.collectionNo}（${steleTitleOf(rubbing.steleId)} 第 ${rubbing.versionNo} 版）`,
                    }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="imageNo" label="影像号" rules={[{ required: true, message: '请填写影像号' }]}>
                <Input placeholder="如：IMG-0101-02" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="pageNo" label="页序" rules={[{ required: true }]}>
                <InputNumber min={1} max={999} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="pageCount" label="总页数" rules={[{ required: true }]}>
                <InputNumber min={1} max={999} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="rescan" label="重扫件" valuePropName="checked">
                <Switch checkedChildren="重扫" unCheckedChildren="首扫" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="fileName" label="文件名 / 备注">
            <Input placeholder="如：TB-0101_p2.tif" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function TooltipState({ value, retried }: { value: 'applied' | 'skipped'; retried: number }) {
  return (
    <Tooltip title={value === 'skipped' ? `影像组写库失败后重试，编目台未跟随修改（累计重试 ${retried} 次）` : '首次接入成功'}>
      <Tag color={SCAN_BATCH_STATE_COLOR[value]}>
        {SCAN_BATCH_STATE_LABEL[value]}
        {retried > 0 ? ` ×${retried}` : ''}
      </Tag>
    </Tooltip>
  );
}
