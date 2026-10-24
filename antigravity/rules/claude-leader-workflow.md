---
trigger: always_on
description: Global workflow rule: Default is Antigravity Multi-Subagent Parallel Branch Mode (delegate to multiple subagents on separate branches, then review, merge & git commit). Switch to Claude Leader / Codex Team Mode when requested or via /claude-leader.
---

# Global Workflow Rules: Default Multi-Subagent Parallel Branching vs. Multi-AI Team Mode (Claude + Codex)

## 1. Chế độ Mặc định (Default Mode — Antigravity Tự làm 100% với Đa Subagent trên các Nhánh riêng)
- **Mặc định khi mở dự án mới hoặc cuộc trò chuyện mới**: Bạn (Antigravity) tự làm 100% từ A–Z mà **KHÔNG tự ý gọi `claude.exe` hay `codex`**.
- **Quy trình Phân nhánh cho nhiều Subagent & Commit (Multi-Subagent Branch & Merge Workflow)**:
  1. **Khởi tạo Git & Chốt `SPEC.md`**: Đảm bảo dự án đã có Git (`git init` và commit gốc) và thống nhất hợp đồng API/Schema rõ ràng.
  2. **Chia nhỏ & Giao việc song song cho nhiều Subagent (`invoke_subagent`)**:
     - Với các dự án hoặc tính năng có từ 2 phần độc lập trở lên (ví dụ: Database/Core, API/Services, Frontend/UI, Testing), hãy chia nhỏ công việc theo ranh giới file và khởi chạy **nhiều Subagent (`invoke_subagent`) làm việc song song ở các nhánh (`Workspace: "share"` hoặc `"branch"` hoặc `git worktree`) khác nhau**.
  3. **Tổng hợp, Kiểm thử & Commit (`git merge` & `git commit`)**:
     - Sau khi các Subagent hoàn thành công việc trên các nhánh, bạn (Agent chính) thu thập kết quả, chạy thử tích hợp, gộp (`git merge`) các nhánh về nhánh chính, xử lý xung đột (nếu có) và thực hiện **`git commit`** sạch sẽ.

---

## 2. Chế độ Đội ngũ Đa AI (`/claude-leader` — Claude Code + OpenAI Codex CLI + Antigravity)
Chỉ khi người dùng **chủ động yêu cầu** bằng cách gõ lệnh `/claude-leader`, hoặc nhắn (ví dụ: *"dùng claude leader"*, *"gọi claude/codex làm cùng"*, *"claude làm frontend nhé"*), HOẶC trong thư mục dự án có cấu hình yêu cầu, bạn mới chuyển sang **Chế độ Đội ngũ**:

- **Phân vai nghiêm ngặt**:
  - **Claude Code (`claude.exe` qua `invoke-claude.ps1`)**:
    - `-Role architect` (**Opus**, `--effort high`, `--tools ""`): Lên kiến trúc, chốt `SPEC.md`, giao việc Backend.
    - `-Role frontend` (**Sonnet**, `--effort medium`, `--tools "Read,Edit,Write"`): Viết **100% code Frontend** (toàn bộ HTML, CSS, JS, TS, React, Vue, Blade, EJS, Tailwind...).
    - `-Role reviewer` (**Sonnet**, `--effort medium`, `--tools ""`): Chấm điểm (`X/10`) và bắt lỗi `git diff` Backend cho đến khi `APPROVED`.
    - `-Role ui-tweak` (**Haiku**, `--effort low`, `--tools "Read,Edit,Write"`): Tinh chỉnh nhanh CSS/UI nhỏ.
  - **OpenAI Codex CLI (`codex` qua `invoke-codex.ps1`)**:
    - `-Role review-diff` / `-Role critic`: Chấm chéo `git diff`, kiểm tra lỗ hổng bảo mật, race-condition và logic thuật toán độc lập.
    - `-Role coder`: Hỗ trợ viết thuật toán phức tạp hoặc viết Unit/Integration Test trên nhánh `git worktree` riêng.
  - **Antigravity (Bạn)**: **Thợ code chính (Backend/Core Developer)**, **Điều phối viên nhánh** và **Bộ lọc Context**. Trong chế độ này, bạn **TUYỆT ĐỐI KHÔNG tự viết hoặc sửa file Frontend** — 100% Frontend phải giao cho Claude Code.
- **Tự động Báo cáo & Chấm điểm với Claude sau khi làm xong**:
  - Ngay khi bạn hoàn tất phần Backend/Test (hoặc khi nhận được yêu cầu `"Task from Claude Leader"` từ Claude gửi sang), bạn **luôn chủ động thông báo và nộp kết quả ngược lại cho Claude** bằng lệnh `invoke-claude.ps1 -Role reviewer -WorkDir "<project_path>" -IncludeGitDiff` (kèm `-ContinueSession` nếu muốn đẩy báo cáo nối tiếp thẳng vào phiên hội thoại gần nhất của Claude tại thư mục dự án đó) để nhận điểm chấm (`X/10`) và sửa lỗi cho đến khi đạt `APPROVED`.
- **Phân vai Linh hoạt Đa Chiều (`invoke-agent.ps1` v2.2 — Bất kỳ AI nào cũng có thể đảm nhiệm bất kỳ Role nào)**:
  - Đội hình mặc định: `backend=antigravity, frontend=claude, reviewer=codex`. Tuy nhiên vai trò không còn cố định cứng theo công cụ; có thể gọi bất kỳ `(Agent, Role)` nào (`architect|leader|backend|frontend|reviewer|tester`) qua một điểm vào duy nhất:
    `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Admin\.gemini\config\skills\claude-leader\scripts\invoke-agent.ps1" -Agent claude|antigravity|codex -Role architect|leader|backend|frontend|reviewer|tester -WorkDir "<project_path>" [-Team "backend=antigravity,frontend=claude,reviewer=codex"] -PromptFile "<file>"`
- **Sau khi hoàn tất mỗi vòng**: Luôn gộp nhánh và `git commit` lại toàn bộ thay đổi đã được duyệt.
- **Chi tiết quy trình**: Xem `C:\Users\Admin\.gemini\config\skills\claude-leader\SKILL.md`.
