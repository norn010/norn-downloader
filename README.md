# Norn Downloader

Chrome extension สำหรับเลือกโหลดรูป / วิดีโอ / สตรีม HLS จากทุกเว็บ และอัดแท็บเป็นวิดีโอ

## ติดตั้ง

1. เปิด `chrome://extensions` แล้วเปิด **Developer mode** (มุมขวาบน)
2. กด **Load unpacked** แล้วเลือกโฟลเดอร์นี้
3. ปักหมุดไอคอน Norn Downloader ไว้ที่แถบเครื่องมือ

## ใช้งาน

- เปิดหน้าเว็บ เลื่อนดู/กดเล่นวิดีโอให้โหลดก่อน แล้วกดไอคอน
- เลือกแท็บ **Images / Videos / Streams** ติ๊กรายการที่ต้องการ แล้วกด **Download**
- สตรีม (m3u8): ถ้าเป็นคลิปจบแล้วจะรวมเป็นไฟล์เดียว (.ts หรือ .mp4) ถ้าเป็นไลฟ์จะเริ่มอัดจากจุดล่าสุดไปจนกด **Stop live**
- Facebook reel/วิดีโอ และ Instagram post/reel: ด้านบนสุดจะมี **HD · with sound** / **SD · with sound** (ไฟล์ mp4 มีเสียง) ถ้าเข้ามาจากการคลิก/เลื่อนในเว็บ จะขึ้น "Getting this video with sound…" สักครู่ (เปิดแท็บเบื้องหลังแป๊บนึงแล้วปิดเอง) ชิ้นส่วนภาพ/เสียงแยกจะไม่แสดง รองรับ IG story และ highlights (highlights จะขึ้นทุกคลิป เรียงตามลำดับ อันที่กำลังดูอยู่จะอยู่บนสุด "This story")
- ไม่เจอวิดีโอ (เช่น reel / story ที่เล่นผ่าน blob:) → กด **Record tab** แล้วเล่นวิดีโอ กด **Stop recording** เมื่อจบ (ได้ไฟล์ .webm)
- ไอคอนแสดงสถานะ: `42%` กำลังรวมไฟล์, `LIVE` กำลังอัดไลฟ์, `REC` กำลังอัดแท็บ, `!` มี error (เปิด popup เพื่อดู)

## ข้อจำกัด

- เนื้อหา DRM (Netflix, Disney+ ฯลฯ) และสตรีมที่เข้ารหัส โหลดไม่ได้ อัดแท็บก็จะได้จอดำ
- Reel ของ IG/FB ที่จับได้จาก network มักเป็นวิดีโอไม่มีเสียง (เสียงแยกไฟล์) → ใช้ Record tab
- สตรีมที่แยกเสียงเป็น playlist ต่างหาก จะได้แต่ภาพ
- CDN บางเจ้าเช็ค Referer จะโหลดไม่ได้ (ขึ้น HTTP 403)
- Record tab อัดแบบ real-time: คลิปยาว 5 นาทีต้องเปิดเล่นให้ครบ 5 นาที

## ทดสอบ

```bash
node --test
```

### Checklist ทดสอบใน Chrome

- [ ] หน้า `<page with many images>` → รายการรูปมีขนาดไฟล์ เลือก 2 รูปแล้วโหลดได้ ไม่มี dialog
- [ ] เปิด mp4 ตรงๆ (เช่น `<direct mp4 URL>`) → อยู่ใน Videos โหลดได้
- [ ] HLS VOD: hls.js demo (`<HLS player page>`) + `<public HLS VOD test stream>` → badge % → ได้ .ts เล่นได้มีเสียง
- [ ] Live: `<public live HLS test stream>` ใน hls.js demo → badge LIVE → Stop live → ได้ไฟล์ยาวพอๆ กับเวลาที่อัด
- [ ] Record tab บน YouTube → ระหว่างอัดยังได้ยินเสียง → Stop recording → ได้ .webm มีภาพและเสียง
- [ ] Record tab แล้วปิดแท็บนั้นกลางทาง → ไฟล์ถูกเซฟเอง badge หาย
- [ ] Error: ใน console ของ offscreen.html (Inspect views) รัน `chrome.runtime.sendMessage({ type: 'error', message: 'test error' })` → badge `!` → popup แสดงแถบแดง → กด × แล้วหาย
