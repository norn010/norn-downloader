<div align="center">

<img src="icons/icon128.png" width="112" alt="Norn Downloader">

# Norn Downloader

**เลือกโหลดรูป วิดีโอ และสตรีมจากทุกเว็บ ได้ไฟล์ที่มีเสียงครบ ในคลิกเดียว**

Chrome extension (Manifest V3) · ไม่มี dependency · ไม่ต้อง build

![Chrome](https://img.shields.io/badge/Chrome-116%2B-f7941d?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-a8622c)
![Tests](https://img.shields.io/badge/tests-node%20--test-2f8a4c)

</div>

---

## ✨ ทำอะไรได้บ้าง

| | เว็บ / ชนิด | ได้อะไร |
|---|---|---|
| 🖼️ | **ทุกเว็บ** | รูป วิดีโอ เสียง ที่หน้าเว็บโหลด เลือกหลายไฟล์แล้วโหลดทีเดียว (เลือกขนาดใหญ่สุดจาก `srcset` ให้เอง) |
| 📺 | **สตรีม HLS (.m3u8)** | คลิปจบแล้วรวมเป็นไฟล์เดียว `.ts` / `.mp4` · ไลฟ์อัดต่อเนื่องจนกด Stop |
| 📘 | **Facebook** | reel / วิดีโอ → **HD · with sound** และ **SD · with sound** |
| 📸 | **Instagram** | โพสต์ · reel · story · highlights (อันที่กำลังดูขึ้นบนสุด) |
| 🎵 | **TikTok** | HD (H.265) และ SD (H.264) ไม่มีลายน้ำ |
| 🐦 | **X (Twitter)** | วิดีโอ · GIF · แอคล็อกที่เราฟอลอยู่ · บอกให้รู้ถ้าต้นฉบับไม่มีเสียง |
| ▶️ | **YouTube และอีกหลายพันเว็บ** | ส่งต่อให้ [yt-dlp](https://github.com/yt-dlp/yt-dlp) เลือกความละเอียดได้ ตั้งแต่ 360p ถึง 4K หรือเอาแต่เสียง MP3 |
| ⏺️ | **เว็บที่เหลือ** | อัดแท็บเป็น `.webm` ทั้งภาพและเสียง |

> ชิ้นส่วนวิดีโอที่แยกภาพ/เสียงของ Facebook, Instagram, TikTok และ X จะถูกซ่อนไว้ ไม่ให้สับสน เหลือแต่ไฟล์ที่มีเสียงพร้อมใช้

---

## 🚀 ติดตั้ง

1. ดาวน์โหลดหรือ clone repo นี้
   ```bash
   git clone https://github.com/norn010/norn-downloader.git
   ```
2. เปิด `chrome://extensions` → เปิด **Developer mode** (มุมขวาบน)
3. กด **Load unpacked** → เลือกโฟลเดอร์ `norn-downloader`
4. ปักหมุดไอคอนหนอน 🐛 ไว้ที่แถบเครื่องมือ

อยากโหลด YouTube ด้วย? ตั้งค่า yt-dlp เพิ่มอีกนิด ดูหัวข้อ **YouTube ด้วย yt-dlp** ด้านล่าง

---

## 🧭 วิธีใช้

1. เปิดหน้าเว็บที่มีรูป/วิดีโอ เลื่อนดูหรือกดเล่นให้โหลดก่อน
2. กดไอคอนหนอน

**วิดีโอที่มีเสียง** (Facebook / Instagram / TikTok / X) จะขึ้นเป็นการ์ดใหญ่ด้านบน กด **Download** ที่การ์ดได้เลย
ถ้าเข้ามาโดยการคลิกหรือเลื่อนในเว็บ จะขึ้น *Getting this video with sound…* สักครู่ (มีแท็บเบื้องหลังเปิดแป๊บนึงแล้วปิดเอง)

**ไฟล์อื่นๆ** อยู่ในตารางด้านล่าง กรองด้วยแท็บ **All · Images · Videos · Streams** ติ๊กที่ต้องการ (หรือ **Select all**) แล้วกด **Download** ที่แถบล่าง

**เมนู ⋯** มุมขวาบน:
- **⏺ Record this tab** อัดแท็บที่เปิดอยู่ กดอีกครั้งเพื่อหยุดและเซฟ (ใช้ได้ทุกเว็บ เล่นกี่นาทีก็ได้ไฟล์กี่นาที)
- **⏹ Stop live** หยุดอัดไลฟ์ HLS แล้วเซฟ
- **yt-dlp** โหลดหน้านี้ด้วย yt-dlp

### ไอคอนบอกสถานะ

| ป้าย | ความหมาย |
|---|---|
| `42%` | กำลังรวมไฟล์ / กำลังโหลดด้วย yt-dlp |
| `LIVE` | กำลังอัดไลฟ์ |
| `REC` | กำลังอัดแท็บ |
| `!` | มีปัญหา เปิด popup เพื่ออ่าน แล้วกด ✕ เพื่อปิด |

---

## ▶️ YouTube ด้วย yt-dlp

YouTube ล็อกลิงก์วิดีโอไว้ extension จึงส่งต่อให้ yt-dlp ในเครื่องเป็นคนโหลด (ใช้กับเว็บอื่นที่ yt-dlp รองรับได้ด้วย)

**ตั้งค่าครั้งเดียว** (Windows, ไม่ต้องใช้สิทธิ์ admin)

```powershell
powershell -ExecutionPolicy Bypass -File native\install.ps1
```

สคริปต์จะติดตั้ง **yt-dlp**, **ffmpeg** และ **Deno** ผ่าน winget แล้วลงทะเบียนตัวเชื่อมกับ Chrome ให้ user นี้เท่านั้น จากนั้นรีโหลด Norn Downloader ใน `chrome://extensions`

**ใช้งาน** บนหน้า YouTube ปุ่ม **⬇ yt-dlp** กับช่องเลือกความละเอียดจะอยู่บนสุดของ popup (เว็บอื่นอยู่ในเมนู ⋯) ไฟล์ไปอยู่ในโฟลเดอร์ **Downloads** เปิด popup อีกครั้งจะเห็น **✓ Saved** และปุ่ม **Open folder**

| ความละเอียด | ได้อะไร |
|---|---|
| **Best compatible (H.264)** | ค่าเริ่มต้น เปิดได้ทุกเครื่อง ปกติสูงสุด 1080p |
| **Max quality** | สูงสุดถึง 4K (VP9/AV1) เปิดด้วย VLC หรือ Chrome |
| **1080p · 720p · 480p · 360p** | ถ้าคลิปไม่มีขนาดนั้น จะได้ขนาดเล็กกว่าที่ใกล้ที่สุด |
| **Audio only (MP3)** | เอาแต่เสียง |

ชื่อไฟล์เป็น `ชื่อคลิป [id] 720p.mp4` จะได้ไม่ทับกัน และจำความละเอียดล่าสุดไว้ให้

---

## 🩺 แก้ปัญหา

<details>
<summary><b>YouTube โหลดไม่ได้</b></summary>

YouTube เปลี่ยนระบบบ่อย อัปเดต yt-dlp ก่อน
```powershell
winget upgrade yt-dlp.yt-dlp
```
ถ้าย้ายโฟลเดอร์ extension ต้องรัน `native\install.ps1` ใหม่ (id ของ extension คิดจากที่อยู่โฟลเดอร์)
</details>

<details>
<summary><b>ขึ้นว่า "The yt-dlp helper is not installed yet"</b></summary>

ยังไม่ได้รัน `native\install.ps1` หรือยังไม่ได้รีโหลด extension หลังรัน
</details>

<details>
<summary><b>X ขึ้น error บนโพสต์แอคล็อก</b></summary>

กด F5 ที่หน้า X แล้วเปิด popup ใหม่ extension ต้องเห็นข้อมูลที่ X โหลดหลังจากหน้าเปิด และต้องเข้าไปในโพสต์ก่อน (URL มี `/status/`)
</details>

<details>
<summary><b>การ์ดขึ้น "original has no sound"</b></summary>

วิดีโอต้นฉบับบน X ไม่มีเสียงอยู่แล้ว ไฟล์ที่ได้ถูกต้อง
</details>

<details>
<summary><b>เปิดไฟล์ HD ของ TikTok หรือ Max quality ใน Windows ไม่ได้</b></summary>

เป็น H.265 / VP9 / AV1 ใช้ VLC หรือ Chrome เปิด หรือเลือก SD / Best compatible (H.264) ที่เปิดได้ทุกเครื่อง
</details>

<details>
<summary><b>หาวิดีโอไม่เจอ</b></summary>

เว็บที่เล่นผ่าน stream player (blob:) จะไม่มีไฟล์ให้โหลดตรงๆ ใช้ ⋯ → **Record this tab**
</details>

### ข้อจำกัด

- เนื้อหา DRM (Netflix, Disney+ ฯลฯ) และสตรีมที่เข้ารหัส โหลดไม่ได้ อัดแท็บก็จะได้จอดำ
- สตรีม HLS ที่แยกเสียงเป็น playlist ต่างหาก จะได้แต่ภาพ
- CDN บางเจ้าเช็ค Referer จะโหลดไม่ได้ (HTTP 403)
- Record tab อัดแบบ real-time คลิป 5 นาทีต้องเปิดเล่นครบ 5 นาที
- YouTube: คลิปจำกัดอายุหรือสมาชิกเท่านั้น ยังไม่รองรับ

---

## 🛠️ สำหรับนักพัฒนา

```
background.js     ดักไฟล์จาก network, คิวงาน, badge, ดึงวิดีโอจาก Facebook/Instagram/TikTok/X, yt-dlp
popup.html/.js    หน้าต่าง popup
offscreen.js      รวม HLS, อัดไลฟ์, อัดแท็บ, ดาวน์โหลดไฟล์ TikTok
media.js          ฟังก์ชันล้วน: แยกชนิดไฟล์, อ่านข้อมูลวิดีโอของแต่ละเว็บ
hls.js            อ่าน m3u8, ดาวน์โหลดแบบขนานตามลำดับ
x-capture.js      เก็บข้อมูลวิดีโอที่ X โหลด (รวมแอคล็อก)
native/           ตัวเชื่อม yt-dlp (Node) + สคริปต์ติดตั้ง
docs/             spec และแผนการพัฒนา
```

รันเทส (Node 24+)

```bash
node --test
```

<details>
<summary><b>Checklist ทดสอบใน Chrome</b></summary>

- [ ] หน้าที่มีรูปเยอะ → รายการรูปมีขนาดไฟล์ เลือก 2 รูปแล้วโหลดได้ ไม่มี dialog
- [ ] เปิดไฟล์ mp4 ตรงๆ → อยู่ใน Videos โหลดได้
- [ ] สตรีม HLS ที่จบแล้ว → badge % → ได้ไฟล์เดียวเล่นได้มีเสียง
- [ ] ไลฟ์ HLS → badge LIVE → ⋯ → Stop live → ได้ไฟล์ยาวพอๆ กับเวลาที่อัด
- [ ] ⋯ → Record this tab บนวิดีโอ → ระหว่างอัดยังได้ยินเสียง → กดหยุด → ได้ .webm มีภาพและเสียง
- [ ] อัดแท็บแล้วปิดแท็บนั้นกลางทาง → ไฟล์ถูกเซฟเอง badge หาย
- [ ] วิดีโอ Facebook / Instagram / TikTok / X → การ์ด HD/SD ด้านบน กด Download ได้ไฟล์มีเสียง
- [ ] YouTube → ⬇ yt-dlp → badge % → ✓ Saved → Open folder
- [ ] Error: ใน console ของ offscreen.html (Inspect views) รัน `chrome.runtime.sendMessage({ type: 'error', message: 'test error' })` → badge `!` → popup แสดงแถบแดง → กด ✕ แล้วหาย

</details>
