# Auto Translation Dropdown Guide

## Overview

The translation feature has been upgraded from a single button to a dropdown menu with quick language direction switching.

## UI Changes

### Before
```
[Dev Translate All] (single button)
```

### After
```
[🌐 Auto Translate ▼] (dropdown button)
  ├─ English → 简体中文
  ├─ 简体中文 → English
  ├─ ─────────────────
  └─ ⚙ Advanced Settings
```

## Features

### 1. Quick Translation Directions

**English → 简体中文**
- Source: `en`
- Target: `zh-CN`
- Button label changes to: `EN → 中`

**简体中文 → English**
- Source: `zh-CN`
- Target: `en`
- Button label changes to: `中 → EN`

### 2. Button States

- **Default**: `🌐 Auto Translate ▼`
- **After EN→中**: `🌐 EN → 中 ▼`
- **After 中→EN**: `🌐 中 → EN ▼`
- **Custom pair example**: `🌐 EN → JA ▼`
- **During translation**: `🌐 Translating... ▼` (disabled)

### 3. Advanced Settings

Click "⚙ Advanced Settings" to configure:
- Translation provider (google_web/google_cloud/proxy/mock)
- Custom language pairs
- Batch size (1-100 segments per cycle)
- Request delay (0-3000 ms)
- Overwrite existing translations
- Skip simple text (numbers/punctuation)
- Skip reviewed segments

## Usage

### Quick Start

1. **Load a translation package**
   ```
   Click "Open Package Folder" → Select folder with segments.json
   ```

2. **Choose translation direction**
   ```
   Click "Auto Translate" dropdown
   → Select "English → 简体中文" or "简体中文 → English"
   ```

3. **Confirm and translate**
   ```
   Confirm dialog → Wait for completion
   ```

### Advanced Configuration

1. **Open settings**
   ```
   Click "Auto Translate" dropdown → "Advanced Settings"
   ```

2. **Configure provider**
   ```
   Provider: google_web (default, free)
   Source: en
   Target: zh-CN
   Batch: 20 segments per cycle
   Delay: 80 ms
   ```

3. **Set options**
   ```
   Overwrite existing: No (recommended)
   Skip simple text: Yes (recommended)
   Skip reviewed: Yes (recommended)
   ```

## Technical Details

### Files Modified

1. **index.html** (Lines 37-50)
   - Added dropdown wrapper
   - Added button with icon and label
   - Added dropdown menu with options

2. **styles.css** (Lines 96-180, 1428-1448)
   - Added `.translate-dropdown-wrap` styles
   - Added `.translate-btn` styles
   - Added `.translate-dropdown` styles
   - Added `.translate-option` styles
   - Added dark theme support

3. **dev_translate.js** (Lines 37-140)
   - Replaced `init()` with `initDropdownUI()`
   - Added `handleTranslateDirection(direction)`
   - Added config-driven button label sync
   - Added dropdown open/close handlers
   - Updated `runAutoTranslate()` to use new button IDs
   - Enhanced `configureInteractively()` with better prompts

### Configuration Storage

Settings are saved in `localStorage`:
```javascript
Key: "translator_app.dev_translate_config"

Value: {
  provider: "google_web",
  sourceLang: "en",
  targetLang: "zh-CN",
  batchSize: 20, // segments processed before optional delay
  requestDelayMs: 80,
  overwriteExisting: false,
  skipSimpleText: true,
  skipReviewed: true,
  apiKey: "",
  googleWebEndpoint: "https://translate.googleapis.com/translate_a/single",
  googleEndpoint: "https://translation.googleapis.com/language/translate/v2",
  proxyUrl: "http://127.0.0.1:8787/translate"
}
```

### Event Handling

```javascript
// Dropdown toggle
autoTranslateBtn.click → toggle dropdown

// Direction selection
option[data-direction="en-zh"] → translate EN to ZH
option[data-direction="zh-en"] → translate ZH to EN

// Advanced settings
option[data-action="config"] → open configuration dialog

// Close dropdown
document.click (outside) → close
Escape key → close
```

## Keyboard Shortcuts

- **Click dropdown**: Open/close menu
- **Escape**: Close dropdown
- **Click option**: Execute and close

## Accessibility

- Button has clear label and icon
- Escape closes the dropdown
- Options have hover states
- Dark theme support included

## Troubleshooting

### Dropdown not appearing
- Check browser console for errors
- Verify `dev_translate.js` is loaded after `app.js`
- Clear browser cache and reload

### Translation fails
- Check network tab for API errors
- Verify provider configuration
- Try "Advanced Settings" → change provider to "mock" for testing

### Button label not updating
- Check `localStorage` for saved config
- Clear `localStorage` and reconfigure
- Verify `syncButtonLabelFromConfig()` runs on load

### CORS errors (Google Web API)
- Use proxy provider instead
- Or use Google Cloud API with API key
- Treat `google_web` as a best-effort dev option

## Migration from Old Version

Old code (removed):
```javascript
// Old button creation in init()
const btn = document.createElement("button");
btn.id = "devTranslateAllBtn";
btn.textContent = "Dev Translate All";
```

New code:
```javascript
// New dropdown UI in HTML
<button id="autoTranslateBtn" class="btn translate-btn">
  <span class="translate-icon">🌐</span>
  <span id="translateBtnLabel">Auto Translate</span>
  <span class="dropdown-arrow">▼</span>
</button>
```

## Future Enhancements

Potential improvements:
- Add more language pairs (JA, KO, etc.)
- Show translation progress bar
- Add keyboard shortcuts for directions
- Support custom language pair presets
- Add translation quality indicators

## Support

For issues or questions:
- Check browser console for errors
- Review priorities in `ROADMAP.md` §2.13
- Test with mock provider first
- Verify package is loaded correctly
