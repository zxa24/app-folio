# app-folio — Claude 工作笔记

本仓库是一个离线翻译器 webapp：消费 indesign-toolkit v2 pipeline 导出的 translation packages（`preview.pdf` + `segments.json` + `translations.json` + `tid_map.json` + `min.idml`），让 translator 在浏览器里编辑 target_text、标注格式（bold/italic/color/superscript/link/comment）、按 hotspot 校对版式。本地通过 `start.bat` → `serve.js` 启动（默认 8080），也可走 GitHub Pages（https://zxa24.github.io/app-folio/，纯文件 I/O 路径）。

姐妹仓库 indesign-toolkit（InDesign 端 pipeline + Operator Tools）的工作规则见那边的 `CLAUDE.md`；跨两仓共享的 translator 政策在本文档「跨仓政策」一节。

---

## 测试 / 自动化契约

### PDF 渲染是 fire-and-forget；hotspot DOM 不是同步可见的

`app.js` 的 `renderAll()` 在 `renderPdf()` 调用 `void renderPdfAsync()`（约 line 1757 / 3471），是 fire-and-forget。`renderHotspots()` 在 `state.pdfViewBox === null` 时早退（line 4060）；`pdfViewBox` 只在 PDF.js `page.render().promise` resolve 之后（line 3567）才被设值，之后才 `renderHotspots()` 填充 `#hotspotLayer`。

**何时踩坑**：Playwright（或任何自动化）测试 `loadFolderFromServer` 之后立刻断言 `[data-hotspot-owner="..."]` 存在——hotspot 层是空的，断言概率性失败。Headless Chromium 下首屏渲染足够慢，加 if-guard 跳过就会变成 silently no-op 的「绿色」测试。

**Apply**：任何断言 hotspot DOM 的测试必须遵守这套 setup 契约（在 `tests/playwright/tests/annotation_overlay.spec.js` 的 `waitForHotspots(page)` helper 里实装）：

1. `els.hotspotLayer.innerHTML = ""` —— 先清掉层
2. `window.renderPdf()` —— 显式触发一次渲染
3. 轮询 `#hotspotLayer.children.length > 0`，纯读 DOM，不在 predicate 里 mutate render 状态

清→触发→等的三步保证「children > 0」严格意味「本次请求的渲染填充了层」。如果 `renderHotspots` 退化了不再填充，等待会 timeout 而非被 stale DOM 蒙混过关。

不要把这个 wait 写进 `loadPackageMin` 全局——`state.pdfViewBox` 在某些 test path 下永远到不了 non-null，会把不依赖 PDF 的测试全卡死（2026-05-27 实际撞过，37/37 退化到 22/37）。只在断言 hotspot DOM 的用例之前调用。

来源：2026-05-27 codex-audit pass 2 iter 1–4（迭代记录在 `CHANGELOG.md` "Audit pass 2" 一节）。

### CJK mojibake 修 spec，不修 fixture

spec 文件里出现 `ä½ å¥½`、`ç›´æŽ¥`、`æµ‹è¯•` 这种双重编码（真 CJK 先 UTF-8，再被当 Latin-1 解读，重新存 UTF-8——每个 CJK 字符变成 3 个垃圾 codepoint）时：

**修复 spec，不要反向把 fixture 编码成 mojibake 去匹配 spec。**

**Why**：DOM 的 `textContent` 会剥掉 C1 控制字符（U+0080–U+009F），fixture 里塞进 mojibake，浏览器读出来不会和 spec 里的 mojibake 字面相等。Path A（fixture 适配 spec）实测在浏览器里失败；Path B（spec 适配干净 fixture）才稳。

**Apply**：

```python
# whole-file 修复
raw = open(path, "rb").read()
fixed = raw.decode("utf-8").encode("latin-1").decode("utf-8")
# 顺手剥 BOM
if fixed.startswith("﻿"):
    fixed = fixed[1:]
open(path, "w", encoding="utf-8").write(fixed)
```

附带清理：注释里的破折号 / 制表线 mojibake 也要顺手处理；CJK 真正用到 emphasis 的位置（`你好`、`世界`）放进 `translations.json` 的 annotations[]，schema 必须带 `type: "format"|"comment"` 和 `text` 字段，否则 `app.js` 的 `isValidAnnotation` 整组拒收，overlay 不会渲染任何 `.ann-highlight`。

来源：2026-05-27 audit pass 1（Playwright 套件从 0/38 重建），fixer iter 2。

### codex CLI（PowerShell 5.1）—— 多行 prompt 走 stdin 而非 CLI arg

PowerShell 5.1 的 native 参数解析器在带 `+ ` 操作符的多行字符串上会折断。直接 `codex exec "...multiline..."` 报 parser error。

**Apply**：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
Get-Content -Raw -Encoding UTF8 '.\.scratch\prompt.txt' | & codex exec - 2>&1
```

要点：

- prompt 写文件，用 `-Raw -Encoding UTF8` 读
- `& codex exec -` 末尾 dash 表示从 stdin 读
- 合并 stderr 进 stdout 拿 codex 自己的报错（codex 把诊断信息走 stderr）
- 顺手 `$env:PYTHONIOENCODING = 'utf-8'` 防 CJK 内容触发 cp1252 编码错

通用模式，任何要把多行 prompt 喂给外部 CLI 工具的场景都适用（不限 codex）。来源：codex-audit skill 调用 codex 时反复撞 PS 解析错误后定型。

---

## 跨仓政策

### Translator 没手动标注的格式不要自动传播到 target

跨 indesign-toolkit + app-folio 两端的硬政策：在 webapp 里 translator **没有手动**标注的格式，pipeline / app 都不应该自动套到 target 上。区分两种情况：

- **auto-propagation**（"源有 X 但 target 没标 → 自动给 target 加 X"）—— **禁用**
- **cleanup-of-side-effects**（"源有 X 经 `range.contents=` 或 DOM 副作用 leak 到 target → 还原"）—— **保留**

app-folio 端约定：任何 AI / heuristic 生成的 annotation 必须显式带 `_auto: true` flag（例如 `target_emphasis_runs_auto: true`），让下游 pipeline 能识别。pipeline 端 `if (translation.target_X_auto === true)` 视为「未设置」跳过应用。

**Why**：2026-05-26 BMO Insurance Whole Life 项目里 BRIDGE-38（uniform link restyling）对 source 含 ≥18% link coverage 的段落自动套 Hyperlink CS + ruleBelow，结果 translator 没标注的段落也被染成蓝色下划线。用户拍板：「translator 未手动标注 → pipeline 不沿用源格式」。BRIDGE-35c（italic auto-backfill）同步关停。

**Apply**：

- app-folio 加新的 AI 建议 / heuristic 标注功能时，写入 `translations.json` 的 annotations[] 条目必须带 `_auto: true`（或在父对象层 `target_X_auto: true`）
- 不要静默地把 source 的 emphasis_runs 复制成 target 的初始 annotations——translator 主动「接受」之前 target 应该是空的
- pipeline 侧的具体配套（哪些 BRIDGE-NN 被 disable / retain）见 indesign-toolkit `CLAUDE.md` 的「用户策略」一节

---

## 仓库地形（简）

- `index.html` / `app.js` / `styles.css` —— webapp 入口 + 主逻辑（约 9000 行 JS）+ 样式
- `serve.js` —— 本地静态 server（默认 8080，含 URL automation token gate + `loadFolderFromServer` 后端、ZIP 上传等）
- `lib/zip_core.js` —— fflate 的 ZIP 读写包装（含 zip-bomb 前置 inflate filter，2026-05-27 安全加固）
- `lib/dom_text_measure.js` —— Phase 7-SC DOM 文本度量
- `lib/emphasis_overlay.js` —— Phase 8B+8C source emphasis 渲染 + target 建议
- `vendor/` —— pdf.js / jsPDF / fflate / Noto Sans SC 嵌入字体（PDF export 走 file:// 需要 base64 字体）
- `tests/` —— 整目录 `.gitignore`，spec / fixture 通过 `git add -f` 选择性跟踪。改测试相关文件，commit 时记得 `-f`
- `audit-logs/` —— `.gitignore`，codex-audit skill 三源合并的 JSONL（`~/.local/bin/merge_round_trip.py` 重生成）
- `CHANGELOG.md` —— `.gitignore`，本地 dev journal
- `start.bat` —— 启动本地 server
- `.scratch/` —— `.gitignore`，本地脚本临时文件 / Playwright 输出 / automation token

跑 Playwright：`cd tests/playwright && npx playwright test`（workers=1, retries=0，serialize）。phase7_sc_convergence 已在 `playwright.config.js` 的 `testIgnore` 排除——它需要比 `package_min` 更丰富的源版式 fixture，手动跑用 `npx playwright test phase7_sc_convergence`。

---

## 本文档的扩展

后续 session 攒到新的 non-obvious 规则就追加到对应小节。每条沿用：

- 具体可复现的规则（不是事故复盘）
- 一个 **Why** 行点明来源（事件 / `CHANGELOG.md` 锚点 / DEV_LOG 标号）
- 一个 **Apply** 块给出代码或步骤

如果规则被证伪或者被新做法取代，**改或删**，不要留 stale 指引。
