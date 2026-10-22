const express = require('express');

module.exports = (context) => {
  const router = express.Router();
  const {
    db,
    notificationService,
    authMiddleware,
    requireManagerOrAdmin,
    isManagerOrAdmin,
    handleServerError,
    parsePagination,
    logActivity,
  } = context;

  const mapWork = (row) => ({
    $id: String(row.id),
    id: row.id,
    task_name: row.task_name,
    description: row.description,
    factory_name: row.factory_name,
    status: row.status,
    workflow_status: row.workflow_status,
    rejection_reason: row.rejection_reason,
    priority: row.priority,
    progress_percent: row.progress_percent,
    expected_deadline: row.expected_deadline,
    desired_deadline: row.desired_deadline,
    completed_at: row.completed_at,
    lead_project: row.lead_project,
    assistant: row.assistant,
    representative_name: row.representative_name,
    representative_email: row.representative_email,
    representative_phone: row.representative_phone,
    project_id: row.project_id,
    assigned_to: row.assigned_to,
    assigned_to_name: row.assigned_to_name ?? null,
    pic_users: row.pic_users ?? [],
    support_id: row.support_id,
    support_name: row.support_name ?? null,
    created_by: row.created_by,
    capex_amount: row.capex_amount !== null && row.capex_amount !== undefined ? Number(row.capex_amount) : null,
    estimated_saving_per_year: row.estimated_saving_per_year !== null && row.estimated_saving_per_year !== undefined
      ? Number(row.estimated_saving_per_year) : null,
    saving_is_estimated: row.saving_is_estimated ?? (row.workflow_status !== 'completed'),
    payback_years: row.payback_years !== null && row.payback_years !== undefined ? Number(row.payback_years) : null,
    manager_comment: row.manager_comment,
    progress_comment: row.progress_comment,
    support_request: row.support_request,
    has_feedback: row.has_feedback,
    feedback_comment: row.feedback_comment,
    rating: row.rating,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  const worksQueryBase = `
    SELECT dw.*, leader.name AS assigned_to_name, support.name AS support_name,
      COALESCE((
        SELECT json_agg(json_build_object('id', pic.id, 'name', pic.name, 'email', pic.email, 'avatar_url', pic.avatar_url) ORDER BY pic.id)
        FROM "users" pic
        WHERE EXISTS (
          SELECT 1
          FROM unnest(string_to_array(COALESCE(NULLIF(BTRIM(dw.lead_project), ''), leader.name, ''), ',')) AS names(value)
          WHERE LOWER(BTRIM(names.value)) = LOWER(BTRIM(pic.name))
             OR LOWER(BTRIM(names.value)) = LOWER(BTRIM(pic.email))
        )
      ), '[]'::json) AS pic_users
    FROM "digital_works" dw
    LEFT JOIN "users" leader ON leader.id = dw.assigned_to
    LEFT JOIN "users" support ON support.id = dw.support_id
  `;

  // Kiểm tra quyền: Admin/Manager HOẶC PIC (assigned_to) HOẶC Support (support_id)
  const canModifyWork = (req, work) => {
    const userId = Number(req.user.id);
    return isManagerOrAdmin(req) ||
      (work.assigned_to !== null && Number(work.assigned_to) === userId) ||
      (work.support_id !== null && Number(work.support_id) === userId);
  };

  // ✅ HÀM MỚI: Tự động convert tên → ID
  const resolveUserId = async (idOrName, fallbackName) => {
    // Nếu đã là số hợp lệ → dùng luôn
    if (idOrName !== undefined && idOrName !== null && idOrName !== '') {
      const num = Number(idOrName);
      if (!isNaN(num) && num > 0) return num;
    }
    // Nếu là tên → lookup ID
    const searchValue = idOrName || fallbackName;
    if (!searchValue || typeof searchValue !== 'string') return null;

    try {
      const { rows } = await db.query(
        'SELECT id FROM "users" WHERE name = $1 OR email = $1 LIMIT 1',
        [searchValue.trim()]
      );
      if (rows.length) {
        console.log(`[AUTO-CONVERT] "${searchValue}" → user_id=${rows[0].id}`);
        return rows[0].id;
      }
    } catch (err) {
      console.error('[AUTO-CONVERT] Lỗi lookup:', err);
    }
    return null;
  };

  // List - Tất cả các role đều lấy toàn bộ danh sách dùng chung
  router.get('/api/works', authMiddleware, async (req, res) => {
    try {
      const { page, limit, offset } = parsePagination(req);
      const filters = ['dw.is_deleted = false'];
      const params = [];

      if (req.query.assigned_to) {
        params.push(Number(req.query.assigned_to));
        filters.push(`dw.assigned_to = $${params.length}`);
      }

      if (req.query.project_id) {
        params.push(Number(req.query.project_id));
        filters.push(`dw.project_id = $${params.length}`);
      }
      if (req.query.status !== undefined && req.query.status !== '') {
        params.push(Number(req.query.status));
        filters.push(`dw.status = $${params.length}`);
      }

      const whereClause = `WHERE ${filters.join(' AND ')}`;
      const countQuery = `SELECT COUNT(*)::int AS total FROM "digital_works" dw ${whereClause}`;
      const rowsQuery = `${worksQueryBase} ${whereClause}
        ORDER BY dw.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

      const [countResult, rowsResult] = await Promise.all([
        db.query(countQuery, params),
        db.query(rowsQuery, [...params, limit, offset]),
      ]);

      return res.json({
        documents: rowsResult.rows.map(mapWork),
        total: countResult.rows[0].total,
        page,
        limit,
      });
    } catch (error) {
      return handleServerError(res, error, 'works-list');
    }
  });

  router.get('/api/works/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { rows } = await db.query(`${worksQueryBase} WHERE dw.id = $1 AND dw.is_deleted = false`, [id]);
      if (!rows.length) return res.status(404).json({ message: 'Work not found' });

      return res.json(mapWork(rows[0]));
    } catch (error) {
      return handleServerError(res, error, 'works-get');
    }
  });

  // Tạo công việc mới - ✅ CÓ AUTO-CONVERT
  router.post('/api/works', authMiddleware, async (req, res) => {
    try {
      const {
        task_name, description, factory_name, expected_deadline, desired_deadline, priority,
        project_id, lead_project, assistant,
        representative_name, representative_email, representative_phone,
      } = req.body;

      const isReviewer = isManagerOrAdmin(req);

      if (!task_name) return res.status(400).json({ message: 'Missing task_name' });
      if (priority && !['high', 'medium', 'low'].includes(priority)) {
        return res.status(400).json({ message: 'Invalid priority' });
      }

      // ✅ AUTO-CONVERT: chấp nhận cả ID và tên
      let nextProjectID = isReviewer ? (project_id || null) : null;
      let nextAssignedTo = null;
      let nextSupportId = null;

      if (isReviewer) {
        nextAssignedTo = await resolveUserId(req.body.assigned_to, lead_project);
        nextSupportId = await resolveUserId(req.body.support_id, assistant);
      }

      console.log('[POST /api/works] Input:', {
        assigned_to: req.body.assigned_to,
        lead_project,
        support_id: req.body.support_id,
        assistant,
      });
      console.log('[POST /api/works] Resolved:', {
        assigned_to: nextAssignedTo,
        support_id: nextSupportId,
      });

      const { rows } = await db.query(
        `INSERT INTO "digital_works"
           (task_name, description, factory_name, project_id, assigned_to, support_id, created_by,
            expected_deadline, desired_deadline, priority, lead_project, assistant,
            representative_name, representative_email, representative_phone, workflow_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'medium'), $11, $12, $13, $14, $15, 'requested')
         RETURNING *`,
        [
          task_name, description || null, factory_name || null,
          nextProjectID, nextAssignedTo, nextSupportId, req.user.id,
          expected_deadline || null, desired_deadline || null, priority || null,
          lead_project || null, assistant || null,
          representative_name || null, representative_email || null, representative_phone || null,
        ],
      );

      await logActivity(req, 'CREATE_WORK', rows[0].id, null, rows[0]);

      // ✅ Thông báo Manager (Teams + mail) khi có dự án mới ở trạng thái "Yêu cầu"
      try {
        await notificationService.notifyWorkCreated(rows[0]);
      } catch (notifyError) {
        console.error('[works-create-notify]', notifyError);
      }

      return res.status(201).json(mapWork(rows[0]));
    } catch (error) {
      if (db.isForeignKeyViolation(error)) {
        return res.status(409).json({ message: 'project_id, assigned_to hoặc support_id không hợp lệ' });
      }
      return handleServerError(res, error, 'works-create');
    }
  });

  // Sửa thông tin task - ✅ CÓ AUTO-CONVERT
  router.put('/api/works/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      
      const existing = await db.query('SELECT * FROM "digital_works" WHERE id = $1 AND is_deleted = false', [id]);
      if (!existing.rows.length) return res.status(404).json({ message: 'Work not found' });

      const work = existing.rows[0];
      if (!canModifyWork(req, work)) {
        return res.status(403).json({ message: 'Bạn không có quyền chỉnh sửa công việc này' });
      }

      const {
        task_name, description, factory_name, project_id,
        lead_project, assistant,
        representative_name, representative_email, representative_phone,
        expected_deadline, desired_deadline, priority,
        capex_amount, estimated_saving_per_year, payback_years,
        workflow_status,
      } = req.body;

      if (priority && !['high', 'medium', 'low'].includes(priority)) {
        return res.status(400).json({ message: 'Invalid priority' });
      }

      const VALID_WORKFLOW_STATUSES = ['requested', 'approved', 'in_progress', 'completed'];
      if (workflow_status && !VALID_WORKFLOW_STATUSES.includes(workflow_status)) {
        return res.status(400).json({ message: 'Invalid workflow_status' });
      }

      const isReviewer = isManagerOrAdmin(req);

      // ✅ AUTO-CONVERT: chấp nhận cả ID và tên
      let nextAssignedTo = work.assigned_to;
      let nextSupportId = work.support_id;

      if (isReviewer) {
        if (req.body.assigned_to !== undefined || lead_project !== undefined) {
          nextAssignedTo = await resolveUserId(req.body.assigned_to, lead_project);
        }
        if (req.body.support_id !== undefined || assistant !== undefined) {
          nextSupportId = await resolveUserId(req.body.support_id, assistant);
        }
      }

      const nextProjectID = isReviewer
        ? (project_id !== undefined ? project_id : work.project_id)
        : work.project_id;

      console.log('[PUT /api/works] Input:', {
        assigned_to: req.body.assigned_to,
        lead_project,
        support_id: req.body.support_id,
        assistant,
      });
      console.log('[PUT /api/works] Resolved:', {
        assigned_to: nextAssignedTo,
        support_id: nextSupportId,
      });

      const { rows } = await db.query(
        `UPDATE "digital_works"
         SET task_name = COALESCE($1, task_name),
             description = COALESCE($2, description),
             factory_name = COALESCE($3, factory_name),
             project_id = $4,
             assigned_to = $5,
             support_id = $6,
             lead_project = COALESCE($7, lead_project),
             assistant = COALESCE($8, assistant),
             representative_name = COALESCE($9, representative_name),
             representative_email = COALESCE($10, representative_email),
             representative_phone = COALESCE($11, representative_phone),
             expected_deadline = COALESCE($12, expected_deadline),
             desired_deadline = COALESCE($13, desired_deadline),
             priority = COALESCE($14, priority),
             capex_amount = COALESCE($15, capex_amount),
             estimated_saving_per_year = COALESCE($16, estimated_saving_per_year),
             payback_years = COALESCE($17, payback_years),
             workflow_status = COALESCE($18, workflow_status),
             rejection_reason = CASE WHEN $18 = 'approved' THEN NULL ELSE rejection_reason END,
             updated_at = NOW()
         WHERE id = $19
         RETURNING *`,
        [
          task_name, description, factory_name, nextProjectID, nextAssignedTo, nextSupportId,
          lead_project, assistant,
          representative_name, representative_email, representative_phone,
          expected_deadline, desired_deadline, priority,
          capex_amount, estimated_saving_per_year, payback_years, workflow_status || null, id
        ],
      );

      await logActivity(req, 'UPDATE_WORK', id, work, rows[0]);

      // ✅ Thông báo PIC/Support (Teams + mail) khi dự án vừa chuyển sang "Đã duyệt"
      const justApproved = work.workflow_status !== 'approved' && rows[0].workflow_status === 'approved';
      if (justApproved) {
        try {
          const recipientIds = [rows[0].assigned_to, rows[0].support_id].filter(
            (v) => v !== null && v !== undefined,
          );
          let recipientEmails = [];
          if (recipientIds.length > 0) {
            const { rows: userRows } = await db.query(
              'SELECT email FROM "users" WHERE id = ANY($1::int[])',
              [recipientIds],
            );
            recipientEmails = userRows.map((u) => u.email).filter(Boolean);
          }
          await notificationService.notifyWorkApproved(rows[0], recipientEmails);
        } catch (notifyError) {
          console.error('[works-approve-notify]', notifyError);
        }
      }

      return res.json(mapWork(rows[0]));
    } catch (error) {
      if (db.isForeignKeyViolation(error)) {
        return res.status(409).json({ message: 'project_id, assigned_to hoặc support_id không hợp lệ' });
      }
      return handleServerError(res, error, 'works-update');
    }
  });

  router.post('/api/works/:id/reject', authMiddleware, requireManagerOrAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason || reason.length > 2000) return res.status(400).json({ message: 'Vui lòng nhập lý do không duyệt (tối đa 2000 ký tự).' });
      const existing = await db.query('SELECT * FROM "digital_works" WHERE id = $1 AND is_deleted = false', [id]);
      if (!existing.rows.length) return res.status(404).json({ message: 'Work not found' });
      if (['in_progress', 'completed'].includes(existing.rows[0].workflow_status)) {
        return res.status(409).json({ message: 'Không thể từ chối dự án đang thực hiện hoặc đã hoàn thành.' });
      }
      const { rows } = await db.query(
        `UPDATE "digital_works" SET workflow_status = 'rejected', rejection_reason = $1, updated_at = NOW()
         WHERE id = $2 AND is_deleted = false AND workflow_status NOT IN ('in_progress', 'completed') RETURNING *`,
        [reason, id],
      );
      if (!rows.length) return res.status(409).json({ message: 'Trạng thái dự án đã thay đổi. Vui lòng tải lại.' });
      await logActivity(req, 'REJECT_WORK', id, existing.rows[0], rows[0]);
      let notificationSent = false;
      try {
        const result = await notificationService.notifyWorkRejected(rows[0]);
        notificationSent = result?.ok === true;
      } catch (error) { console.error('[works-reject-notify]', error); }
      return res.json({ ...mapWork(rows[0]), notification_sent: notificationSent });
    } catch (error) { return handleServerError(res, error, 'works-reject'); }
  });

  // Cập nhật tiến độ
  router.patch('/api/works/:id/progress', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await db.query('SELECT * FROM "digital_works" WHERE id = $1 AND is_deleted = false', [id]);
      if (!existing.rows.length) return res.status(404).json({ message: 'Work not found' });

      const work = existing.rows[0];
      if (!canModifyWork(req, work)) {
        return res.status(403).json({ message: 'Bạn không có quyền cập nhật tiến độ công việc này' });
      }

      const {
        status, progress_percent, progress_comment,
        manager_comment, rating, has_feedback, feedback_comment,
        capex_amount, estimated_saving_per_year, payback_years,
        support_request, workflow_status, saving_is_estimated,
      } = req.body;

      if (saving_is_estimated !== undefined && typeof saving_is_estimated !== 'boolean') {
        return res.status(400).json({ message: 'saving_is_estimated must be a boolean' });
      }

      if (progress_percent !== undefined && (progress_percent < 0 || progress_percent > 100)) {
        return res.status(400).json({ message: 'progress_percent phải từ 0 đến 100' });
      }
      if (rating !== undefined && rating !== null && (rating < 1 || rating > 5)) {
        return res.status(400).json({ message: 'rating phải từ 1 đến 5' });
      }

      const VALID_WORKFLOW_STATUSES = ['requested', 'approved', 'in_progress', 'completed'];
      if (workflow_status && !VALID_WORKFLOW_STATUSES.includes(workflow_status)) {
        return res.status(400).json({ message: 'Invalid workflow_status' });
      }

      const isReviewer = isManagerOrAdmin(req);
      const nextManagerComment = isReviewer ? manager_comment : work.manager_comment;
      const nextRating = isReviewer ? rating : work.rating;
      const nextHasFeedback = isReviewer ? has_feedback : work.has_feedback;
      const nextFeedbackComment = isReviewer ? feedback_comment : work.feedback_comment;

      const completedAt = work.completed_at;

      // ✅ Tiến độ đạt 100% thì luôn tự động chuyển trạng thái quy trình sang "Hoàn thành"
      const nextWorkflowStatus = work.completed_at ? 'completed' : (workflow_status === 'completed' ? work.workflow_status : (workflow_status || work.workflow_status));

      const { rows } = await db.query(
        `UPDATE "digital_works"
         SET status = COALESCE($1, status),
             progress_percent = COALESCE($2, progress_percent),
             progress_comment = COALESCE($3, progress_comment),
             manager_comment = $4,
             rating = $5,
             has_feedback = $6,
             feedback_comment = $7,
             capex_amount = COALESCE($8, capex_amount),
             estimated_saving_per_year = COALESCE($9, estimated_saving_per_year),
             payback_years = COALESCE($10, payback_years),
             support_request = COALESCE($11, support_request),
             workflow_status = $12,
             completed_at = $13,
             saving_is_estimated = COALESCE($15, saving_is_estimated),
             updated_at = NOW()
         WHERE id = $14
         RETURNING *`,
        [
          completedAt ? 2 : status, completedAt ? 100 : progress_percent, progress_comment, nextManagerComment, nextRating,
          nextHasFeedback, nextFeedbackComment,
          capex_amount, estimated_saving_per_year, payback_years,
          support_request, nextWorkflowStatus, completedAt, id, saving_is_estimated
        ],
      );

      await logActivity(req, 'UPDATE_WORK_PROGRESS', id, work, rows[0]);

      // ✅ Thông báo nhóm Teams + mail Manager khi chuyển sang "Thực hiện" (Chấp nhận) hoặc "Hoàn thành" (100%)
      const prevWorkflowStatus = work.workflow_status;
      const newWorkflowStatus = rows[0].workflow_status;
      if (prevWorkflowStatus !== newWorkflowStatus) {
        try {
          if (newWorkflowStatus === 'in_progress') {
            await notificationService.notifyWorkInProgress(rows[0]);
          } else if (newWorkflowStatus === 'completed') {
            await notificationService.notifyWorkCompleted(rows[0]);
          }
        } catch (notifyError) {
          console.error('[works-progress-notify]', notifyError);
        }
      }

      return res.json(mapWork(rows[0]));
    } catch (error) {
      return handleServerError(res, error, 'works-progress-update');
    }
  });

  // Xóa (soft delete) - Chỉ Admin/Manager
  router.delete('/api/works/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await db.query('SELECT * FROM "digital_works" WHERE id = $1 AND is_deleted = false', [id]);
      if (!existing.rows.length) return res.status(404).json({ message: 'Work not found' });

      if (!isManagerOrAdmin(req)) {
        return res.status(403).json({ message: 'Bạn không có quyền xóa công việc này' });
      }

      const { rows } = await db.query(
        'UPDATE "digital_works" SET is_deleted = true, updated_at = NOW() WHERE id = $1 RETURNING *',
        [id],
      );

      await logActivity(req, 'DELETE_WORK', id, existing.rows[0], rows[0]);
      return res.json({ success: true });
    } catch (error) {
      return handleServerError(res, error, 'works-delete');
    }
  });

  return router;
};
