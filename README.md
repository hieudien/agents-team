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

- **Không tag**: cả team được góp ý. Các agent khác (DEV, TESTER) góp ý nhanh trước bằng model rẻ (`comments.model`, mặc định `claude-haiku-5-5`, chỉ nói khi có ý đáng nói), sau đó PM (quản lý kiêm điều phối) xử lý chính và đọc được các góp ý đó.
- **Có tag** (`@DEV ...`, gõ `@` để hiện gợi ý): agent được tag trả lời/làm trực tiếp. Tag khớp theo tên hiển thị, id (`@dev-1`) hoặc tên cũ trong `aliases` của `profile.json` (`@Devin`, `@Tessa`, `@Max`/`@Cora` → PM). Agent còn lại chỉ lên tiếng (nhãn *phản biện*) khi câu trả lời đó có vấn đề.
- Mặc định tin không tag không có góp ý (`comments.enabled: false`); tin có tag vẫn có phản biện (`comments.reviewOnTag: true`). Chỉ các vai trong `comments.reviewRoles` (mặc định `["manager","tester"]`) được gọi.

## Ảnh & lỗi

- Dán ảnh (Ctrl+V), kéo thả, hoặc bấm 📎 để đính kèm ảnh (PNG/JPG/GIF/WEBP, tối đa 10MB). Ảnh lưu ở `data/projects/<id>/uploads/`, agent nhận đường dẫn và tự mở bằng tool Read. Ảnh được truyền tiếp theo mọi task con.
- Mọi lỗi (CLI, server, mạng, trình duyệt) hiện thành toast góc phải trên; server không còn bị crash khi một agent lỗi.

## Cuộc trò chuyện

Tab **Cuộc trò chuyện** bên cạnh **Thành viên**: mỗi dự án có nhiều cuộc trò chuyện, tên tự lấy từ tin nhắn đầu, nhấp đúp để đổi tên, chấm xanh = đang có agent làm việc. Mỗi agent có phiên CLI riêng cho từng cuộc trò chuyện; kinh nghiệm dài hạn dùng chung qua `MEMORY.md` và worklog.

## Luồng làm việc

```
Bạn → @PM (quản lý + điều phối) → @DEV (dev: code + tự test) → báo PM
                                 → @TESTER (tester: chỉ test khi dev xong) → báo PM
     ← báo cáo ← PM
```
- PM chỉ có quyền đọc (Read/Glob/Grep), không sửa code. PM giao thẳng DEV và TESTER; DEV và TESTER chỉ giao/báo về PM.
- Vai điều phối (Cora, id `coordinator`) đã gộp vào PM: `agents/coordinator/profile.json` có `"retired": true`, không còn trong team/UI/prompt nhưng dữ liệu cũ vẫn giữ; task đang chờ của Cora được chuyển cho PM khi khởi động.
- Chỉ dev có Edit/Write. Tester có Bash + trình duyệt để chạy và kiểm tra.
- **Cổng checklist**: agent trả `done` mà còn mục fail / thiếu mục bắt buộc → server trả lại để làm lại (tối đa `maxGateRetries`), quá số lần thì đẩy lên cấp trên. Chưa qua checklist thì không giao bước tiếp theo.
- **Băn khoăn (`concerns`)**: dev và tester có thể khai tối đa 5 dòng ngắn về điều đã bỏ qua, chưa kiểm được hoặc tự giả định. Từ dev, server ghi vào nội dung task của tester và thêm mỗi băn khoăn thành một mục checklist bắt buộc "Concern: …" (tester phải kiểm trước, cổng checklist ép như mọi mục bắt buộc), đồng thời đưa cho lượt rà diff khi bật `comments.adversarialDiff`. Từ tester, chúng nằm trong nội dung task gửi PM để vào báo cáo cuối. Giả định tự đưa ra được ghi theo mẫu `Ruling: quyết định - vì sao - nếu sai thì mất gì` (xem `team/RULES.md`).
- PM đề xuất thêm agent khi quá tải → hiện thẻ **Tạo dev** trong chat. Cũng có nút **+ Dev / + Tester** ở sidebar.
- Chat bị cắt tối đa `chatMaxChars` ký tự và tự ẩn khối code; chi tiết task nằm trong mục "Chi tiết".

## Tiết kiệm quota

Mỗi lượt agent là một lần gọi CLI nên quota hao theo số lần gọi và kích thước prompt. Các tuỳ chọn trong `config.json`:

| Tuỳ chọn | Tác dụng |
|---|---|
| `roles.<role>.lightweight: true` | Dùng `--system-prompt-file` (prompt gọn riêng, không phải prompt mặc định của Claude Code), `--tools ""`, `--disable-slash-commands`, không MCP. Mặc định cho manager. Mọi lượt góp ý/phản biện luôn chạy kiểu này. Server đưa cây thư mục rút gọn + đầu README vào prompt; khi tin có ảnh thì chỉ mở tool `Read` cho lượt đó. Không dùng `--bare` vì nó đòi API key. |
| `roles.<role>.resume: true` | Chỉ role này resume session CLI (mặc định chỉ dev). Role khác chạy `--no-session-persistence`, chỉ dựa vào chat gần đây + memory. |
| `roles.dev.resetSessionAfterTasks` | Dev tự mở session mới sau N lượt (mặc định 8) để lịch sử không phình to. |
| `roles.<role>.browser` + `needs_browser` | Playwright MCP chỉ gắn khi role có `browser: true` **và** task có `needs_browser: true` (manager đánh dấu task có giao diện; task gọi thẳng bằng tag được đoán theo từ khoá giao diện hoặc có ảnh). |
| `roles.<role>.effort` | Mặc định: dev `medium`, manager `low`, tester `medium`; comment không đặt (Haiku 5.5 mặc định `medium`). |
| `verify` | Cổng chạy lệnh thật (`enabled`, `timeoutSeconds` mặc định 120, `outputChars` mặc định 2000). Khi dev báo done kèm bàn giao, server tự chạy lệnh kiểm tra trong workspace: lệnh do người dùng nhập khi tạo dự án (`verifyCmd`), nếu để trống thì tự dùng `npm test` khi `package.json` có script `test` thật (không phải mẫu "no test specified"). Fail hoặc quá giờ → trả lại dev kèm phần cuối output, tính vào `maxGateRetries`, quá số lần thì đẩy lên PM. Pass → tester nhận ghi chú "server đã chạy lệnh, đạt". Lệnh không bao giờ lấy từ output của agent. Chế độ `--mock` chỉ chạy khi dự án có `verifyCmd`, không tự nhận `npm test`. Không có lệnh thì bỏ qua cổng. |
| `maxBugRounds` | Số lần tester báo bug liên tiếp trên cùng một chuỗi task (mặc định 3). Báo bug lần 1 và 2 quay lại dev; lần thứ 3 không giao lại cho dev mà chuyển PM kèm toàn bộ lịch sử bug để xem lại hướng làm. PM giao việc mới thì bộ đếm về 0. |
| `bugEscalation` | Từ vòng bug `afterRound` (mặc định 2) dev chạy với `effort` cao hơn (mặc định `high`), có thể đặt thêm `model`. Chỉ áp dụng cho các task đang sửa bug, không đổi cấu hình thường. |
| `comments.enabled` | Góp ý song song cho tin không tag (mặc định tắt). |
| `comments.reviewOnTag`, `comments.reviewRoles` | Phản biện khi có tag và danh sách vai được gọi. |
| `comments.adversarialDiff` | Mặc định tắt. Bật thì khi dev xong, server lấy `git status` + `git diff` (cắt 6000 ký tự) cho một lượt tester nhẹ (không tool) liệt kê tối đa 3 rủi ro; tester thật chờ lượt này rồi kiểm các rủi ro đó trước. Bỏ qua nếu workspace không phải repo git hoặc không có thay đổi. |

Ghi chú theo dự án: dev/tester có thể trả `verify_notes` (cách chạy, cổng, lệnh test, mẹo; tối đa 10 dòng). Server lưu ở `data/projects/<id>/verify.md` (cắt 1500 ký tự) và đưa vào prompt dev/tester các lượt sau, nên không phải mò lại. Bài học lặp lại đúng 2 lần trong `memory_add` của một agent thì chat hiện nhắc cân nhắc đưa vào `agents/<id>/RULES.md` (chỉ so khớp đúng nguyên văn, đếm ở `data/lessons.json`).

Luồng rút gọn do server tự chuyển, không qua manager: dev xong → tester ít việc nhất; tester pass → manager (báo cáo cuối); tester báo bug (`verdict: "bug"` hoặc tiêu đề bắt đầu bằng `Bug`) → đúng dev đã làm task. Manager chỉ được gọi để chia việc ban đầu, xử lý blocked/escalate, kiểm kết quả cuối và đề xuất thêm agent.

Lỗi CLI được phân loại (`lib/errors.js`): hết quota (`usage_limit_reached`, "hit your limit") → không retry, tạm dừng cả hàng đợi `limitPauseMinutes` phút (mặc định 15), toast + thông báo trong chat, gửi tin mới để thử lại ngay; lỗi tạm thời (429, 5xx, quá tải, mạng, timeout) → thử lại tối đa 3 lần cách 1s/3s/8s (`retryDelaysMs`); lỗi đăng nhập → thất bại ngay; lỗi khác → thử lại 1 lần. `maxConsecutiveFailures` (mặc định 5) lỗi CLI liên tiếp trong một yêu cầu thì huỷ các task còn lại của yêu cầu đó. `settingSources` (mặc định `"project"`) không nạp cài đặt cấp người dùng (hook, plugin) vào mỗi lượt; đặt `""` để tắt. `node tests/failures.js` kiểm các tình huống này bằng mock (`MOCK_MODE=usage-limit|transient-once|error`).

Cache prompt: system prompt chỉ chứa phần ổn định (danh tính, rule, danh sách skill, output contract). Roster, memory, worklog, workload nằm ở đầu prompt người dùng; role dùng prompt mặc định bật `--exclude-dynamic-system-prompt-sections` và `--system-prompt-snapshot` để mặc định (bật).

Đo lường: mỗi lượt lưu `usage` + `total_cost_usd` vào `worklog.jsonl`, hiện mờ dưới tin nhắn agent và tổng theo agent trong hồ sơ agent. Chế độ `--mock` ghi worklog vào `data/mock/`. Kiểm thử: `node tests/args.js` (args spawn theo role), `node tests/flow.js . 3940` (đếm số lần gọi CLI trên mock).

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `team/RULES.md` | Rule chung: tính cách, chỉ dựa trên dữ kiện, code chỉ tiếng Anh, không comment, checklist |
| `team/OUTPUT.md`, `output.schema.json` | Định dạng JSON mọi agent phải trả (ép bằng `--json-schema`) |
| `roles/<role>/RULES.md`, `skills/*.md` | Rule + skill dùng chung theo vai trò |
| `agents/<id>/profile.json` | Tên, chức danh, tiểu sử, tính cách, màu |
| `agents/<id>/RULES.md`, `skills/` | Rule, skill riêng của từng agent |
| `agents/<id>/MEMORY.md` | (không đưa lên git, nằm trong `.gitignore`; tự tạo khi cần) Bài học dài hạn, agent tự thêm qua `memory_add` (tối đa 3 mỗi task, bỏ trùng, file tối đa `memoryMaxLines` = 50 dòng, đầy thì báo cần dọn; `--mock` không ghi) |
| `agents/<id>/worklog.jsonl` | Lịch sử làm việc (6 mục gần nhất đưa vào prompt) |
| `agents/<id>/sessions.json` | Session CLI theo dự án + cuộc trò chuyện → lần sau `--resume` trong cùng cuộc trò chuyện |
| `data/projects/<id>/conversations.json` | Danh sách cuộc trò chuyện |
| `data/projects/<id>/conversations/<cid>.jsonl` | Lịch sử chat từng cuộc trò chuyện |
| `config.json` | Model/effort/tool theo vai trò, giới hạn, ngưỡng quá tải |
| `lib/orchestrator.js` | Lõi: hàng đợi task, trạng thái, tin nhắn người dùng. Phần còn lại tách ở `lib/orch/`: `prompts.js` (dựng prompt), `runner.js` (chạy agent, cổng checklist, ghi worklog), `routing.js` (giao việc, rút gọn luồng), `comments.js` (góp ý, phản biện, review diff) |
| `tests/` | `npm test` chạy `args.js` (args spawn theo role), `failures.js`, `bugloop.js` (giới hạn vòng bug và nâng effort), `gate.js` (cổng chạy lệnh thật), `concerns.js` (băn khoăn dev → tester → PM), `diff-review.js`, `flow.js` (đếm số lần gọi CLI trên mock) |

## Lưu trữ (ưu tiên rẻ + nhanh)

- Chat: **JSONL append-only** mỗi cuộc trò chuyện, chỉ đọc phần đuôi. Không cần DB, không tốn gì, ghi rất nhanh.
- Prompt mỗi lượt chỉ kèm 12 tin chat gần nhất + memory + 6 worklog → tiết kiệm token.
- Ngữ cảnh dài nằm trong session của Claude CLI (tự compact). Khi phiên quá dài, bấm vào agent → **Phiên mới cho dự án này**: bỏ ngữ cảnh hội thoại của mọi cuộc trò chuyện trong dự án nhưng giữ memory + worklog.
- Khi dữ liệu lớn (hàng chục nghìn tin, cần tìm kiếm) mới cần chuyển sang SQLite.

## Tuỳ chỉnh nhanh

- Đổi model: `config.json` → `roles.<role>.model`, ghi rõ phiên bản (`claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5`) thay vì tên ngắn `sonnet`/`haiku`/`opus` để không bị đổi ngầm khi CLI cập nhật. Hiện cả ba vai dùng `claude-sonnet-5-5` và góp ý/rà diff dùng `claude-haiku-5-5`; Opus tốn quota nhất. `bugEscalation.model` có thể đặt `claude-opus-5-5` để dev chỉ lên Opus từ vòng bug thứ 2.
- Thêm skill: tạo file `.md` có frontmatter `name`, `description` vào `roles/<role>/skills/` hoặc `agents/<id>/skills/`.
- Không tìm thấy `claude.exe`: điền đường dẫn vào `config.json` → `claudeBin`.

## Lưu ý an toàn

Agent dev chạy Bash không hỏi lại trong thư mục dự án. Chỉ trỏ workspace vào thư mục code riêng, nên dùng git để xem/rollback thay đổi. Rule "tester không sửa file" được ép bằng việc tắt Edit/Write, nhưng Bash vẫn có thể ghi file, nên đó là ràng buộc mềm.
