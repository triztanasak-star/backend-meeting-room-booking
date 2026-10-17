const express = require('express');

module.exports = (context) => {
  const router = express.Router();
  const {
    db,
    authMiddleware,
    isManagerOrAdmin,
    handleServerError,
    logActivity,
  } = context;

  const mapPlan = (row) => ({
    $id: String(row.id),
    id: row.id,
    work_id: row.work_id,
    created_by: row.created_by,
    step_name: row.step_name,
    step_order: row.step_order,
    status: row.status,
    progress_percent: row.progress_percent,
    due_date: row.due_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  const canAccessWork = async (req, workId, requireModify = false) => {
    const { rows } = await db.query('SELECT * FROM "digital_works" WHERE id = $1 AND is_deleted = false', [workId]);
    if (!rows.length) return { ok: false, status: 404, message: 'Work not found' };
    
    const work = rows[0];
    
    if (requireModify) {
      // Đã ép kiểu Number() để so sánh chính xác giữa DB (Integer) và Token (String)
      const isAllowed = isManagerOrAdmin(req) || 
                        Number(work.assigned_to) === Number(req.user.id) || 
                        Number(work.support_id) === Number(req.user.id);
      if (!isAllowed) {
        return { ok: false, status: 403, message: 'Bạn không có quyền chỉnh sửa hạng mục của công việc này' };
      }
    }
    
    return { ok: true, work };
  };

  const recomputeWorkProgress = async (workId, confirmed = false) => {
    const { rows } = await db.query(
      'SELECT ROUND(AVG(progress_percent))::int AS avg_percent, COUNT(*)::int AS total FROM "task_plans" WHERE work_id = $1',
      [workId],
    );
    const lastResult = await db.query(
      'SELECT * FROM "task_plans" WHERE work_id = $1 ORDER BY step_order DESC, id DESC LIMIT 1', [workId],
    );
    const last = lastResult.rows[0];
    const complete = Boolean(last && Number(last.progress_percent) === 100 && last.due_date);
    await db.query(
      `UPDATE "digital_works" SET
         progress_percent = CASE WHEN $3 AND ($4 OR workflow_status = 'completed') THEN 100 ELSE $1 END,
         status = CASE WHEN $3 AND ($4 OR workflow_status = 'completed') THEN 2 ELSE CASE WHEN $1 > 0 THEN 1 ELSE 0 END END,
         completed_at = CASE WHEN $3 AND ($4 OR workflow_status = 'completed') THEN $5::date ELSE NULL END,
         workflow_status = CASE WHEN $3 AND ($4 OR workflow_status = 'completed') THEN 'completed'
           WHEN workflow_status = 'completed' THEN 'in_progress' ELSE workflow_status END,
         updated_at = NOW() WHERE id = $2`,
      [rows[0]?.avg_percent || 0, workId, complete, confirmed, last?.due_date || null],
    );
  };

  // List plan steps - Cho phép mọi user đã đăng nhập xem
  router.get('/api/works/:workId/plans', authMiddleware, async (req, res) => {
    try {
      const workId = Number(req.params.workId);
      const access = await canAccessWork(req, workId, false);
      if (!access.ok) return res.status(access.status).json({ message: access.message });

      const { rows } = await db.query(
        'SELECT * FROM "task_plans" WHERE work_id = $1 ORDER BY step_order ASC, id ASC',
        [workId],
      );
      return res.json({ documents: rows.map(mapPlan) });
    } catch (error) {
      return handleServerError(res, error, 'task-plans-list');
    }
  });

  // Tạo bước plan mới
  router.post('/api/works/:workId/plans', authMiddleware, async (req, res) => {
    try {
      const workId = Number(req.params.workId);
      const access = await canAccessWork(req, workId, true);
      if (!access.ok) return res.status(access.status).json({ message: access.message });

      const { step_name, step_order, due_date, progress_percent } = req.body;
      if (!step_name) return res.status(400).json({ message: 'Missing step_name' });
      if (progress_percent !== undefined && (progress_percent < 0 || progress_percent > 100)) {
        return res.status(400).json({ message: 'progress_percent must be between 0 and 100' });
      }

      const { rows } = await db.query(
        `INSERT INTO "task_plans" (work_id, created_by, step_name, step_order, due_date, progress_percent)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0))
         RETURNING *`,
        [workId, req.user.id, step_name, step_order || 0, due_date || null, progress_percent ?? null],
      );

      await recomputeWorkProgress(workId);
      await logActivity(req, 'CREATE_TASK_PLAN', rows[0].id, null, rows[0]);
      return res.status(201).json(mapPlan(rows[0]));
    } catch (error) {
      return handleServerError(res, error, 'task-plans-create');
    }
  });

  router.put('/api/plans/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await db.query('SELECT * FROM "task_plans" WHERE id = $1', [id]);
      if (!existing.rows.length) return res.status(404).json({ message: 'Plan not found' });

      const access = await canAccessWork(req, existing.rows[0].work_id, true);
      if (!access.ok) return res.status(access.status).json({ message: access.message });

      const { step_name, step_order, status, due_date, progress_percent } = req.body;
      if (status && !['pending', 'in_progress', 'done'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      if (progress_percent !== undefined && (progress_percent < 0 || progress_percent > 100)) {
        return res.status(400).json({ message: 'progress_percent must be between 0 and 100' });
      }

      const lastResult = await db.query(
        'SELECT id FROM "task_plans" WHERE work_id = $1 ORDER BY step_order DESC, id DESC LIMIT 1',
        [existing.rows[0].work_id],
      );
      const isLast = lastResult.rows[0]?.id === id;
      const nextProgress = progress_percent ?? (status === 'done' ? 100 : existing.rows[0].progress_percent);
      const nextDate = due_date || existing.rows[0].due_date;
      const completing = isLast && Number(nextProgress) === 100 && Number(existing.rows[0].progress_percent) !== 100;
      if (completing && (req.body.confirm_completion !== true || !nextDate)) {
        return res.status(400).json({ message: 'C?n ng?y ho?n th?nh v? x?c nh?n ho?n th?nh d? ?n.' });
      }

      const { rows } = await db.query(
        `UPDATE "task_plans"
         SET step_name = COALESCE($1, step_name),
             step_order = COALESCE($2, step_order),
             status = COALESCE($3, status),
             due_date = COALESCE($4, due_date),
             progress_percent = COALESCE($5, progress_percent),
             updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [step_name, step_order,
          progress_percent !== undefined ? (Number(progress_percent) === 100 ? 'done' : Number(progress_percent) > 0 ? 'in_progress' : 'pending') : status,
          due_date, status === 'done' ? 100 : progress_percent, id],
      );

      await recomputeWorkProgress(rows[0].work_id, completing && req.body.confirm_completion === true);
      await logActivity(req, 'UPDATE_TASK_PLAN', id, existing.rows[0], rows[0]);
      return res.json(mapPlan(rows[0]));
    } catch (error) {
      return handleServerError(res, error, 'task-plans-update');
    }
  });

  router.delete('/api/plans/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await db.query('SELECT * FROM "task_plans" WHERE id = $1', [id]);
      if (!existing.rows.length) return res.status(404).json({ message: 'Plan not found' });

      const access = await canAccessWork(req, existing.rows[0].work_id, true);
      if (!access.ok) return res.status(access.status).json({ message: access.message });

      await db.query('DELETE FROM "task_plans" WHERE id = $1', [id]);
      await recomputeWorkProgress(existing.rows[0].work_id);
      await logActivity(req, 'DELETE_TASK_PLAN', id, existing.rows[0], null);
      return res.json({ success: true });
    } catch (error) {
      return handleServerError(res, error, 'task-plans-delete');
    }
  });

  return router;
};