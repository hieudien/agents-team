# Agent Team – team agent phát triển phần mềm chạy local

Web chat local, mỗi agent là một lần gọi `claude` CLI (tính vào gói Claude Team), có vai trò, tên, tính cách, memory, rule, skill và lịch sử làm việc riêng.

## Chạy

```powershell
# 1. Cần Node.js 18+ và Claude Code CLI đã đăng nhập bằng tài khoản Team
claude --version
# 2. Thử giao diện không tốn quota (agent giả lập)
npm run demo
# 3. Chạy thật
npm start
```
Mở http://localhost:3939 → bấm **+** tạo dự án (tên + thư mục code) → nhắn yêu cầu.

Lần đầu agent dev/tester mở trình duyệt, `npx @playwright/mcp` sẽ tự tải. Nếu thiếu trình duyệt chạy: `npx playwright install chromium`.

## Nhắn tin & tag

- **Không tag**: cả team được góp ý. Các agent khác (Cora, Devin, Tessa) góp ý nhanh trước bằng model rẻ (`comments.model`, mặc định haiku, chỉ nói khi có ý đáng nói), sau đó Max (quản lý) xử lý chính và đọc được các góp ý đó.
- **Có tag** (`@Devin ...`, gõ `@` để hiện gợi ý): agent được tag trả lời/làm trực tiếp. Agent còn lại chỉ lên tiếng (nhãn *phản biện*) khi câu trả lời đó có vấn đề.
- Tắt góp ý/phản biện để tiết kiệm quota: `config.json` → `comments.enabled: false`.

## Ảnh & lỗi

- Dán ảnh (Ctrl+V), kéo thả, hoặc bấm 📎 để đính kèm ảnh (PNG/JPG/GIF/WEBP, tối đa 10MB). Ảnh lưu ở `data/projects/<id>/uploads/`, agent nhận đường dẫn và tự mở bằng tool Read. Ảnh được truyền tiếp theo mọi task con.
- Mọi lỗi (CLI, server, mạng, trình duyệt) hiện thành toast góc phải trên; server không còn bị crash khi một agent lỗi.

## Cuộc trò chuyện

Tab **Cuộc trò chuyện** bên cạnh **Thành viên**: mỗi dự án có nhiều cuộc trò chuyện, tên tự lấy từ tin nhắn đầu, nhấp đúp để đổi tên, chấm xanh = đang có agent làm việc. Agent vẫn nhớ ngữ cảnh theo dự án (dùng chung giữa các cuộc trò chuyện của dự án đó).

## Luồng làm việc

```
Bạn → @Max (quản lý) → @Cora (điều phối) → @Devin (dev: code + tự test)
                                        ↘ @Tessa (tester: chỉ test khi dev xong)
     ← báo cáo ← Max ← Cora ← kết quả test
```
- Quản lý & điều phối chỉ có quyền đọc (Read/Glob/Grep), không sửa code.
- Chỉ dev có Edit/Write. Tester có Bash + trình duyệt để chạy và kiểm tra.
- **Cổng checklist**: agent trả `done` mà còn mục fail / thiếu mục bắt buộc → server trả lại để làm lại (tối đa `maxGateRetries`), quá số lần thì đẩy lên cấp trên. Chưa qua checklist thì không giao bước tiếp theo.
- Cora đề xuất thêm agent khi quá tải → hiện thẻ **Tạo dev** trong chat. Cũng có nút **+ Dev / + Tester** ở sidebar.
- Chat bị cắt tối đa `chatMaxChars` ký tự và tự ẩn khối code; chi tiết task nằm trong mục "Chi tiết".

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `team/RULES.md` | Rule chung: tính cách, chỉ dựa trên dữ kiện, code chỉ tiếng Anh, không comment, checklist |
| `team/OUTPUT.md`, `output.schema.json` | Định dạng JSON mọi agent phải trả (ép bằng `--json-schema`) |
| `roles/<role>/RULES.md`, `skills/*.md` | Rule + skill dùng chung theo vai trò |
| `agents/<id>/profile.json` | Tên, chức danh, tiểu sử, tính cách, màu |
| `agents/<id>/RULES.md`, `skills/` | Rule, skill riêng của từng agent |
| `agents/<id>/MEMORY.md` | Bài học dài hạn, agent tự thêm qua `memory_add` |
| `agents/<id>/worklog.jsonl` | Lịch sử làm việc (6 mục gần nhất đưa vào prompt) |
| `agents/<id>/sessions.json` | Session CLI theo dự án → lần sau `--resume`, không quên ngữ cảnh |
| `data/projects/<id>/conversations.json` | Danh sách cuộc trò chuyện |
| `data/projects/<id>/conversations/<cid>.jsonl` | Lịch sử chat từng cuộc trò chuyện |
| `config.json` | Model/effort/tool theo vai trò, giới hạn, ngưỡng quá tải |

## Lưu trữ (ưu tiên rẻ + nhanh)

- Chat: **JSONL append-only** mỗi cuộc trò chuyện, chỉ đọc phần đuôi. Không cần DB, không tốn gì, ghi rất nhanh.
- Prompt mỗi lượt chỉ kèm 12 tin chat gần nhất + memory + 6 worklog → tiết kiệm token.
- Ngữ cảnh dài nằm trong session của Claude CLI (tự compact). Khi phiên quá dài, bấm vào agent → **Phiên mới cho dự án này**: bỏ ngữ cảnh hội thoại nhưng giữ memory + worklog.
- Khi dữ liệu lớn (hàng chục nghìn tin, cần tìm kiếm) mới cần chuyển sang SQLite.

## Tuỳ chỉnh nhanh

- Đổi model: `config.json` → `roles.dev.model` (`opus`/`sonnet`/`haiku`). Dev dùng opus sẽ tốn quota nhanh nhất.
- Thêm skill: tạo file `.md` có frontmatter `name`, `description` vào `roles/<role>/skills/` hoặc `agents/<id>/skills/`.
- Không tìm thấy `claude.exe`: điền đường dẫn vào `config.json` → `claudeBin`.

## Lưu ý an toàn

Agent dev chạy Bash không hỏi lại trong thư mục dự án. Chỉ trỏ workspace vào thư mục code riêng, nên dùng git để xem/rollback thay đổi. Rule "tester không sửa file" được ép bằng việc tắt Edit/Write, nhưng Bash vẫn có thể ghi file, nên đó là ràng buộc mềm.
