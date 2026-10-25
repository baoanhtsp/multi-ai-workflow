// Beginner guide: the "Get started" page, the "?" help drawer of every page and its texts. Talks to the page only
// through window.MAW plus the shell helpers (goPage, hubModel, hubTitle, pageTitle, navIcon, currentPage).
(function () {
  'use strict';
  const M = window.MAW;
  if (!M) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
  };

  // ---------- texts ----------
  const UI = {
    vi: {
      gsHello: 'Chào mừng đến Multi-AI Workflow',
      gsIntro: 'Bảng điều khiển này giúp bạn giao việc cho nhiều AI (Claude, Codex, Antigravity, Gemini…), theo dõi chúng làm, review kết quả và giữ chi phí trong tầm kiểm soát. Làm theo 5 bước dưới đây là đủ để bắt đầu.',
      gsProgress: '{n}/{total} bước đã xong',
      gsDone: 'Xong', gsTodo: 'Chưa làm', gsOptional: 'Tùy chọn',
      gsAllDone: 'Bạn đã sẵn sàng. Bấm “Hướng dẫn” ở góc phải mỗi trang bất cứ khi nào cần.',
      gsHide: 'Ẩn trang này khỏi menu', gsShow: 'Hiện lại trong menu', gsHiddenNote: 'Trang Bắt đầu đã được ẩn khỏi menu; mở lại bằng Ctrl K → “Bắt đầu” hoặc từ ngăn Hướng dẫn.',
      s1T: 'Chọn dự án', s1D: 'Dự án là thư mục code mà AI sẽ làm việc (thường nằm trong C:\\laragon\\www). Mọi trang đều làm việc trên dự án đang chọn ở thanh trên cùng.', s1A: 'Chọn dự án', s1Ok: 'Đang chọn: {name}',
      s2T: 'Kiểm tra các AI', s2D: 'Mỗi AI cần được cài và đăng nhập trên máy này. Trang Agent kiểm tra giúp bạn và chỉ cách sửa nếu thiếu.', s2A: 'Mở trang Agent', s2Ok: '{ok}/{n} AI sẵn sàng',
      s3T: 'Giao việc đầu tiên', s3D: 'Chọn AI cho từng vai (kiến trúc, backend, frontend, review), mô tả việc cần làm rồi bấm Chạy. Mỗi lần chạy là một “job”, log hiện trực tiếp ở dưới màn hình.', s3A: 'Giao việc', s3Ok: 'Đã có {n} job',
      s4T: 'Xem kết quả và review', s4D: 'Xem AI đã sửa gì ở Review diff: chấp nhận / từ chối từng đoạn, chấm điểm, hoặc gửi góp ý để AI sửa tiếp. Nhật ký cho biết mỗi lượt tốn bao nhiêu token và tiền.', s4A: 'Mở Review diff', s4B: 'Xem nhật ký',
      s5T: 'Bật lưới an toàn', s5D: 'Checkpoint chụp lại code trước mỗi job để khôi phục khi cần; Worktree cho AI làm trên bản sao riêng; Ngân sách và Chính sách chặn chi tiêu hoặc lệnh nguy hiểm.', s5A: 'Checkpoint', s5B: 'Ngân sách', s5C: 'Chính sách',
      gsTour: 'Mỗi mục trên menu làm gì', gsTerms: 'Thuật ngữ hay gặp', gsOpen: 'Mở',
      tour_overview: 'Số liệu chính, job gần đây, AI nào đang sẵn sàng.',
      tour_dispatch: 'Giao một việc cho một AI hoặc cả nhóm AI.',
      tour_workspace: 'Trò chuyện lâu dài với từng agent, chuyển việc giữa các agent.',
      tour_board: 'Bảng thẻ việc kiểu Kanban, tự chạy theo hàng đợi hoặc lịch.',
      tour_project: 'Review diff, tệp, checkpoint, worktree và cổng kiểm tra của dự án.',
      tour_activity: 'Hộp thư việc cần bạn xử lý và nhật ký mọi lượt gọi AI.',
      tour_quality: 'Chi phí, ngân sách, bảng xếp hạng AI và chính sách an toàn.',
      tour_settings: 'Cài đặt AI, máy chủ MCP và thông báo.',
      tour_other: 'Các trang khác do plugin thêm vào.',
      hTitle: 'Hướng dẫn', hWhat: 'Trang này để làm gì', hWhen: 'Khi nào dùng', hHow: 'Cách dùng', hTerms: 'Thuật ngữ',
      hClose: 'Đóng', hStart: 'Mở trang Bắt đầu', hKey: 'Mẹo: bấm phím ? để mở hướng dẫn, Esc để đóng.', hNone: 'Chưa có hướng dẫn chi tiết cho trang này.'
    },
    en: {
      gsHello: 'Welcome to Multi-AI Workflow',
      gsIntro: 'This dashboard lets you hand work to several AIs (Claude, Codex, Antigravity, Gemini…), watch them work, review the result and keep the cost under control. The 5 steps below are all you need to start.',
      gsProgress: '{n}/{total} steps done',
      gsDone: 'Done', gsTodo: 'To do', gsOptional: 'Optional',
      gsAllDone: 'You are all set. Press “Help” at the top right of any page whenever you need it.',
      gsHide: 'Hide this page from the menu', gsShow: 'Show it in the menu again', gsHiddenNote: 'Get started is hidden from the menu; reopen it with Ctrl K → “Get started” or from the Help drawer.',
      s1T: 'Pick a project', s1D: 'A project is the code folder the AIs work in (usually under C:\\laragon\\www). Every page works on the project selected in the top bar.', s1A: 'Pick a project', s1Ok: 'Selected: {name}',
      s2T: 'Check your AIs', s2D: 'Each AI must be installed and signed in on this machine. The Agents page checks that for you and shows how to fix what is missing.', s2A: 'Open Agents', s2Ok: '{ok}/{n} AIs ready',
      s3T: 'Run a first task', s3D: 'Pick an AI for each role (architect, backend, frontend, review), describe the work and press Run. Every run is a “job”; its log streams live at the bottom of the screen.', s3A: 'New task', s3Ok: '{n} jobs so far',
      s4T: 'Review the result', s4D: 'See what the AI changed in Review diff: accept / reject each hunk, give a score, or send feedback for another round. The log shows the tokens and cost of every call.', s4A: 'Open Review diff', s4B: 'Open the log',
      s5T: 'Turn on the safety nets', s5D: 'Checkpoints snapshot the code before each job so you can roll back; worktrees give an AI its own copy; Budget and Policy stop overspending and dangerous commands.', s5A: 'Checkpoints', s5B: 'Budget', s5C: 'Policy',
      gsTour: 'What each menu item does', gsTerms: 'Common terms', gsOpen: 'Open',
      tour_overview: 'Key numbers, recent jobs, which AIs are ready.',
      tour_dispatch: 'Hand one task to one AI or to a whole team.',
      tour_workspace: 'Long-running chats with each agent and hand-offs between agents.',
      tour_board: 'A Kanban board of task cards that run from a queue or on a schedule.',
      tour_project: 'Review diff, files, checkpoints, worktrees and quality gate of the project.',
      tour_activity: 'The inbox of things that need you and the log of every AI call.',
      tour_quality: 'Cost, budgets, the AI scoreboard and safety policy.',
      tour_settings: 'AI setup, MCP servers and notifications.',
      tour_other: 'Other pages added by plugins.',
      hTitle: 'Help', hWhat: 'What this page is for', hWhen: 'When to use it', hHow: 'How to use it', hTerms: 'Terms',
      hClose: 'Close', hStart: 'Open Get started', hKey: 'Tip: press ? to open help and Esc to close it.', hNone: 'There is no detailed help for this page yet.'
    }
  };

  const TERMS = {
    vi: [
      ['Agent', 'Một AI cụ thể đã cài trên máy: Claude Code, OpenAI Codex, Antigravity, Gemini CLI, Cursor, Aider.'],
      ['Vai trò', 'Việc AI đảm nhận trong một job: kiến trúc (SPEC), backend, frontend, review, tester…'],
      ['Job', 'Một lần chạy AI: có prompt, log trực tiếp, kết quả, chi phí và mã thoát.'],
      ['SPEC.md', 'Hợp đồng của dự án: ai được sửa file nào, yêu cầu là gì. SPEC Guard kiểm tra AI có làm đúng phạm vi.'],
      ['Checkpoint', 'Ảnh chụp code trước một job; có thể so sánh hoặc khôi phục về đó.'],
      ['Worktree', 'Bản sao riêng của repo trên một nhánh riêng, để AI làm mà không đụng code chính; xong thì merge hoặc bỏ.'],
      ['Best-of-N', 'Cho nhiều AI cùng làm một việc trong các worktree riêng rồi chọn bản tốt nhất.'],
      ['Handoff', 'Chuyển việc từ agent này sang agent khác kèm ngữ cảnh (ví dụ Lead → Worker → Tester).'],
      ['Cổng kiểm tra', 'Danh sách điều kiện (test pass, git sạch, điểm review…) phải xanh trước khi merge.'],
      ['Council', 'Nhiều AI cùng review một thay đổi rồi gộp kết luận.']
    ],
    en: [
      ['Agent', 'A specific AI installed on this machine: Claude Code, OpenAI Codex, Antigravity, Gemini CLI, Cursor, Aider.'],
      ['Role', 'What the AI does in a job: architect (SPEC), backend, frontend, reviewer, tester…'],
      ['Job', 'One AI run: a prompt, a live log, a result, a cost and an exit code.'],
      ['SPEC.md', 'The project contract: who may edit which files and what is required. SPEC Guard checks that the AI stayed in scope.'],
      ['Checkpoint', 'A snapshot of the code taken before a job; compare with it or roll back to it.'],
      ['Worktree', 'A separate copy of the repo on its own branch, so an AI can work without touching the main code; merge or discard it afterwards.'],
      ['Best-of-N', 'Let several AIs do the same task in separate worktrees, then keep the best result.'],
      ['Handoff', 'Passing work from one agent to another with its context (e.g. Lead → Worker → Tester).'],
      ['Quality gate', 'Conditions (tests pass, clean git, review score…) that must be green before a merge.'],
      ['Council', 'Several AIs review the same change and merge their verdicts.']
    ]
  };

  // Per-page help: what, when[], how[], terms[] (names from TERMS).
  const HELP = {
    vi: {
      start: { what: 'Trang làm quen: 5 bước để dùng dashboard lần đầu, giải thích từng mục menu và các thuật ngữ.', when: ['Lần đầu mở dashboard.', 'Khi quên một mục trên menu dùng để làm gì.'], how: ['Làm lần lượt 5 bước; mỗi bước tự đánh dấu “Xong” khi dashboard thấy bạn đã làm.', 'Bấm nút trong mỗi bước để đi thẳng tới trang cần dùng.', 'Khi đã quen, ẩn trang này khỏi menu.'], terms: ['Agent', 'Job'] },
      overview: { what: 'Bức tranh chung: tổng lượt gọi AI, chi phí, tỷ lệ duyệt, các job gần đây và AI nào đang sẵn sàng.', when: ['Mở đầu mỗi phiên làm việc.', 'Kiểm tra nhanh một job vừa chạy xong hay lỗi.'], how: ['Bấm một job trong “Job gần đây” để xem log và kết quả.', 'Dùng “Thao tác nhanh” để đi tới các việc hay làm.', 'Nếu một AI hiện “Chưa cài”, sang trang Agent để cài hoặc đăng nhập.'], terms: ['Job', 'Agent'] },
      dispatch: { what: 'Giao một việc cho AI: chọn ai làm vai nào, viết yêu cầu, rồi chạy.', when: ['Muốn một AI viết code, sửa lỗi, viết SPEC hoặc review.', 'Muốn cả nhóm AI làm theo quy trình Leader → code → review → sửa.'], how: ['Chọn “Một vai” hoặc “Cả nhóm”. Kéo AI vào vai, hoặc bấm vào ô vai để đổi AI.', 'Viết việc cần làm (hoặc chọn từ “Mẫu yêu cầu”). Ctrl + Enter để chạy.', 'Theo dõi log ở khung dưới màn hình; có thể dừng, điều hướng (steer) hoặc fork job.', '“Quy trình có sẵn” chạy nhanh các chuỗi hay dùng như chấm chéo hoặc tự động code → chấm → sửa.'], terms: ['Vai trò', 'Job', 'SPEC.md'] },
      workspace: { what: 'Không gian làm việc với nhiều agent có tên riêng (Lead, Worker, Tester…): mỗi agent có lịch sử chat, bộ nhớ và có thể chuyển việc cho nhau.', when: ['Việc dài cần trao đổi qua lại nhiều lượt.', 'Muốn một nhóm agent cố định cho một dự án.'], how: ['Bấm “Thiết lập đội” để tạo nhanh một nhóm từ mẫu, hoặc “+ Agent” để tạo từng agent.', 'Chọn agent ở cột trái rồi chat ở giữa; cột phải có Handoff, Tệp, Lịch sử, Auto Run và Bộ nhớ.', 'Dùng Handoff để chuyển việc kèm ngữ cảnh sang agent khác.'], terms: ['Handoff', 'Agent'] },
      board: { what: 'Bảng Kanban các thẻ việc. Thẻ ở cột “Chờ chạy” được bộ lập lịch tự giao cho AI theo giới hạn chạy song song.', when: ['Có nhiều việc nhỏ muốn xếp hàng cho AI làm dần.', 'Muốn chạy việc theo lịch (mỗi đêm, mỗi tuần…).'], how: ['Bấm “+ Thẻ mới”, viết yêu cầu, chọn dự án, AI và vai.', 'Kéo thẻ sang “Chờ chạy” để AI làm; thẻ xong sẽ sang “Cần duyệt” hoặc “Hoàn thành”.', '“Mẫu & đội hình” lưu prompt và đội hay dùng; “Lịch chạy” tạo việc định kỳ; “Giới hạn” đặt số job chạy cùng lúc.'], terms: ['Job'] },
      project: { what: 'Thông tin dự án đang chọn: SPEC.md, kiểm tra phân quyền, Git, nhánh và các thao tác nhanh.', when: ['Trước khi giao việc, để chắc SPEC và Git ổn.', 'Muốn tạo worktree, chạy kiểm tra hoặc nhập issue GitHub.'], how: ['“Kiểm tra SPEC” xem AI có sửa ngoài phạm vi được phép không.', 'Các nút Worktree / Kiểm tra / Tích hợp mở thẳng chức năng tương ứng.', 'Sub-tab phía trên dẫn tới Review diff, Tệp, Checkpoint, Worktree, Kiểm tra.'], terms: ['SPEC.md', 'Worktree'] },
      review: { what: 'Xem chính xác AI đã sửa gì (diff), chấp nhận hoặc từ chối từng đoạn, chấm điểm và gửi góp ý.', when: ['Sau mỗi job có sửa code.', 'Trước khi commit hoặc merge.'], how: ['Chọn nguồn: Working tree (thay đổi chưa commit), Nhánh, Job hoặc Commit, rồi bấm “Mở diff”.', 'Duyệt từng tệp; “Chấp nhận / Từ chối” cho từng đoạn hoặc cả tệp.', 'Chọn kết luận và điểm rồi “Lưu kết luận”, hoặc “Gửi góp ý cho agent” để AI sửa tiếp.'], terms: ['Council'] },
      files: { what: 'Duyệt cây thư mục của dự án, xem nội dung và lịch sử thay đổi của từng tệp.', when: ['Muốn xem nhanh một tệp AI vừa sửa.', 'Tìm tệp theo tên.'], how: ['Gõ tên vào ô tìm hoặc mở thư mục trong cây.', 'Chấm màu cạnh tệp cho biết tệp đã bị sửa / thêm.', '“Trình soạn thảo” mở tệp trong editor của bạn (mặc định VS Code).'], terms: [] },
      checkpoints: { what: 'Danh sách ảnh chụp code được tạo trước mỗi job (hoặc bằng tay). So sánh với hiện tại hoặc khôi phục.', when: ['AI làm hỏng code và bạn muốn quay lại.', 'Muốn xem một job đã đổi những gì.'], how: ['“Tạo checkpoint” để chụp ngay trạng thái hiện tại.', '“So với hiện tại” hoặc “Thay đổi ở bước này” để xem diff.', '“Khôi phục” đưa code về checkpoint (luôn tạo bản sao lưu an toàn trước).'], terms: ['Checkpoint'] },
      worktrees: { what: 'Quản lý worktree: bản sao riêng của repo trên nhánh riêng để AI làm việc cô lập; kèm Best-of-N, thao tác Git và dọn dẹp nhánh cũ.', when: ['Việc rủi ro, muốn tách khỏi code chính.', 'Muốn nhiều AI thử cùng một việc rồi chọn bản tốt nhất.', 'Repo có nhiều nhánh / worktree cũ cần dọn.'], how: ['“Worktree mới” tạo bản sao; “Chạy cô lập” giao việc cho AI trong worktree mới.', 'Xong thì Merge (có kiểm tra cổng) hoặc Bỏ.', 'Tab Best-of-N chạy nhiều AI song song; tab Dọn dẹp quét nhánh đã merge và cho xem trước khi xoá.'], terms: ['Worktree', 'Best-of-N', 'Cổng kiểm tra'] },
      checks: { what: 'Cổng chất lượng trước khi merge (git sạch, SPEC Guard, điểm review, TODO, các lệnh test) và cấu hình lệnh kiểm tra của dự án.', when: ['Trước khi merge một worktree hoặc chấp nhận kết quả của AI.', 'Thiết lập lần đầu các lệnh test cho dự án.'], how: ['“Chạy kiểm tra” chạy các lệnh test đã cấu hình.', '“Dò tự động” đề xuất lệnh test theo dự án; sửa rồi “Lưu cấu hình”.', 'Cổng đỏ sẽ chặn merge; “Bỏ qua cổng” chỉ dùng khi bạn chắc chắn.'], terms: ['Cổng kiểm tra', 'SPEC.md'] },
      inbox: { what: 'Những việc cần bạn xử lý: job lỗi, job bị chặn, lệnh chờ phê duyệt, AI bị giới hạn, gợi ý chạy lại.', when: ['Chuông trên thanh trên cùng có số.', 'Mỗi sáng, để dọn những gì AI để lại.'], how: ['“Thử lại” chạy lại job; “Mở” xem chi tiết; “Bỏ qua” khi không cần xử lý.', 'Lọc theo loại hoặc xem “Tất cả” để thấy mục đã xử lý.'], terms: ['Job'] },
      audit: { what: 'Dòng thời gian các job và nhật ký mọi lượt gọi AI: công cụ, vai, model, token, chi phí, điểm và kết luận.', when: ['Muốn biết AI nào tốn nhiều tiền.', 'Tra lại một lượt review hoặc một job cũ.'], how: ['Dòng thời gian: chọn khoảng 1 giờ → 7 ngày, dự án này hoặc mọi dự án; xuất Markdown / HTML để báo cáo.', 'Bảng nhật ký: mỗi dòng là một lượt gọi AI.'], terms: ['Job'] },
      budget: { what: 'Chi phí theo ngày và theo agent, ngân sách (mức cảnh báo / chặn), định tuyến dự phòng khi một AI hết lượt và tự phục hồi khi lỗi tạm thời.', when: ['Muốn giới hạn chi tiêu mỗi job / mỗi ngày.', 'Một AI hay bị giới hạn lượt và muốn tự chuyển sang AI khác.'], how: ['Bật “Bật ngân sách”, đặt mức cảnh báo và chặn rồi “Lưu”. Mặc định ngân sách tắt.', 'Định tuyến dự phòng: chọn thứ tự AI thay thế cho từng vai.', 'Tự phục hồi: tự chạy lại khi gặp lỗi 429 / quá tải.'], terms: [] },
      scoreboard: { what: 'Xếp hạng AI theo từng vai dựa trên điểm review, tỷ lệ được duyệt, chi phí và thời gian; kèm đề xuất đội tốt nhất.', when: ['Chọn AI nào cho vai nào.', 'So sánh hiệu quả và chi phí giữa các AI.'], how: ['Xem “Đội đề xuất” và bấm “Sao chép -Team” để dùng ngay khi giao việc.', 'Lọc theo vai, khoảng thời gian hoặc chỉ dự án đang chọn.'], terms: ['Vai trò'] },
      policy: { what: 'Luật an toàn cho AI: đường dẫn được bảo vệ, lệnh bị cấm, lệnh cần phê duyệt, theo từng vai.', when: ['Muốn chặn AI chạy lệnh nguy hiểm (git push --force, rm -rf…).', 'Muốn reviewer chỉ được đọc, không được sửa.'], how: ['Bật “Bật chính sách”, chọn vai (hoặc Mọi vai trò), thêm mẫu lệnh / đường dẫn rồi “Lưu chính sách”.', 'Lệnh cần phê duyệt sẽ hiện ở “Chờ phê duyệt” và trong Hộp thư.'], terms: ['Vai trò'] },
      agents: { what: 'Tình trạng từng AI: đã cài chưa, phiên bản, đăng nhập, model thực tế; kiểm tra team trước khi chạy, Doctor và các phiên Antigravity.', when: ['Lần đầu cài đặt.', 'Một job báo AI chưa cài hoặc chưa đăng nhập.'], how: ['“Kiểm tra sẵn sàng” thử nhanh các lệnh của team đang chọn (không tốn token).', 'AI chưa cài: “Sao chép lệnh cài” rồi chạy trong terminal. Chưa đăng nhập: “Mở terminal đăng nhập”.', '“Chạy Doctor” kiểm tra toàn bộ: node, git, script, hook.'], terms: ['Agent'] },
      mcp: { what: 'Máy chủ MCP (công cụ mở rộng cho AI) trong cấu hình của Claude, Codex và Gemini; thêm, sửa hoặc áp dụng cho mọi agent.', when: ['Muốn mọi AI dùng chung một công cụ (trình duyệt, cơ sở dữ liệu…).', 'Muốn đăng ký chính dashboard này làm máy chủ MCP.'], how: ['“Thêm server” rồi chọn agent áp dụng; luôn xem trước thay đổi và tự sao lưu cấu hình.', '“Áp dụng cho mọi agent” chép một server sang các agent khác.'], terms: [] },
      notify: { what: 'Thông báo khi job kết thúc: thông báo Windows, webhook Discord / Slack và Telegram (có thể điều khiển 2 chiều).', when: ['Chạy việc dài và không muốn ngồi chờ.'], how: ['Bật thông báo Windows hoặc dán URL webhook, rồi “Lưu cấu hình” và “Gửi thử”.', 'Telegram: nhập Bot Token và Chat ID; bật “2 chiều” để duyệt / chạy lại từ điện thoại.'], terms: [] }
    },
    en: {
      start: { what: 'The onboarding page: 5 steps for your first session, what each menu item does and the common terms.', when: ['The first time you open the dashboard.', 'When you forget what a menu item is for.'], how: ['Go through the 5 steps; each one turns “Done” by itself once the dashboard sees you did it.', 'The buttons in each step take you straight to the right page.', 'Once you know your way around, hide this page from the menu.'], terms: ['Agent', 'Job'] },
      overview: { what: 'The big picture: total AI calls, cost, approval rate, recent jobs and which AIs are ready.', when: ['At the start of every session.', 'To check whether a job just finished or failed.'], how: ['Click a job in “Recent jobs” to see its log and result.', 'Use “Quick actions” for the things you do most.', 'If an AI shows “Not installed”, go to Agents to install it or sign in.'], terms: ['Job', 'Agent'] },
      dispatch: { what: 'Hand a task to the AIs: pick who plays which role, write the request and run it.', when: ['You want an AI to write code, fix a bug, write a SPEC or review.', 'You want a whole team to run Leader → code → review → fix.'], how: ['Choose “One role” or “Whole team”. Drag an AI onto a role, or click a role to change its AI.', 'Write the task (or pick one from “Prompt templates”). Ctrl + Enter runs it.', 'Follow the log in the dock at the bottom; you can stop, steer or fork the job.', '“Ready-made flows” run common chains such as cross-review or auto code → review → fix.'], terms: ['Role', 'Job', 'SPEC.md'] },
      workspace: { what: 'A workspace of named agents (Lead, Worker, Tester…): each has its own chat history and memory, and they can hand work to each other.', when: ['Long tasks with a lot of back and forth.', 'A fixed team of agents for one project.'], how: ['“Team setup” creates a team from a template; “+ Agent” adds one agent.', 'Pick an agent on the left and chat in the middle; the right column has Handoffs, Files, History, Auto Run and Memory.', 'Use a handoff to pass work with its context to another agent.'], terms: ['Handoff', 'Agent'] },
      board: { what: 'A Kanban board of task cards. Cards in “Queued” are handed to the AIs by the scheduler, within the concurrency limits.', when: ['Many small tasks you want the AIs to work through.', 'Tasks that should run on a schedule (nightly, weekly…).'], how: ['Press “+ New card”, write the request, pick the project, AI and role.', 'Move a card to “Queued” to run it; it moves to “Needs review” or “Done” when finished.', '“Templates & presets” keeps prompts and teams you reuse; “Schedules” creates recurring work; “Limits” sets how many jobs run at once.'], terms: ['Job'] },
      project: { what: 'The selected project: SPEC.md, ownership check, Git, branches and quick actions.', when: ['Before handing work out, to make sure the SPEC and Git are fine.', 'To create a worktree, run checks or import a GitHub issue.'], how: ['“Check SPEC” tells you whether an AI edited files outside its scope.', 'The Worktree / Checks / Integrations buttons open those features directly.', 'The sub-tabs lead to Review diff, Files, Checkpoints, Worktrees and Checks.'], terms: ['SPEC.md', 'Worktree'] },
      review: { what: 'See exactly what the AI changed (the diff), accept or reject each hunk, score it and send feedback.', when: ['After every job that edits code.', 'Before a commit or a merge.'], how: ['Pick a source: Working tree (uncommitted changes), Branch, Job or Commit, then “Open diff”.', 'Go through the files; “Accept / Reject” each hunk or whole file.', 'Pick a verdict and score and “Save verdict”, or “Send feedback to the agent” for another round.'], terms: ['Council'] },
      files: { what: 'Browse the project tree, read files and see their change history.', when: ['To look at a file an AI just edited.', 'To find a file by name.'], how: ['Type in the search box or open folders in the tree.', 'A coloured dot marks modified / added files.', '“Editor” opens the file in your editor (VS Code by default).'], terms: [] },
      checkpoints: { what: 'Snapshots of the code taken before each job (or by hand). Compare with them or roll back.', when: ['An AI broke the code and you want to go back.', 'You want to see what a job changed.'], how: ['“Create checkpoint” snapshots the current state now.', '“Compare with now” or “Changes in this step” shows the diff.', '“Restore” puts the code back (a safety backup is always made first).'], terms: ['Checkpoint'] },
      worktrees: { what: 'Worktrees: separate copies of the repo on their own branches so an AI works in isolation; plus Best-of-N, Git actions and branch cleanup.', when: ['Risky work you want away from the main code.', 'Several AIs trying the same task so you can keep the best one.', 'A repo full of old branches / worktrees.'], how: ['“New worktree” makes a copy; “Run isolated” gives a task to an AI in a new worktree.', 'Afterwards Merge it (the gate is checked) or Discard it.', 'The Best-of-N tab runs several AIs in parallel; Cleanup finds merged branches and previews before deleting.'], terms: ['Worktree', 'Best-of-N', 'Quality gate'] },
      checks: { what: 'The pre-merge quality gate (clean git, SPEC Guard, review score, TODOs, test commands) and the project check commands.', when: ['Before merging a worktree or accepting an AI result.', 'Setting up the test commands of a project for the first time.'], how: ['“Run checks” runs the configured test commands.', '“Detect” suggests test commands for the project; edit them and “Save”.', 'A red gate blocks merges; use “Override” only when you are sure.'], terms: ['Quality gate', 'SPEC.md'] },
      inbox: { what: 'Things that need you: failed jobs, blocked jobs, commands waiting for approval, rate-limited AIs, suggested re-runs.', when: ['The bell in the top bar shows a number.', 'Every morning, to tidy up what the AIs left.'], how: ['“Retry” re-runs the job; “Open” shows details; “Dismiss” when nothing needs doing.', 'Filter by kind, or show “All” to see handled items.'], terms: ['Job'] },
      audit: { what: 'The job timeline and the log of every AI call: tool, role, model, tokens, cost, score and verdict.', when: ['To find which AI costs the most.', 'To look up an old review or job.'], how: ['Timeline: pick 1 hour → 7 days, this project or all; export Markdown / HTML for a report.', 'The log table: one row per AI call.'], terms: ['Job'] },
      budget: { what: 'Spend per day and per agent, budgets (warn / block levels), fallback routing when an AI runs out and auto-recovery from transient errors.', when: ['You want to cap the spend per job / per day.', 'An AI is often rate-limited and should hand over to another one.'], how: ['Tick “Enable budgets”, set the warn and block levels and “Save”. Budgets are off by default.', 'Fallback routing: the order of replacement AIs per role.', 'Auto-recovery: re-run automatically on 429 / overloaded errors.'], terms: [] },
      scoreboard: { what: 'AIs ranked per role by review score, approval rate, cost and time, with a suggested best team.', when: ['Choosing which AI plays which role.', 'Comparing quality and cost between AIs.'], how: ['Look at “Suggested team” and press “Copy -Team” to use it when you dispatch.', 'Filter by role, period or the selected project only.'], terms: ['Role'] },
      policy: { what: 'Safety rules for the AIs: protected paths, blocked commands and commands that need approval, per role.', when: ['To stop an AI from running dangerous commands (git push --force, rm -rf…).', 'To make reviewers read-only.'], how: ['Tick “Enable policy”, pick a role (or All roles), add command / path patterns and “Save policy”.', 'Commands needing approval show up in “Waiting for approval” and in the Inbox.'], terms: ['Role'] },
      agents: { what: 'The state of every AI: installed, version, signed in, actual model; a team readiness check, Doctor and Antigravity sessions.', when: ['First-time setup.', 'A job says an AI is not installed or not signed in.'], how: ['“Readiness check” quickly tries the commands of the selected team (no tokens spent).', 'Not installed: “Copy install command” and run it in a terminal. Not signed in: “Open sign-in terminal”.', '“Run Doctor” checks everything: node, git, scripts, hooks.'], terms: ['Agent'] },
      mcp: { what: 'MCP servers (extra tools for the AIs) in the Claude, Codex and Gemini configs; add, edit or apply them to every agent.', when: ['You want every AI to share one tool (a browser, a database…).', 'You want to register this dashboard itself as an MCP server.'], how: ['“Add server” and pick the agents; changes are always previewed and the config is backed up.', '“Apply to every agent” copies one server to the other agents.'], terms: [] },
      notify: { what: 'Notifications when a job ends: Windows toasts, Discord / Slack webhooks and Telegram (optionally two-way).', when: ['Long runs you do not want to sit through.'], how: ['Turn on Windows toasts or paste a webhook URL, then “Save” and “Send test”.', 'Telegram: enter the bot token and chat ID; turn on “two-way” to approve / retry from your phone.'], terms: [] }
    }
  };
  const L = () => (UI[M.lang] ? M.lang : 'vi');
  const u = (k, v) => { let s = UI[L()][k] ?? UI.vi[k] ?? k; if (v) for (const x in v) s = s.replaceAll('{' + x + '}', v[x]); return s; };
  const icon = (d, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON_CHECK = '<path d="m5 12.5 4.5 4.5L19 7.5"/>';

  // ---------- progress of the 5 steps ----------
  const visited = k => store.get('maw_guide_' + k) === '1';
  const markVisited = k => { if (!visited(k)) store.set('maw_guide_' + k, '1'); };
  function steps() {
    const d = M.state.data || {};
    const proj = M.project();
    const agents = Object.values(M.agents() || {});
    const h = d.feature_data?.health?.summary;
    const hn = h ? (h.ok || 0) + (h.warn || 0) + (h.error || 0) : 0;
    const okAgents = hn ? (h.ok || 0) : agents.filter(a => a.installed).length;
    const nAgents = hn || agents.length;
    const jobs = (d.jobs || []).length;
    return [
      { id: 's1', done: !!proj, ok: proj ? u('s1Ok', { name: proj.name }) : '', actions: [{ label: u('s1A'), run: () => document.getElementById('projBtn')?.click(), primary: true }] },
      { id: 's2', done: okAgents > 0, ok: nAgents ? u('s2Ok', { ok: okAgents, n: nAgents }) : '', actions: [{ label: u('s2A'), page: 'agents', primary: true }] },
      { id: 's3', done: jobs > 0, ok: jobs ? u('s3Ok', { n: jobs }) : '', actions: [{ label: u('s3A'), page: 'dispatch', primary: true }] },
      { id: 's4', done: visited('review'), ok: '', actions: [{ label: u('s4A'), page: 'review', primary: true }, { label: u('s4B'), page: 'audit' }] },
      { id: 's5', done: visited('safety'), ok: '', optional: true, actions: [{ label: u('s5A'), page: 'checkpoints' }, { label: u('s5B'), page: 'budget' }, { label: u('s5C'), page: 'policy' }] }
    ];
  }

  // ---------- Get started page ----------
  let actionsById = {};
  function renderStart() {
    const root = document.getElementById('startRoot');
    if (!root || window.currentPage !== 'start') return;
    const list = steps();
    const done = list.filter(s => s.done).length;
    const firstOpen = list.find(s => !s.done)?.id;
    actionsById = {};
    const stepHtml = list.map((s, i) => {
      const acts = s.actions.map((a, j) => { const key = s.id + j; actionsById[key] = a; return `<button type="button" class="btn btn-sm${a.primary ? ' btn-primary' : ''}" data-gs-act="${key}">${esc(a.label)}</button>`; }).join('');
      const state = s.done ? `<span class="gs-badge ok">${icon(ICON_CHECK, 13)}${esc(u('gsDone'))}</span>` : `<span class="gs-badge">${esc(u(s.optional ? 'gsOptional' : 'gsTodo'))}</span>`;
      return `<li class="gs-step${s.done ? ' is-done' : ''}${s.id === firstOpen ? ' is-next' : ''}">
        <span class="gs-num" aria-hidden="true">${s.done ? icon(ICON_CHECK, 16) : i + 1}</span>
        <div class="gs-body"><div class="gs-row"><h3>${esc(u(s.id + 'T'))}</h3>${state}</div>
          <p>${esc(u(s.id + 'D'))}</p>${s.ok ? `<div class="gs-ok">${esc(s.ok)}</div>` : ''}<div class="gs-acts">${acts}</div></div></li>`;
    }).join('');
    const hubs = (typeof hubModel === 'function' ? hubModel() : []).filter(h => h.id !== 'start');
    const tour = hubs.map(h => `<button type="button" class="gs-hub" data-gs-page="${esc(h.pages[0])}">
        <span class="gs-hub-ic">${typeof navIcon === 'function' ? navIcon(h.id) : ''}</span>
        <span class="gs-hub-t">${esc(typeof hubTitle === 'function' ? hubTitle(h) : h.id)}</span>
        <span class="gs-hub-d">${esc(u('tour_' + h.id))}</span></button>`).join('');
    const terms = TERMS[L()].map(([k, v]) => `<div class="gs-term"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    const hidden = store.get('maw_start_hidden') === '1';
    root.innerHTML = `
      <div class="card gs-hero"><div class="card-b">
        <h2>${esc(u('gsHello'))}</h2><p>${esc(u('gsIntro'))}</p>
        <div class="gs-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${list.length}" aria-valuenow="${done}"><i style="width:${Math.round(done / list.length * 100)}%"></i></div>
        <div class="gs-progress-l">${esc(u('gsProgress', { n: done, total: list.length }))}</div>
        ${done >= 4 ? `<div class="callout gs-alldone">${esc(u('gsAllDone'))}</div>` : ''}
      </div></div>
      <ol class="gs-steps">${stepHtml}</ol>
      <div class="card gs-sec"><div class="card-h"><h2>${esc(u('gsTour'))}</h2></div><div class="gs-hubs">${tour}</div></div>
      <div class="card gs-sec"><div class="card-h"><h2>${esc(u('gsTerms'))}</h2></div><dl class="gs-terms">${terms}</dl></div>
      <div class="gs-foot">${hidden ? `<span class="sub">${esc(u('gsHiddenNote'))}</span>` : ''}<button type="button" class="btn btn-sm" data-gs-hide>${esc(u(hidden ? 'gsShow' : 'gsHide'))}</button></div>`;
  }
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-gs-act]');
    if (a) { const act = actionsById[a.dataset.gsAct]; if (act?.run) act.run(); else if (act?.page) goPage(act.page); return; }
    const p = e.target.closest('[data-gs-page]');
    if (p) { goPage(p.dataset.gsPage); return; }
    if (e.target.closest('[data-gs-hide]')) {
      store.set('maw_start_hidden', store.get('maw_start_hidden') === '1' ? '0' : '1');
      if (typeof renderNav === 'function') renderNav();
      renderStart();
    }
  });

  // ---------- help drawer ----------
  let drawer = null, lastFocus = null;
  function helpFor(id) { return HELP[L()][id] || HELP.vi[id] || null; }
  function openHelp(pageId) {
    const id = pageId || window.currentPage || 'start';
    closeHelp(false);
    lastFocus = document.activeElement;
    const h = helpFor(id);
    const title = typeof pageTitle === 'function' ? pageTitle(id) : id;
    const termDefs = h ? h.terms.map(name => TERMS[L()].find(([k]) => k === name)).filter(Boolean) : [];
    const list = arr => `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    drawer = document.createElement('div');
    drawer.className = 'help-layer';
    drawer.innerHTML = `<div class="help-backdrop" data-help-close></div>
      <aside class="help-drawer" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
        <div class="help-h"><div><div class="crumb">${esc(u('hTitle'))}</div><h2 id="helpTitle">${esc(title)}</h2></div>
          <button type="button" class="icon-btn" data-help-close aria-label="${esc(u('hClose'))}">${icon('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
        <div class="help-b">${h ? `
          <section><h3>${esc(u('hWhat'))}</h3><p>${esc(h.what)}</p></section>
          <section><h3>${esc(u('hWhen'))}</h3>${list(h.when)}</section>
          <section><h3>${esc(u('hHow'))}</h3><ol>${h.how.map(x => `<li>${esc(x)}</li>`).join('')}</ol></section>
          ${termDefs.length ? `<section><h3>${esc(u('hTerms'))}</h3><dl class="gs-terms compact">${termDefs.map(([k, v]) => `<div class="gs-term"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>` : ''}`
          : `<p class="sub">${esc(u('hNone'))}</p>`}</div>
        <div class="help-f"><span class="sub">${esc(u('hKey'))}</span>${id !== 'start' ? `<button type="button" class="btn btn-sm" data-help-start>${esc(u('hStart'))}</button>` : ''}</div>
      </aside>`;
    document.body.appendChild(drawer);
    document.querySelectorAll('[data-help]').forEach(b => b.setAttribute('aria-expanded', 'true'));
    requestAnimationFrame(() => drawer?.classList.add('open'));
    drawer.querySelector('.help-h [data-help-close]').focus();
  }
  function closeHelp(restore = true) {
    if (!drawer) return;
    drawer.remove(); drawer = null;
    document.querySelectorAll('[data-help]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    if (restore) lastFocus?.focus?.();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-help]');
    if (b) { drawer ? closeHelp() : openHelp(b.dataset.help || window.currentPage); return; }
    if (e.target.closest('[data-help-close]')) { closeHelp(); return; }
    if (e.target.closest('[data-help-start]')) { closeHelp(false); goPage('start'); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawer) { e.stopPropagation(); closeHelp(); return; }
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    drawer ? closeHelp() : openHelp(window.currentPage);
  });

  // ---------- wiring ----------
  // Visiting the pages of steps 4 and 5 counts as having seen them.
  const SAFETY = new Set(['checkpoints', 'budget', 'policy', 'checks', 'worktrees']);
  M.on('page', id => {
    if (id === 'review' || id === 'audit') markVisited('review');
    if (SAFETY.has(id)) markVisited('safety');
    if (drawer) openHelp(id);
    renderStart();
  });
  M.on('data', renderStart);
  M.on('lang', () => { renderStart(); if (drawer) openHelp(window.currentPage); });
  M.on('project-change', renderStart);
  M.openHelp = openHelp;
  if (window.currentPage) {
    if (window.currentPage === 'review' || window.currentPage === 'audit') markVisited('review');
    if (SAFETY.has(window.currentPage)) markVisited('safety');
  }
  renderStart();
})();
