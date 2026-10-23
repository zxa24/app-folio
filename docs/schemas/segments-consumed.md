# segments.json — webapp 消费契约

**权威 schema 在 indesign-toolkit/docs/schemas/segments-produced.md**（生产者）。本文只列 **webapp READ + IGNORE** 两类。

## Segment-level READ 字段

每条 segment 都是一个对象。webapp 必须能拿到的字段：

### 身份 / 文本

| 字段 | 类型 | 用途 | 代码锚 |
|---|---|---|---|
| `tid` | string | 唯一 ID，跨 segments.json 与 translations.json 对接 | app.js 全文 key |
| `source_text` | string | 卡片左侧渲染、emphasis run substring、merge 操作合并源 | app.js:1217+ |
| `segment_kind` | string | 已知 `"text"`；其它值 webapp 跳过 | app.js:1158 (validation) |
| `translatable` | boolean | `false` → webapp 显示但禁用编辑 | app.js:1159 |
| `target_policy` | string | 控制是否允许编辑、是否预填 source | app.js:1160 |
| `paragraph_style` | string | 过滤 / 分组 / "by style" 视图 | app.js:1826 |

### 几何 / 位置

| 字段 | 类型 | 用途 |
|---|---|---|
| `page_indexes[]` | number[] | hotspot 在哪页可见、卡片在哪页 visible filter |
| `line_rects[]` | array of rects | hotspot 矩形原始坐标 |
| `line_rects_norm[]` | array of normalized rects | 若 `geometry_version === "line_rects_norm_v1"` 直接用；否则 webapp 从 `line_rects` 重算 |
| `point_size` / `leading_pt` / `leading_ratio` / `leading_auto` | numbers / boolean | soft-break 启发式 |

### 格式 snapshot

| 字段 | 类型 | 用途 |
|---|---|---|
| `format_snapshot.emphasis_runs[]` | `{start, end, diff}[]` | source emphasis overlay 渲染 + auto-translate marker 编码（详 [shared-types.md](shared-types.md)） |

注意：`format_snapshot.baseline` / `paragraph_snapshot` 整块**不读**（见下方 IGNORE）。

### 结构关系

| 字段 | 类型 | 用途 |
|---|---|---|
| `story_id` | number | 表格 cell 段落消歧 |
| `paragraph_index` / `paragraph_uid` | number / string | 表格 cell 段落消歧 |
| `table_id` / `table_index` / `table_uid` | number / string | 表格 cell 父表识别 |
| `cell_row` / `cell_col` / `row_span` / `col_span` | number | cell 坐标 |
| `cell_para_index` / `cell_para_count` | number | cell 内段落顺序 |
| `cell_uid` | string | cell 稳定 ID |

### 软换行 / 合并

| 字段 | 类型 | 用途 |
|---|---|---|
| `soft_break_group` | string | 同组段落自动合并 |
| `soft_break_index` | number | 组内顺序 |
| `soft_break_separators[]` | string[] | 合并时段间分隔符 |

### 链接

| 字段 | 类型 | 用途 |
|---|---|---|
| `source_links[]` | array of `{start, end, url, ...}` | source 侧下划线 + 跳转 |

### 可见性

| 字段 | 类型 | 用途 |
|---|---|---|
| `is_hidden_object` | boolean | true → 卡片折叠 |
| `hidden_reason` | string | folded 卡片显示原因 |

## IGNORE 字段（pipeline 写、webapp 不用）

下列字段 webapp **目前不消费**。上游可以继续写（其它消费者可能用），但删了不会立即炸 webapp：

- `format_snapshot.baseline.*` — baseline font/color 元信息（webapp 渲染走 `paragraph_style` + emphasis_runs，不需要 baseline）
- `paragraph_snapshot.*` — 段落级 paragraph style 元信息
- `source_hash` — pipeline 端用来检测 source 漂移，webapp 不消费
- `document.page_geometries[]` / `master_page_map[]` / `page_rect_coord_modes` / `emphasis_stats` / `manual_handoff` —— document-level pipeline metadata

如果未来 webapp 想用 `format_snapshot.baseline.*`（例如做"恢复 baseline 字号"按钮），先在本文件 + 姊妹仓的 `segments-produced.md` 同步更新。

## 类型不安全的字段

`line_rects[]` 历史上有过两种坐标系（pre-`line_rects_norm_v1` 是文档坐标，post 是 normalized 0-1）。**消费判断**：先看 `document.geometry_version`；如果是 `"line_rects_norm_v1"` 用 `line_rects_norm`，否则从 `line_rects` + 页面尺寸自己 normalize。

## 跨仓政策接口

- `format_snapshot.emphasis_runs[]` 是 source 侧 emphasis —— webapp 主动通过 marker-pair 编码喂 Google translate，**不**自动复制成 target 侧（per 跨仓 `_auto` 政策；详 [translations-produced.md](translations-produced.md) `target_emphasis_runs`）
