# 🚀 Quick Start Guide - Translation Dropdown

## 5-Minute Setup

### Step 1: Open the App
```bash
# Option A: Double-click to open in browser
translator_app/index.html

# Option B: Use local server (recommended)
cd translator_app
python3 -m http.server 8080
# Then open: http://localhost:8080
```

### Step 2: Load a Translation Package
1. Click **"Open Package Folder"**
2. Select a folder containing:
   - `segments.json` (required)
   - `preview.pdf` (optional)
   - `translations_template.json` (optional)

### Step 3: Choose Translation Direction
1. Click the **"🌐 Auto Translate ▼"** button
2. Select one of:
   - **English → 简体中文** (Translate English to Chinese)
   - **简体中文 → English** (Translate Chinese to English)

### Step 4: Confirm and Translate
1. Review the confirmation dialog:
   ```
   Auto-translate 85 segments?
   Direction: English → Chinese
   Provider: google_web
   ```
2. Click **OK** to start
3. Wait for completion (progress shown in status bar)

### Step 5: Review and Save
1. Check translated segments in the UI
2. Edit any translations that need adjustment
3. Click **"Save Outputs"** to download:
   - `translations.json`
   - `translation_qc_report.txt`
   - `ai_manual_handoff.txt`

---

## Visual Guide

### Before Translation
```
┌─────────────────────────────────────────┐
│ [Open Package] [Load Progress] [🌐 ▼]  │
└─────────────────────────────────────────┘
│
│ PDF Preview          │ Segments List
│ ┌─────────────┐     │ ┌──────────────┐
│ │             │     │ │ TID: seg_001 │
│ │   Page 1    │     │ │ Source: ...  │
│ │             │     │ │ Target: ___  │ ← Empty
│ └─────────────┘     │ └──────────────┘
```

### Click Dropdown
```
┌─────────────────────────────────────────┐
│ [Open Package] [Load Progress] [🌐 ▼]  │
│                                  ┌──────────────────┐
│                                  │ English → 简体中文 │
│                                  │ 简体中文 → English │
│                                  │ ─────────────────│
│                                  │ ⚙ Advanced...    │
│                                  └──────────────────┘
```

### After Translation
```
┌─────────────────────────────────────────┐
│ [Open Package] [Load Progress] [EN→中▼] │ ← Label changed
└─────────────────────────────────────────┘
│
│ PDF Preview          │ Segments List
│ ┌─────────────┐     │ ┌──────────────┐
│ │             │     │ │ TID: seg_001 │
│ │   Page 1    │     │ │ Source: ...  │
│ │   [Hotspot] │     │ │ Target: 你好  │ ← Translated!
│ └─────────────┘     │ └──────────────┘
```

---

## Common Scenarios

### Scenario 1: English Manual → Chinese Translation
```
1. Load English InDesign package
2. Click dropdown → "English → 简体中文"
3. Confirm → Wait
4. Review translations
5. Save outputs
6. Import translations.json back to InDesign
```

### Scenario 2: Chinese Manual → English Translation
```
1. Load Chinese InDesign package
2. Click dropdown → "简体中文 → English"
3. Confirm → Wait
4. Review translations
5. Save outputs
6. Import translations.json back to InDesign
```

### Scenario 3: Mixed Content (Skip Simple Text)
```
1. Load package with numbers, dates, product codes
2. Click dropdown → "⚙ Advanced Settings"
3. Set "Skip simple text" → Yes
4. Select direction → Translate
5. Only meaningful text is translated
6. Numbers/codes remain unchanged
```

---

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open dropdown | Click button |
| Close dropdown | `Escape` or click outside |
| Navigate options | `Tab` |
| Select option | `Enter` |
| Save outputs | `Ctrl+S` (when focused) |

---

## Troubleshooting

### ❌ "Load a translation package first"
**Problem**: Clicked translate before loading package
**Solution**: Click "Open Package Folder" first

### ❌ "No eligible segments to auto-translate"
**Problem**: All segments already translated or locked
**Solution**:
- Check "Overwrite existing" in Advanced Settings
- Or manually clear some translations first

### ❌ "Google translate HTTP 0" or CORS error
**Problem**: Browser blocking Google API
**Solution**:
1. Click dropdown → "⚙ Advanced Settings"
2. Change provider to "proxy" or "mock"
3. Or use browser extension to disable CORS

### ❌ Translations are poor quality
**Problem**: Machine translation limitations
**Solution**:
- Review and edit translations manually
- Use as first draft only
- Mark reviewed segments after editing

### ❌ Control tokens missing in translation
**Problem**: API removed special characters
**Solution**:
- App automatically preserves tokens
- Check translation_qc_report.txt for issues
- Use "Restore Deleted" button if needed

---

## Tips & Best Practices

### ✅ DO
- Load package before translating
- Review translations after completion
- Use "Skip reviewed" to protect edited segments
- Save outputs frequently
- Check QC report for token issues

### ❌ DON'T
- Don't translate without loading package
- Don't enable "Overwrite existing" unless needed
- Don't skip manual review
- Don't ignore control token warnings
- Don't translate locked/system segments

---

## Advanced Configuration

### Change Translation Provider

**Google Web (Free, Default)**
```
Provider: google_web
Pros: Free, no API key needed
Cons: Rate limited, may have CORS issues
```

**Google Cloud (Paid)**
```
Provider: google_cloud
API Key: YOUR_KEY_HERE
Pros: Reliable, higher quality, no CORS
Cons: Requires API key, costs money
```

**Custom Proxy**
```
Provider: proxy
Proxy URL: http://localhost:8787/translate
Pros: Full control, no CORS
Cons: Requires proxy server setup
```

**Mock (Testing)**
```
Provider: mock
Pros: Instant, no network needed
Cons: Fake translations only
```

### Adjust Batch Size
```
Small packages (< 50 segments): Batch = 10
Medium packages (50-200): Batch = 20 (default)
Large packages (> 200): Batch = 50
```

### Adjust Request Delay
```
No rate limit: Delay = 0 ms
Google Web API: Delay = 80 ms (default)
Strict rate limit: Delay = 200 ms
```

---

## File Structure

```
translator_app/
├── index.html              ← Main app (open this)
├── app.js                  ← Core functionality
├── dev_translate.js        ← Translation module
├── styles.css              ← UI styles
├── vendor/
│   └── pdf.min.js         ← PDF.js library
├── README.md              ← General documentation
├── TRANSLATION_DROPDOWN_GUIDE.md  ← Detailed guide
├── TEST_CHECKLIST.md      ← Test plan
└── QUICK_START.md         ← This file
```

---

## Next Steps

### For Users
1. ✅ Complete this quick start
2. 📖 Read [TRANSLATION_DROPDOWN_GUIDE.md](TRANSLATION_DROPDOWN_GUIDE.md) for details
3. 🧪 Follow [TEST_CHECKLIST.md](TEST_CHECKLIST.md) to verify
4. 💬 Provide feedback on translation quality

### For Developers
1. 🔍 Check code in `dev_translate.js`
3. 🎨 Customize styles in `styles.css`
4. 🚀 Deploy to production server

---

## Support

### Getting Help
- Check browser console (F12) for errors
- Review error messages in alerts
- Test with "mock" provider first
- Verify package structure

### Reporting Issues
Include:
- Browser and version
- Error message (screenshot)
- Package size (segment count)
- Translation direction used
- Provider configuration

---

## FAQ

**Q: Can I translate to other languages?**
A: Yes! Click "⚙ Advanced Settings" and enter custom language codes (ja, ko, fr, de, etc.)

**Q: How long does translation take?**
A: ~1-2 seconds per segment. 100 segments ≈ 2-3 minutes.

**Q: Can I undo translations?**
A: No automatic undo. Keep "Overwrite existing" disabled to preserve manual edits.

**Q: Are translations saved automatically?**
A: No. Click "Save Outputs" to download files.

**Q: Can I use offline?**
A: No. Translation requires internet connection to API.

**Q: Is my API key secure?**
A: Keys are stored in browser localStorage only. Not sent to any server except Google.

**Q: Can I translate multiple packages at once?**
A: No. Translate one package at a time.

**Q: What if translation fails midway?**
A: Partial results are applied. Re-run to continue from where it stopped.

---

## Success Checklist

- [ ] Opened translator_app/index.html
- [ ] Loaded a translation package
- [ ] Clicked dropdown and saw options
- [ ] Selected a translation direction
- [ ] Confirmed and waited for completion
- [ ] Reviewed translated segments
- [ ] Saved outputs successfully
- [ ] Imported translations.json to InDesign

**Congratulations! You're ready to use the translation dropdown! 🎉**
