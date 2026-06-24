# 共享类型 — emphasis_runs / annotations / diff

跨 webapp ⇄ pipeline 通用的几个嵌套数据类型。本文件 webapp 视角；姊妹仓 `indesign-toolkit/docs/schemas/shared-types.md` 是生产侧视角。**两侧必须保持字段 + 取值集合一致**。

## emphasis_runs

出现位置：
- `segments[].format_snapshot.emphasis_runs[]`（source 侧，pipeline 写）
- `translations[].target_emphasis_runs[]`（target 侧，webapp 写）

### 数组项 schema

```js
{
  start: <number>,    // char offset，inclusive
  end:   <number>,    // char offset，exclusive
  diff:  <DiffProps>  // 见下
}
```

约束：
- `0 <= start < end <= text.length`
- runs 可重叠（多层 emphasis 合法）
- pipeline 端 source 侧可额外带 `charStyleHint: "Hyperlink"` 等字段（webapp 不消费）

### `diff` 字段集合

**diff 是 property map，描述这段 range 相对 baseline 的差异**。下列字段是当前已知集合：

| diff key | 类型 / 值域 | webapp 渲染 | pipeline apply | 备注 |
|---|---|---|---|---|
| `fontStyle` | string, e.g. `"Bold"`, `"Italic"`, `"Bold Italic"`, `"XBold"`, `"NOTHING"` | 含 `"bold"` substring → bold；含 `"italic"` → italic | 直接 set range.fontStyle | 大小写敏感解析 weight rank（pipeline 端有 `WEIGHT_RANK` 表） |
| `underline` | boolean | 渲染 underline | 直接 set | |
| `strikeThrough` | boolean | 渲染 strikethrough | 直接 set | **webapp annotation 白名单当前漏**（详 drift-hazards） |
| `fillColor` | `{values: [r,g,b], ...}` | 转 hex 渲染 color | 应用 swatch / 创建 color | values 是 0-255 范围 |
| `fontSize` | number (pt) | 渲染 font-size | 直接 set point size | **webapp annotation 白名单当前漏** |
| `baseline_shift` | number (pt) | `>0` superscript / `<0` subscript / `=0` 无 | 直接 set | |
| `position` | `"NORMAL"` / `"SUPERSCRIPT"` / `"SUBSCRIPT"` | super/sub 渲染（**注**：与 baseline_shift 是 InDesign 两条独立编码路径，同一逻辑 mapping） | 直接 set position enum | client 包用此路径，2026-05-27 fix |
| `fontFamily` | string | **不渲染**（webapp 字体固定 NotoSansSC，跨脚本字体由上游 GREP 解决） | 直接 set appliedFont | webapp 主动 drop with debug log |

### `WEBAPP_EMPHASIS_DIMS` 白名单

webapp 端**只渲染**这 7 维（per `lib/emphasis_overlay.js:101`）：

```
fontStyle, underline, strikeThrough, fillColor, fontSize, baseline_shift, position
```

`fontFamily` 故意排除。其它未知 dim → webapp 不渲染但保留传递（透明 passthrough）。

`dev_translate.js:760` 的 `EMP_VISIBLE_DIMS` 是同一个白名单的**镜像副本**，用于 marker-pair 编码决定哪个 run 值得插 marker（不可见的 run 不发 marker，省 token）。两侧 7 元一致。**改一个改两个**。

### `_auto` 政策

- `target_emphasis_runs[]` 数组级 `_auto`：父对象层 `target_emphasis_runs_auto: true`
- 数组项内层 `_auto`：每条 entry 不带 `_auto`（统一用父对象 flag）

## annotations

出现位置：
- `translations[].annotations[]`（webapp 写，pipeline 读 apply）

### 通用 schema

```js
{
  type: "format" | "comment",
  text: <string>,           // REQUIRED for format（isValidAnnotation gate）
  offset: <number>,         // char offset in target_text
  length: <number>,         // > 0 for format
  context_before: <string>, // optional, 5-10 chars before
  context_after:  <string>, // optional, 5-10 chars after
  _auto: <boolean>          // optional, true ⟺ AI / heuristic 生成
}
```

### type=`"format"` 的额外字段

```js
{
  ...common,
  action: <ActionEnum>,     // 见下
  color: <string>,          // "#rrggbb"，仅 action="color"
  size:  <number>,          // pt，仅 action="size"（**当前 normalize 漏**，详 drift）
  url:   <string>           // 仅 action="link"
}
```

### ActionEnum 完整集合

当前 `diffToAnnotationEntries` 可能产出的 action：

| action | 值字段 | 来源 diff dim | webapp `VALID_FORMAT_ACTIONS` 接受？ |
|---|---|---|---|
| `bold` | — | `fontStyle` 含 bold | ✅ |
| `italic` | — | `fontStyle` 含 italic | ✅ |
| `underline` | — | `underline: true` | ✅ |
| `strikethrough` | — | `strikeThrough: true` | ❌ **drift** |
| `superscript` | — | `baseline_shift > 0` 或 `position: "SUPERSCRIPT"` | ✅ |
| `subscript` | — | `baseline_shift < 0` 或 `position: "SUBSCRIPT"` | ❌ **drift** |
| `color` | `color: "#rrggbb"` | `fillColor` | ✅ |
| `size` | `size: <pt>` | `fontSize` | ❌ **drift** + `normalizeAnnotationItem` 也漏 |
| `link` | `url: "..."` | (translator UI manual) | ✅ |

### type=`"comment"`

```js
{
  type: "comment",
  text: <string>,           // comment 正文
  offset: <number>,         // 可为 -1（无 anchor）
  length: <number>,         // 可为 -1
  context_before / context_after
}
```

pipeline 端：comment 通常不 apply 到 InDesign（或走 InDesign Notes API），具体见姊妹仓契约。

## tid_map.json mappings[]

```js
{
  mappings: [
    {
      tid: <string>,
      soft_break_group: <string>,
      soft_break_index: <number>,
      // ... pipeline 可能扩展字段
    }
  ]
}
```

webapp 用 `soft_break_group` 把多段 auto-merge 成一组 card。
