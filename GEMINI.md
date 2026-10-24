# Project Context & Memory: `multi-ai-workflow`

Bạn đang làm việc trên dự án **`C:\laragon\www\multi-ai-workflow`** — Bộ công cụ & quy trình điều phối **Đa Tác Tử AI (Antigravity Gemini 4 Argon + Claude Code + OpenAI Codex CLI)** chuẩn Spec-Driven Development & Git Branch Isolation.

## 1. Bối cảnh & Những gì đã hoàn thành trong phiên trước

1. **Đã thiết lập và cài đặt lên Hệ thống Toàn cục (`~/.gemini` & `~/.claude`) đồng thời đóng gói vào repo `C:\laragon\www\multi-ai-workflow`**:
   - **Chế độ 1 (Mặc định khi mở dự án mới)**: Antigravity (`Gemini 4 Argon`) tự làm 100% bằng cách khởi tạo Git (`git init`), chốt `SPEC.md`, chia việc cho nhiều **Subagent chạy song song trên các nhánh riêng** (`Workspace: "share"` / `"branch"` hoặc `git worktree`), tự kiểm thử tích hợp, `git merge` và `git commit` (tốn 0 token của Claude/Codex).
   - **Chế độ 2 (Đội ngũ Đa AI 2 chiều khi gọi `/claude-leader` hoặc `/antigravity`)**:
     - **Claude Code (`claude.exe` v2.1.308 - đã đăng nhập gói Max `baoanhtsp@gmail.com`)**:
       - `Opus` (`-Role architect`, `--effort high`, `--tools ""`): Lên kiến trúc, chốt `SPEC.md`, giao việc Backend.
       - `Sonnet` (`-Role frontend`, `--effort medium`, `--tools "Read,Edit,Write"`): Viết **100% code Frontend** (nghiêm cấm Antigravity tự viết Frontend khi ở chế độ này).
       - `Sonnet` (`-Role reviewer`, `--effort medium`, `--tools ""`): Chấm điểm (`X/10`) bản `git diff` Backend của Antigravity cho đến khi `APPROVED`.
       - `Haiku` (`-Role ui-tweak`, `--effort low`): Tinh chỉnh nhanh CSS/UI nhỏ.
     - **OpenAI Codex CLI (`codex` v0.163.0 - đã đăng nhập ChatGPT)**:
       - Điều phối qua `invoke-codex.ps1` (`-Role review-diff`, `-Role critic`, `-Role coder` hỗ trợ `--worktree`).
     - **Cầu nối điều khiển ngược từ Claude sang Antigravity (`invoke-antigravity.ps1` & `save-agentapi-env.ps1`)**:
       - Giải quyết triệt để lỗi thiếu `ANTIGRAVITY_CSRF_TOKEN` và `ANTIGRAVITY_LS_ADDRESS` khi Claude gọi `agentapi.bat` từ ngoài vào bằng cách lưu ra file cầu nối `~/.gemini/antigravity/agentapi-bridge.json` và tự động nạp vào `invoke-antigravity.ps1`.
       - Đã cài đặt `~/.claude/CLAUDE.md` và lệnh tắt `/antigravity` (`~/.claude/commands/antigravity.md`).

2. **Cấu trúc file hiện có trong `C:\laragon\www\multi-ai-workflow`**:
   - `README.md`: Tài liệu hướng dẫn chi tiết (kèm sơ đồ Mermaid & bảng tối ưu 80% token).
   - `install.ps1`: Script cài đặt 1-click tự động thay thế `$env:USERPROFILE` cho máy người khác.
   - `antigravity/rules/claude-leader-workflow.md`
   - `antigravity/skills/claude-leader/SKILL.md`
   - `antigravity/skills/claude-leader/scripts/invoke-claude.ps1`
   - `antigravity/skills/claude-leader/scripts/invoke-codex.ps1`
   - `antigravity/skills/claude-leader/scripts/invoke-antigravity.ps1`
   - `antigravity/skills/claude-leader/scripts/save-agentapi-env.ps1`
   - `claude/CLAUDE.md`
   - `claude/commands/antigravity.md`

## 2. Lưu ý kỹ thuật khi mở phiên mới tại thư mục này
- Khi bắt đầu phiên mới tại `C:\laragon\www\multi-ai-workflow`:
  1. Xóa file `C:\Users\Admin\.gemini\config\hooks.json` và `C:\laragon\www\multi-ai-workflow\antigravity\hooks.json` (nếu còn tồn tại) vì cơ chế đồng bộ `agentapi-bridge.json` đã được tích hợp thẳng vào `invoke-claude.ps1` và `save-agentapi-env.ps1` gọn nhẹ hơn.
  2. Chạy `save-agentapi-env.ps1` 1 lần để cập nhật `ANTIGRAVITY_CSRF_TOKEN` & `ANTIGRAVITY_LS_ADDRESS` của phiên mới vào `~/.gemini/antigravity/agentapi-bridge.json`.
  3. Kiểm tra `git status` và commit sạch sẽ trước khi đẩy lên GitHub (`baoanhtsp`).
