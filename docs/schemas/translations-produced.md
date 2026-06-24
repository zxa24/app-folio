# translations.json — webapp 生产契约

**本仓权威**。pipeline 端的消费视图在 `indesign-toolkit/docs/schemas/translations-consumed.md`。

## 顶层结构

```json
{
  "schema_version": "translation-mvp-1",
  "document_name": "<同 segments.json>",
  "translations": [ { ... }, { ... } ]
}
```

`schema_version` / `document_name` 由 pipeline 初始写入，webapp **保留不动**。

## translations[] entry — WRITE 字段

每条对应 `segments.json` 的同 `tid` segment。webapp 可写字段：

### 必写

| 字段 | 类型 | 何时写 | pipeline 读？ |
|---|---|---|---|
| `tid` | string | 透传自 segments | ✅ 主匹配 key |
| `source_text` | string | 透传自 segments（便于离线 sanity check） | 读但 sanity-check 用 |
| `target_text` | string | translator 手输入 / auto-translate / Paste Fill | ✅ apply 时写入 InDesign |

### 状态机

| 字段 | 类型 | 值域 | pipeline 读？ |
|---|---|---|---|
| `status` | string | `"todo"` / `"translated"` / `"reviewed"` / `"skip"` / `"merge_tail"` | ❌ pipeline 忽略 |
| `notes` | string | translator 笔记 | ❌ pipeline 忽略 |

`status === "merge_tail"` 是 webapp-内部状态，表示该段被合并到 `merge_head_tid` 指向的段。pipeline 不读但 webapp 必须保留以维持下次 load 后的合并状态。

### Annotations

| 字段 | 类型 | 何时写 | pipeline 读？ |
|---|---|---|---|
| `annotations[]` | annotation object[] | 手动 format paint / comment / auto-projection | ✅ pipeline 按 `action` 应用到 InDesign |

**Annotation entry 详 schema** → [shared-types.md#annotations](shared-types.md#annotations)。

### Emphasis runs（target 侧）

| 字段 | 类型 | 何时写 | pipeline 读？ |
|---|---|---|---|
| `target_emphasis_runs[]` | `{start, end, diff}[]` | auto-translate marker-pair 解码（faithful MT-carry，唯一生成路径） | ✅ 视 `_auto` / `_faithful` flag 决定是否 apply |
| `target_emphasis_runs_auto` | boolean | `true` ⟺ 机器生成（codec MT-carry）；webapp 无其它 `_auto` 生成路径（启发式建议 2026-06-24 已删） | ✅ **关键 gate** —— pipeline 见 `auto && !faithful` 跳过 apply（BRIDGE-39） |
| `target_emphasis_runs_faithful` | boolean | `true` ⟺ codec 报告 provably-clean roundtrip（见 shared-types）；**仅** codec 路径打，载入外部 JSON 时被剥（HOLE-B） | ✅ gate exemption —— `auto && faithful` → 应用 |
| `target_emphasis_runs_user_set` | boolean | 仅从载入的 package round-trip 携带（confirmed 态）；webapp-内部，pipeline 忽略，但**会导出**以保留该态 | ❌ |

详 [shared-types.md#emphasis-runs](shared-types.md#emphasis-runs)。

### 软换行

| 字段 | 类型 | 何时写 | pipeline 读？ |
|---|---|---|---|
| `merge_head_tid` | string | 该段 status=`merge_tail` 时指向 head | ❌ pipeline 忽略（pipeline 自己按 source 顺序拼） |
| `merge_tail_backup_status` | string | 转 merge_tail 前保存原 status，unmerge 恢复用 | ❌ webapp 内部 |
| `merge_tail_backup_target` | string | 同上，备份 target_text | ❌ webapp 内部 |
| `merge_tail_backup_annotations[]` | annotation[] | 同上，备份 annotations | ❌ webapp 内部 |
| `soft_break_unmerged` | boolean | translator 主动 unmerge 过 soft_break_group → 下次 load 不再 auto-merge | ❌ webapp 内部 |

### 其它

| 字段 | 类型 | 何时写 | pipeline 读？ |
|---|---|---|---|
| `target_auto_prefill` | boolean | 标记 target 是否由 "prefill source" 而来（避免误判 reviewed） | ❌ webapp 内部 |

## `_auto` 政策 — webapp 怎么落

跨仓政策「不自动传播未确认的源格式到 target」—— webapp 实现要点：

### 父对象层 flag

字段 → 对应 `_auto` flag：

| 数据字段 | flag 字段 | 意义 |
|---|---|---|
| `target_emphasis_runs` | `target_emphasis_runs_auto` | true ⟺ 整个数组 AI 生成 |

pipeline gate：`if (target_emphasis_runs_auto === true) → treat as unset, skip apply`。

### 数组项内层 flag

`annotations[]` 数组里每条 entry 可带 `_auto: true`。pipeline 应该对每条单独决定（不是数组级）。

### 写入时的硬约束

1. **任何 AI / heuristic 生成的 annotation 写入 `row.annotations[]` 必须带 `_auto: true`**
2. **任何 AI 生成的 `target_emphasis_runs` 必须同步置 `target_emphasis_runs_auto = true`**
3. translator 手动操作（toolbar 改格式、键入 textarea）→ 清掉对应 `_auto` 标记
4. **绝不**静默把 source 的 emphasis_runs / source_links 复制到 target 侧的 user-confirmed 字段

### 当前 webapp 走 `_auto` 的入口

- `applyDevTranslateRows`（marker-pair emphasis preservation，faithful MT-carry） — 见 app.js

> 启发式 `suggestTargetEmphasisRuns`（Phase 8C「Suggested emphasis · Apply/Dismiss」）
> 已于 2026-06-24 删除。codec MT-carry 现为唯一 `_auto` 生成入口。

新增任何"自动给 target 加格式"通道，**先**在本文件加一条到这里。

## 当前 drift hazards

当前已知的契约 drift：

- `VALID_FORMAT_ACTIONS` 白名单只有 6 项（bold/italic/underline/superscript/color/link），但 `diffToAnnotationEntries` 实际产出 8 种（多 strikethrough/subscript/size）—— **load 时**通过 `normalizeAnnotations` 静默丢 3 种
- 自动 projected annotations **缺 `text` 字段** → `isValidAnnotation` 整条拒收 → save→reload 全部丢
- `status` / `notes` / `merge_*` / `soft_break_unmerged` 是 webapp-only 状态 —— pipeline 不消费但 webapp 必须保留以维持自己的合并 / unmerge 持久化
