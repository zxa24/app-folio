# translation_package/ 目录结构

translator 拿到的是一个目录（或一个 `.zip`）。webapp 通过两条路径加载：

1. **HTTP** (`loadFolderFromServer`)：本地 `serve.js` 路由读盘
2. **ZIP 上传** (`lib/zip_core.js`)：fflate 解压到内存

无论哪条，最后落到同一个 in-memory `state` 结构。

## 目录形状

```
<package_name>/
├── segments.json          ← REQUIRED. pipeline 产出。webapp 主消费源
├── translations.json      ← REQUIRED. pipeline 初始产出（空 target），webapp 写回
├── tid_map.json           ← OPTIONAL. soft-break 拆分时由 pipeline 产出
├── preview.pdf            ← REQUIRED. pipeline 产出。PDF.js 渲染
└── min.idml               ← OPTIONAL. pipeline 产出。当前 webapp 不用（reserved for future structure-aware import）
```

## 谁写、谁读

| 文件 | 写 | 读 | 备注 |
|---|---|---|---|
| `segments.json` | indesign-toolkit pipeline | app-folio webapp | webapp **绝不**改写这个文件 |
| `translations.json` | indesign-toolkit pipeline（初始） + app-folio webapp（save） | app-folio webapp（load） + indesign-toolkit pipeline（import-back） | 双向：pipeline 起头空 target；webapp 保存满 target；pipeline 回灌 |
| `tid_map.json` | indesign-toolkit pipeline | app-folio webapp | soft-break group 元数据 |
| `preview.pdf` | indesign-toolkit pipeline | app-folio webapp | binary, PDF.js 渲染 |
| `min.idml` | indesign-toolkit pipeline | (reserved) | binary, 未消费 |

## 包元信息（segments.json document 字段）

webapp 只**间接**使用 document 字段（不直接渲染或写回）：

- `schema_version` — 当前已知 `"translation-mvp-1"`。webapp 不强制 gate（接受任何值，按内容形状降级）
- `document.tid_map_file` — 指向 `tid_map.json`，如有
- `document.idml_backup_file` — 指向 `min.idml`，如有
- `document.geometry_version` — 当前 `"line_rects_norm_v1"`。webapp 用来决定 `line_rects` 是否需要 normalize（如已是 norm 直接用）

其余 document 字段（`page_geometries[]`、`master_page_map[]`、`page_rect_coord_modes`、`emphasis_stats`、`manual_handoff` 等）webapp 全部 **IGNORE**。

## ZIP 包形态

通过 `lib/zip_core.js` 读 ZIP 时：

- 第一层目录名可有可无（webapp 探测 `segments.json` 所在层 + 同层取其它文件）
- `min.idml` 即使在包内也跳过解压（体积大）
- zip-bomb 前置过滤：central directory 元数据先验，超过限制立即拒绝（2026-05-27 安全加固）

## 路径假设 / 黄金路径

`document.tid_map_file` / `document.idml_backup_file` 的值是 **basename**（不含目录），与包同层。webapp 不接受绝对路径或 `..`。

## 不在包里的 / out-of-band

- automation token (`.scratch/automation_token`) — 仅在 `serve.js` 跑时存在，URL automation 用
- audit logs / dev journal — 完全 out-of-band，不进包
