# 碑帖拓片编目与版本比对台（gbrubbing）

面向碑刻拓片收藏机构编目员的本地化工具：把同一碑刻的不同拓本编目登记，标注损泐字位并做版本差异比对与断代辅助判断；同时接入影像组的**扫描批次**，按收藏号认拓本、挂接影像件、跟踪缺页与重扫。

核心动作：**建立碑刻与所在地档案 → 登记拓本的拓法与纸墨尺寸钤印 → 接入扫描批次（按收藏号认领影像件、缺页台账、重扫挂待复核）→ 逐行标注损泐字位 → 执行同碑多版本比对与断代 → 导出编目卡**。

纯前端单页应用（React 18 + TypeScript + Ant Design + Vite + Redux Toolkit + React Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据）。

---

## 〇、扫描批次接入规则（影像组 ↔ 编目台）

影像组按批次管理扫描件、缺页与重扫记录；编目台在 `/scans` 页导入批次 JSON（或手工登记），规则如下：

1. **按收藏号认领**：批次明细只带收藏号 + 影像号 + 页序，认上拓本后把影像件挂到该拓本下；认不上的影像件（收藏号在台账中不存在）单列在「未认上 / 补不上」页签，不污染任何拓本。
2. **页序凑齐才算数字化完成**：某拓本 active 影像件页序覆盖 `1..总页数` → 数字化完成；有件但缺页 → 扫描中；没有任何有效件 → 待扫。缺页进缺页台账（待补扫 / 已补齐）。
3. **重扫挂待复核**：批次中 `rescan: true` 的页替换旧影像件（旧件留痕为「已换下」），编目员原先按旧件标在该页的损泐字位**全部挂出「待复核」**（只挂不删），在字位台与扫描页逐条确认后回到「有效」。
4. **缺页不计入差异字数**：版本比对时，字位所在页在任一方属于待补扫缺扫，或双方标注页序错位，该行标记为「缺页未计入」并灰显挂出，**不进 diffCount**，避免缺页把比对结果冲虚。
5. **批次写入幂等（重试不跟随）**：同号批次重复接入时整批跳过，批次状态置「重试跳过」、`retried + 1`，影像件、缺页台账、字位复核状态一律不动 —— 即影像组写库失败后重试这一批，编目台那份不跟着改。
6. **旧数据升级（v2→v3）**：旧拓本没有影像号，升级时按收藏号各补一条「待扫」占位，首批真实扫描件接入后占位自动换下；无收藏号的拓本**补不上**，在扫描页单列提示先补收藏号。

批次 JSON 格式示例：

```json
{
  "batchNo": "SB-20261007-01",
  "operator": "影像组·辛夷",
  "scannedAt": "2026-10-07",
  "items": [
    { "collectionNo": "TB-0101", "imageNo": "IMG-0101-02", "pageNo": 2, "pageCount": 3, "rescan": false, "fileName": "TB-0101_p2.tif" }
  ]
}
```

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22820**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbrubbing}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/export` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18（函数组件 + Hooks） | 页面按路由懒加载 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `tsc --noEmit` 类型检查 |
| UI 组件库 | Ant Design 5（含 `@ant-design/icons`） | 表格、表单、对话框、字位网格、徽标 |
| 构建工具 | Vite 5 | 开发服务器端口 22820 |
| 状态管理 | Redux Toolkit 2 + React Redux 9 | `steleSlice` / `rubbingSlice` / `lossSlice` / `scanSlice` + `store.ts` 类型化 hooks |
| 路由 | React Router 6（`createBrowserRouter`，history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2→v3 升级迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22820
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22820）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/steles` | 碑刻与所在地台账 | 新建碑刻、按年代与形制筛选（同步 URL query），卡片回显已收拓本数、损泐字位与最近断代结论 | Stele、Rubbing、Loss、Compare |
| `/scans` | 扫描批次接入台 | 导入批次 JSON / 手工登记，按收藏号认领影像件；缺页台账、重扫待复核、未认上单列、批次重试幂等 | ScanBatch、ScanImage、MissingPage、Rubbing、Loss |
| `/rubbings` | 拓本登记 | 录入拓法、纸墨、尺寸与收藏号；同碑自动生成版本序号，钤印增删改与批量调整印别，批量改状态，展示数字化进度 | Rubbing、Seal、Stele、ScanImage、MissingPage |
| `/losses` | 损泐字位标注台 | 行号 × 字位网格逐格标注（含所在页），批量改严重程度；待复核筛选与复核确认；选定基准拓本即时高亮差异字位 | Loss、Rubbing、ScanImage、MissingPage |
| `/compare` | 同碑多版本比对与断代 | 选定 A/B 两拓本，按字位坐标比对损泐集合并排展示差异（缺页位置单列且不计差异字数），推断早本 / 晚本 / 同版 / 待考并落库 | Compare、Loss、Rubbing、MissingPage |
| `/export` | 编目卡生成与导出 | 按碑刻生成编目卡文本、合订导出、钤印明细、JSON 导入导出、损泐台账 CSV、清空重播种 | 全部模型 |

`/` 与未匹配路径重定向到 `/steles`。筛选条件写入 URL query（`?kw=&method=&state=` 等），可直接分享带条件的链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Stele 碑刻 | `src/types/stele.ts` | `id` `title` `era` `location` `form`（碑/碣/摩崖/墓志） `sizeCm` `calligrapher` | 新建后进入拓本登记，卡片回显拓本数与差异条数 |
| Rubbing 拓本 | `src/types/rubbing.ts` | `id` `steleId` `versionNo` `method`（擦拓/扑拓/蝉翼拓） `paperType` `inkTone`（浓墨/淡墨） `sizeCm` `collectionNo` `dateGuess` `state`（待编目/已编目/待比对） | 同碑多份并存，版本序号自动生成；扫描批次按 `collectionNo` 认领 |
| Loss 损泐字位 | `src/types/loss.ts` | `id` `rubbingId` `lineNo` `charNo` `pageNo` `type`（缺字/裂痕/漫漶/石花） `severity`（轻/中/重） `reviewState`（有效/待复核） `reviewReason` `markedImageNo` `note` | 按行列网格标注；重扫换件后旧件标注挂待复核；缺页上的字位不计入差异 |
| Seal 钤印 | `src/types/seal.ts` | `id` `rubbingId` `sealText` `position` `transcription` `sealType`（收藏印/鉴赏印/作者印） | 按位置排序展示，支持批量改印别 |
| Compare 版本比对 | `src/types/compare.ts` | `id` `steleId` `rubbingIdA` `rubbingIdB` `diffCount` `conclusion`（早本/晚本/同版/待考） `operator` `date` | 选定两拓本即生成差异清单并回写断代结论 |
| ScanBatch 扫描批次 | `src/types/scanBatch.ts` | `id` `batchNo` `operator` `scannedAt` `state`（已接入/重试跳过） `retried` `summary` | 同号批次重试整批跳过，编目台不跟着改 |
| ScanImage 影像件 | `src/types/scanImage.ts` | `id` `rubbingId` `collectionNo` `imageNo` `pageNo` `pageCount` `rescan` `batchNo` `status`（有效/待扫/已换下/未认上） `replacedByImageNo` | 挂在拓本下的扫描页；旧件留痕；未认上与待扫占位单列 |
| MissingPage 缺页 | `src/types/missingPage.ts` | `id` `rubbingId` `pageNo` `pageCount` `batchNo` `state`（待补扫/已补齐） `filledBatchNo` | 页序缺的那几处；补齐后页序凑齐才算数字化完成 |

数据结构版本号 `DB_SCHEMA_VERSION` 定义在 `src/utils/db.ts`，当前为 **`v3`**：

- **v1→v2**：`losses` 表增加 `charNo` 与 `[rubbingId+lineNo+charNo]` 复合索引，并在 Dexie `.upgrade()` 中按行号顺序为历史字位记录重建 `charNo`。
- **v2→v3**：新增 `scanBatches` / `scanImages` / `missingPages` 三张表；`losses` 增加 `pageNo`、`reviewState` 索引；升级时为历史字位补 `pageNo=1` 与有效复核状态，并为每个有收藏号的旧拓本按收藏号补一条「待扫」占位（`img_ph_{rubbingId}`），无收藏号的不补占位、在扫描页单列。

---

## 六、目录结构

```
sologsb101-1020/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # stele.ts rubbing.ts loss.ts seal.ts compare.ts
│   │   │                         # scanBatch.ts scanImage.ts missingPage.ts
│   │   ├── stores/               # steleSlice.ts rubbingSlice.ts lossSlice.ts scanSlice.ts store.ts
│   │   ├── components/common/    # LossTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx DigitizeTag.tsx
│   │   ├── hooks/                # useLossDiff.ts useIdbTable.ts
│   │   ├── pages/                # SteleList.tsx ScanView.tsx RubbingList.tsx LossBoard.tsx
│   │   │                         # CompareView.tsx ExportView.tsx
│   │   ├── router/               # index.tsx
│   │   ├── utils/                # collate.ts scan.ts db.ts export.ts
│   │   ├── styles/               # main.css
│   │   ├── App.tsx main.tsx
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面通过 `useSelector` / `dispatch` 读写 Redux，跨页状态不留在组件内部 `useState`；IndexedDB 读写由 slice 的 `createAsyncThunk` 统一封装，页面级只读订阅（如钤印明细）走 `useIdbTable()` 的 `liveQuery`；字位坐标编解码、缺页差异排除与差异算法集中在 `utils/collate.ts`，数字化进度派生（待扫/扫描中/完成、缺页页序集合）在 `utils/scan.ts`，扫描批次幂等接入事务在 `utils/db.ts` 的 `applyScanBatch()`，比对派生逻辑走 `useLossDiff()`。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gbrubbing`）**：8 张业务表 `steles` / `rubbings` / `losses` / `seals` / `compares` / `scanBatches` / `scanImages` / `missingPages`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 首次打开时自动播种**跨模型互相引用**的演示数据（Stele → Rubbing → Loss / Seal / ScanImage / MissingPage，另有 Stele → Compare，固定 id 如 `stele_01`、`rub_0101`、`loss_010101`、`batch_SB-20260901-01`、`img_0101_01`、`mp_rub_0102_2`），播种幂等，字位网格、比对台与扫描台打开即有内容（含缺页、重扫待复核、未认上、重试批次等场景）。
- **localStorage**：仅存元数据 —— `gbrubbing:db-version`（本地结构版本）、`gbrubbing:last-backup-at`（最近导出时间）、`gbrubbing:ui-prefs`（当前碑刻 / 拓本）。
- **备份**：`/export` 页可导出 JSON（8 张表全量数据 + 结构版本号），导入时校验 `app` 字段与各核心集合数组完整性，v2 旧备份缺扫描三表也可导入（空表起步，重新接批即可），覆盖导入前二次确认；另有编目卡 TXT 与损泐台账 CSV。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `tsc --noEmit`，必须零错误）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22820`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gbrubbing` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
