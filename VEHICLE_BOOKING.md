# Đặt xe nhà máy

Áp dụng schema mới trước khi khởi động backend:

```powershell
cd backend
npm run migrate
npm start
```

Nếu ứng dụng phòng họp đã có database, có thể chỉ cài module xe bằng `npm run migrate:vehicles` trong thư mục `backend`.

Mở `/vehicles` hoặc menu **Đặt xe nhà máy**.

1. Admin vào **Danh mục xe**, thêm mỗi xe thực tế với tên và biển số. Tổng số xe khả dụng là số xe đang hoạt động.
2. Admin thêm **Tài xế** và chọn tài khoản trong **Người duyệt**. Admin luôn có quyền duyệt.
3. Người dùng chọn ngày, xem tổng xe/còn trống, nhập số lượng xe, điểm đến, mục đích và điện thoại.
4. Người duyệt chọn ngày để xem mọi yêu cầu, phân đủ xe và tài xế rồi duyệt; hoặc từ chối kèm lý do.

Mỗi yêu cầu chiếm xe trọn một ngày. Chờ duyệt và đã duyệt đều giữ số lượng xe; từ chối/hủy trả lại chỗ. Xe hoặc tài xế không được phân vào hai yêu cầu đã duyệt cùng ngày. Khi thiếu tài xế, yêu cầu vẫn được giữ chỗ xe nhưng chưa thể duyệt cho đến khi phân đủ tài xế.

Người dùng chỉ xem chi tiết yêu cầu của mình; lịch ngày cung cấp số lượng còn trống, không tiết lộ chuyến đi của người khác. Người duyệt xem toàn bộ yêu cầu và danh mục phục vụ phân công. Chỉ admin sửa danh mục hoặc phân quyền. Ngừng xe bị chặn nếu làm thiếu số xe cho các yêu cầu tương lai; xe/tài xế đã phân công phải được hủy lịch trước khi ngừng hoạt động.

API dùng PostgreSQL transaction và advisory lock chung để tuần tự hóa thay đổi số lượng/phân công giữa các tiến trình backend. Kiểm thử `npm test` gồm kiểm thử route với DB mô phỏng; chưa thay thế kiểm thử đồng thời trên PostgreSQL thực tế.
