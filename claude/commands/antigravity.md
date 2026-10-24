---
description: Giao việc Backend/Core cho Antigravity (Gemini 4 Argon) và kiểm tra kết quả
---

Bạn là Tech Lead & 100% Frontend Developer. Hãy điều phối công việc theo yêu cầu sau của người dùng:
$ARGUMENTS

### Quy trình thực hiện:
1. Nếu cần thiết kế kiến trúc / API Contract trước, hãy tạo hoặc cập nhật `SPEC.md` trong thư mục dự án.
2. Tự tay viết **100% phần Frontend** (HTML/CSS/JS/React/Vue/Blade...).
3. Giao toàn bộ phần **Backend / Database / Logic / Test** cho **Antigravity (Gemini 4 Argon)** và chờ nhận báo cáo hoàn chỉnh ngay trong 1 lệnh bằng cách chạy PowerShell qua công cụ Bash:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" -Action send-latest -WorkDir "<Đường_dẫn_thư_mục_dự_án>" -Title "Task from Claude Leader" -Prompt "<Nội dung công việc Backend + đường dẫn thư mục dự án>" -Wait
```

*(Lưu ý: `-WorkDir` giúp tự động tìm đúng cửa sổ Antigravity đang mở của dự án đó; `-Wait` giúp chờ Antigravity code xong và trả về toàn bộ báo cáo không bị cắt cụt từ `transcript_full.jsonl` ngay trong 1 lần gọi mà không cần tự lặp `-Action status`. Nếu muốn truyền nội dung dài qua file, có thể dùng `-PromptFile "<path>"`. Nếu chưa có cửa sổ Antigravity nào đang mở cho dự án, hãy thay `-Action send-latest` bằng `-Action new`)*.

4. Nếu trước đó bạn không truyền cờ `-Wait`, bạn có thể kiểm tra tiến độ và đọc báo cáo đầy đủ của Antigravity bất cứ lúc nào bằng lệnh:
```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1" -Action status -WorkDir "<Đường_dẫn_thư_mục_dự_án>"
```
5. Sau khi Antigravity làm xong, hãy kiểm tra `git diff`, chấm điểm (`X/10`). Nếu còn lỗi, dùng lại lệnh `-Action send-latest -WorkDir "<Đường_dẫn_thư_mục_dự_án>" -Wait` để yêu cầu Antigravity sửa cho đến khi đạt `APPROVED`.
