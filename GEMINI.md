# Project Context & Memory: `multi-ai-workflow`

Bạn đang làm việc trên dự án **`C:\laragon\www\multi-ai-workflow`** — Bộ công cụ & quy trình điều phối **Đa Tác Tử AI (Antigravity Gemini 4 Argon + Claude Code + OpenAI Codex CLI)** chuẩn Spec-Driven Development & Git Branch Isolation.

## 1. Bối cảnh & Những gì đã hoàn thành

1. **Đã thiết lập và cài đặt lên Hệ thống Toàn cục (`~/.gemini` & `~/.claude`) đồng thời đóng gói vào repo `C:\laragon\www\multi-ai-workflow`**:
   - **Chế độ 1 (Mặc định khi mở dự án mới)**: Antigravity (`Gemini 4 Argon`) tự làm 100% bằng cách khởi tạo Git (`git init`), chốt `SPEC.md` (theo mẫu `templates/SPEC.template.md`), chia việc cho nhiều **Subagent chạy song song trên các nhánh riêng** (`Workspace: "share"` / `"branch"` hoặc `git worktree`), tự kiểm thử tích hợp, `git merge` và `git commit` (tốn 0 token của Claude/Codex).
   - **Chế độ 2 (Đội ngũ Đa AI 2 chiều khi gọi `/claude-leader` hoặc `/antigravity`)**:
     - **Claude Code (`claude.exe` v2.1.308 - đã đăng nhập gói Max `baoanhtsp@gmail.com`)**:
       - `Opus` (`-Role architect`, `--effort high`, `--tools ""`): Lên kiến trúc, chốt `SPEC.md`, giao việc Backend.
       - `Sonnet` (`-Role frontend`, `--effort medium`, `--tools "Read,Edit,Write"`, `--add-dir $WorkDir`): Viết **100% code Frontend** (nghiêm cấm Antigravity tự viết Frontend khi ở chế độ này).
       - `Sonnet` (`-Role reviewer`, `--effort medium`, `--tools ""`, `-IncludeGitDiff`): Chấm điểm (`X/10`) bản `git diff` Backend của Antigravity cho đến khi `APPROVED`.
       - `Haiku` (`-Role ui-tweak`, `--effort low`, `--add-dir $WorkDir`): Tinh chỉnh nhanh CSS/UI nhỏ.
     - **OpenAI Codex CLI (`codex` v0.163.0 - đã đăng nhập ChatGPT)**:
       - Điều phối qua `invoke-codex.ps1` (`-Role review-diff`, `-Role critic`, `-Role coder` hỗ trợ `--worktree`, `-PromptFile` & `-IncludeGitDiff`).
     - **Cầu nối điều khiển ngược từ Claude sang Antigravity (`invoke-antigravity.ps1` & `save-agentapi-env.ps1`) — Nâng cấp v2**:
       - **Zero-Config Live Self-Healing Bridge**: Khi file `~/.gemini/antigravity/agentapi-bridge.json` chưa có hoặc Antigravity IDE vừa khởi động lại (đổi Port/CSRF Token), `invoke-antigravity.ps1` và `save-agentapi-env.ps1` tự động dò tiến trình `language_server*.exe` qua `Win32_Process` + `Get-NetTCPConnection`, trích xuất `--csrf_token` và cổng lắng nghe thực tế, rồi tự thử lại (`retry`) không bao giờ đứt kết nối.
       - **Định tuyến chuẩn xác theo thư mục dự án (`-WorkDir`)**: Tự động quét `transcript.jsonl` để khớp cửa sổ hội thoại Antigravity đang làm việc với đúng dự án đó (tránh bắn nhầm lệnh khi mở nhiều cửa sổ).
       - **Chờ hoàn tất & Đọc toàn văn không cắt cụt (`-Wait` + `transcript_full.jsonl`)**: Tự động chờ đến khi bước phản hồi cuối cùng của Antigravity đạt `status == "DONE"` và lấy trọn vẹn nội dung từ `transcript_full.jsonl` khi `truncated_fields` xuất hiện.
       - **Chống nuốt biến `$` trong PowerShell (`-PromptFile` & `-IncludeGitDiff`)**: Tích hợp vào cả `invoke-claude.ps1` và `invoke-codex.ps1`, truyền nội dung qua `stdin` an toàn.
       - Đã cài đặt `~/.claude/CLAUDE.md` và lệnh tắt `/antigravity` (`~/.claude/commands/antigravity.md`).
     - **Nâng cấp v3 — Parallel AI Council Review, Health Doctor, Telemetry Audit & CI/CD**:
       - **`invoke-council-review.ps1`**: Chạy song song cả **Claude Sonnet (`-Role reviewer`)** và **OpenAI Codex (`-Role review-diff`)** bằng PowerShell Background Jobs, giảm 50% thời gian chờ chấm điểm và tổng hợp báo cáo hội đồng.
       - **JSONL Telemetry & Audit Log (`~/.gemini/antigravity/multi-ai-audit.jsonl`)**: Tự động ghi log thời lượng thực thi, vai trò, trạng thái và ước tính lượng token mỗi lần gọi Claude/Codex/Council.
       - **`doctor.ps1`**: Công cụ kiểm tra sức khỏe hệ thống 1-click (Git, Claude CLI, Codex CLI, Live Self-Healing Bridge, file cài đặt toàn cục và thống kê Audit Log).
       - **`templates/SPEC.template.md`**: Mẫu hợp đồng `SPEC.md` chuẩn SDD gồm kiến trúc, DB Schema, API Contract, Ma trận phân quyền file (`Zero-Conflict Boundary`), UI Design System Seed và bảng chấm điểm tối đa 2 vòng.
       - **`LICENSE` & `.github/workflows/ci.yml`**: Giấy phép MIT (`Copyright (c) 2026 baoanhtsp`) và GitHub Actions CI tự động kiểm tra AST cú pháp PowerShell (`*.ps1`), cấu trúc repo và test chạy thử `install.ps1` trên `windows-latest`.

2. **Cấu trúc file hiện có trong `C:\laragon\www\multi-ai-workflow`**:
   - `.github/workflows/ci.yml`: GitHub Actions workflow kiểm tra cú pháp PowerShell & 1-Click Installer.
   - `.gitignore`: Loại trừ file tạm và `SESSION_MEMORY.md`.
   - `LICENSE`: Giấy phép MIT.
   - `GEMINI.md`: Bộ nhớ ngữ cảnh dự án cho Antigravity.
   - `README.md`: Tài liệu hướng dẫn chi tiết (kèm Badges, sơ đồ Mermaid & bảng tối ưu 80% token).
   - `install.ps1`: Script cài đặt 1-click tự động thay thế `$env:USERPROFILE` cho máy người khác.
   - `doctor.ps1`: Script chẩn đoán sức khỏe hệ thống & thống kê lịch sử Audit Log.
   - `templates/SPEC.template.md`: Mẫu `SPEC.md` chuẩn Spec-Driven Development.
   - `antigravity/rules/claude-leader-workflow.md`
   - `antigravity/skills/claude-leader/SKILL.md`
   - `antigravity/skills/claude-leader/scripts/invoke-claude.ps1`
   - `antigravity/skills/claude-leader/scripts/invoke-codex.ps1`
   - `antigravity/skills/claude-leader/scripts/invoke-council-review.ps1`
   - `antigravity/skills/claude-leader/scripts/invoke-antigravity.ps1`
   - `antigravity/skills/claude-leader/scripts/save-agentapi-env.ps1`
   - `claude/CLAUDE.md`
   - `claude/commands/antigravity.md`

## 2. Lưu ý kỹ thuật khi mở phiên mới tại thư mục này
- Khi bắt đầu phiên mới tại `C:\laragon\www\multi-ai-workflow`:
  1. Cơ chế **Live Self-Healing Bridge** trong `save-agentapi-env.ps1` và `invoke-antigravity.ps1` đã tự động phát hiện Port & CSRF Token trực tiếp từ tiến trình `language_server*.exe` đang chạy, nên không cần tạo `hooks.json` nữa.
  2. Có thể chạy `powershell -ExecutionPolicy Bypass -File .\doctor.ps1` bất cứ lúc nào để kiểm tra trạng thái kết nối và thống kê `multi-ai-audit.jsonl`.
  3. Kiểm tra `git status` và commit sạch sẽ trước khi đẩy lên GitHub (`baoanhtsp`).
