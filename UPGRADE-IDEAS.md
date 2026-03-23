# NanoClaw Upgrade Ideas

未必最優先，返到屋企再處理。

---

## 同步系統

### [ ] 將 iCloud 同步從 cron 改為 launchd

**問題：** macOS cron daemon 冇 Full Disk Access，無法寫入 `~/Library/Mobile Documents/`（iCloud），導致 brain/ 同步斷掉。Google Drive（rclone 走網絡）不受影響。

**做法：**
1. 去 System Settings → Privacy & Security → Full Disk Access → 加 `/usr/sbin/cron`（短期方法）
2. 或者創建 launchd plist 代替 cron（推薦），以用戶身份運行，天生有足夠權限：

```xml
<!-- ~/Library/LaunchAgents/com.nanoclaw.brain-sync.plist -->
<key>ProgramArguments</key>
<array>
  <string>/usr/bin/rsync</string>
  <string>-a</string>
  <string>--delete</string>
  <string>/Users/chetchung/nanoclaw/groups/telegram_main/brain/</string>
  <string>/Users/chetchung/Library/Mobile Documents/iCloud~md~obsidian/Documents/ChetObsidian/2026HKPROJECT/brain/</string>
</array>
<key>StartInterval</key>
<integer>180</integer>
```

**現況：** 手動 rsync 可以正常運行，3個檔案已手動補同步（2026-03-22）。

---
