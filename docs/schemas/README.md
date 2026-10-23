# Translation Package Schemas — app-folio (consumer + producer)

本目录是 **app-folio 视角**的契约文档：webapp 从 `translation_package/` 目录里**消费**哪些字段、**写出**哪些字段、跨仓 `_auto` 政策怎么落地。

姊妹仓 indesign-toolkit 是这个目录的**生产者**（segments.json / tid_map.json / preview.pdf / min.idml 由 pipeline 写出）+ **消费者**（translations.json 由 pipeline 读回 apply）。它那侧的镜像契约在：

```
indesign-toolkit/docs/schemas/
├── README.md
├── package.md
├── segments-produced.md     ← 权威 schema：pipeline 写哪些字段
├── translations-consumed.md ← pipeline 读哪些字段、_auto 怎么过滤
└── shared-types.md
```

## 为什么这个目录存在

**保险目标**：阻止"生产者删 / 改字段，消费者悄悄断"的 silent drift。

每个文件按 **READ / WRITE / IGNORE** 三列分：

- **READ** — 本仓代码必须能拿到这个字段才工作；上游删 → 我们炸
- **WRITE** — 本仓写入这个字段；下游能不能用看 `consumed by` 列
- **IGNORE** — 本仓收到这个字段但不用；上游可以删，但请打招呼

## 本目录索引

| 文件 | 内容 |
|---|---|
| [`package.md`](package.md) | 包目录结构 + 哪个文件谁写 |
| [`segments-consumed.md`](segments-consumed.md) | webapp 从 `segments.json` READ 的字段 + 忽略的字段 |
| [`translations-produced.md`](translations-produced.md) | webapp 写入 `translations.json` 的字段 + `_auto` 政策 |
| [`shared-types.md`](shared-types.md) | `emphasis_runs[]` / `annotations[]` / `diff` 多边形 schema |

## 跨仓政策

跨仓政策「不自动传播未确认的源格式到 target」—— app-folio 这边的约定：

- AI / heuristic 生成的 annotation 必须打 `_auto: true`
- emphasis runs 类似：父对象层 `target_X_auto: true` 视为 "未确认"
- pipeline import 端 `if (X_auto === true) → skip` —— 等同 translator 没标
- 写入新的"源有 X 但 target 没"的自动通道之前，**先**确认 `_auto` 链全程闭环

## 更新策略

- 本仓代码改了字段读写 → **同步改本目录对应文件**
- 字段是跨仓共享（出现在 `segments-consumed.md` / `translations-produced.md` / `shared-types.md`）→ **同步开 issue / 通知姊妹仓**改它那侧的 mirror
- 发现 drift（一侧写、一侧不读 / 不识别）→ 记录下来、别沉默
