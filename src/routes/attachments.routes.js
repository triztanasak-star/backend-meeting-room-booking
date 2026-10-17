const express = require('express');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const cloudinary = require('../config/cloudinary');

const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/tiff', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    }
    return cb(null, true);
  },
});

const uploadToCloudinary = (file) => {
  const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  
  // Ép kiểu resource_type thành 'raw' nếu là file PDF để tránh bị Cloudinary nhận diện nhầm thành image
  const resourceType = file.mimetype.startsWith('image/') ? 'image' : 'raw';

  return cloudinary.uploader.upload(dataUri, {
    folder: 'digital_work/works',
    resource_type: resourceType,
    public_id: randomUUID() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'),
    use_filename: true,
    unique_filename: true,
  });
};

module.exports = (context) => {
  const router = express.Router();
  const { db, authMiddleware, isManagerOrAdmin, handleServerError, logActivity } = context;

  const canAccessWork = async (req, workId) => {
    const { rows } = await db.query('SELECT * FROM "digital_works" WHERE id = $1 AND is_deleted = false', [workId]);
    if (!rows.length) return { ok: false, status: 404, message: 'Work not found' };
    const work = rows[0];
    const allowed = isManagerOrAdmin(req)
      || work.assigned_to === req.user.id
      || work.support_id === req.user.id
      || work.created_by === req.user.id;
    if (!allowed) return { ok: false, status: 403, message: 'No permission on this work' };
    return { ok: true, work };
  };

  const mapAttachment = (row) => ({
    $id: String(row.id),
    id: row.id,
    work_id: row.work_id,
    url: row.file_path,
    original_name: row.original_name,
    mime_type: row.mime_type,
    category: row.category,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  });

  router.get('/api/works/:workId/attachments', authMiddleware, async (req, res) => {
    try {
      const workId = Number(req.params.workId);
      const access = await canAccessWork(req, workId);
      if (!access.ok) return res.status(access.status).json({ message: access.message });

      const { rows } = await db.query(
        'SELECT * FROM "work_attachments" WHERE work_id = $1 ORDER BY id DESC',
        [workId],
      );
      return res.json({ documents: rows.map(mapAttachment) });
    } catch (error) {
      return handleServerError(res, error, 'attachments-list');
    }
  });

  router.post('/api/works/:workId/attachments', authMiddleware, (req, res, next) => {
    upload.array('files', 5)(req, res, error => {
      if (error) return res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE'
        ? 'Mỗi tệp tối đa 10 MB.' : error.message === 'UNSUPPORTED_FILE_TYPE'
        ? 'Chỉ hỗ trợ PDF, ảnh hoặc Excel (.xls/.xlsx).' : 'Chỉ chọn tối đa 5 tệp hợp lệ.' });
      next();
    });
  }, async (req, res) => {
    try {
      const workId = Number(req.params.workId);
      const access = await canAccessWork(req, workId);
      if (!access.ok) return res.status(access.status).json({ message: access.message });

      const category = typeof req.body.category === 'string' && req.body.category.trim() ? req.body.category.trim() : 'general';

      let links = [];
      try {
        links = req.body.links ? JSON.parse(req.body.links) : [];
        if (!Array.isArray(links) || links.length > 20 || !links.every(link => {
          if (typeof link !== 'string' || link.length > 500) return false;
          const url = new URL(link);
          return ['http:', 'https:'].includes(url.protocol);
        })) throw new Error('Invalid links');
      } catch {
        return res.status(400).json({ message: 'Invalid HTTP/HTTPS attachment links' });
      }
      const files = req.files || [];
      const inserted = [];
      for (const file of files) {
        const result = await uploadToCloudinary(file);

        const { rows } = await db.query(
          `INSERT INTO "work_attachments" (work_id, file_path, public_id, resource_type, format, original_name, mime_type, category, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [workId, result.secure_url, result.public_id, result.resource_type, result.format, file.originalname, file.mimetype, category, req.user.id],
        );
        inserted.push(rows[0]);
      }

      for (const link of links) {
        const { rows } = await db.query(
          `INSERT INTO "work_attachments" (work_id, file_path, original_name, mime_type, category, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [workId, link, link.slice(0, 255), 'text/uri-list', category, req.user.id],
        );
        inserted.push(rows[0]);
      }

      await logActivity(req, 'UPLOAD_WORK_ATTACHMENT', workId, null, { count: inserted.length });
      return res.status(201).json({ documents: inserted.map(mapAttachment) });
    } catch (error) {
      if (error.message === 'UNSUPPORTED_FILE_TYPE') {
        return res.status(400).json({ message: 'Chỉ hỗ trợ PDF, ảnh hoặc Excel (.xls/.xlsx)' });
      }
      return handleServerError(res, error, 'attachments-upload');
    }
  });

  router.get('/api/attachments/:id/download', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { rows } = await db.query('SELECT * FROM "work_attachments" WHERE id = $1', [id]);
      if (!rows.length) return res.status(404).json({ message: 'Attachment not found' });

      const attachment = rows[0];
      const access = await canAccessWork(req, attachment.work_id);
      if (!access.ok) return res.status(access.status).json({ message: access.message });

      const fileUrl = attachment.file_path;
      if (!fileUrl) {
        return res.status(404).json({ message: 'File not found on storage' });
      }

      if (attachment.mime_type === 'application/pdf' || /\.pdf$/i.test(attachment.original_name || '')) {
        const urls = [];
        if (attachment.public_id) {
          urls.push(cloudinary.utils.private_download_url(
            attachment.public_id, attachment.resource_type === 'raw' ? undefined : 'pdf',
            { resource_type: attachment.resource_type || 'raw', type: 'upload',
              expires_at: Math.floor(Date.now() / 1000) + 60 },
          ));
        }
        const storedUrl = new URL(fileUrl);
        if (storedUrl.protocol === 'https:' && storedUrl.hostname === 'res.cloudinary.com') urls.push(fileUrl);
        for (const url of urls) {
          try {
            const upstream = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!upstream.ok) { await upstream.body?.cancel(); continue; }
            const buffer = Buffer.from(await upstream.arrayBuffer());
            if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) continue;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', "attachment; filename=download.pdf; filename*=UTF-8''" + encodeURIComponent(attachment.original_name || 'document.pdf'));
            res.setHeader('Content-Length', buffer.length);
            return res.send(buffer);
          } catch {
            // Try the next delivery URL without returning an error page as a PDF.
          }
        }
        return res.status(502).json({ message: 'Không tải được PDF hợp lệ từ kho lưu trữ. Kiểm tra quyền phân phối PDF trên Cloudinary hoặc tải lại tệp gốc.' });
      }

      // Điều hướng thẳng trình duyệt đến link Cloudinary để tải hoặc xem trực tiếp siêu mượt
      return res.redirect(fileUrl);
    } catch (error) {
      return handleServerError(res, error, 'attachments-download');
    }
  });
  router.delete('/api/attachments/:id', authMiddleware, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { rows } = await db.query('SELECT * FROM "work_attachments" WHERE id = $1', [id]);
      if (!rows.length) return res.status(404).json({ message: 'Attachment not found' });

      const attachment = rows[0];
      if (!isManagerOrAdmin(req) && attachment.uploaded_by !== req.user.id) {
        return res.status(403).json({ message: 'No permission to delete this attachment' });
      }

      await db.query('DELETE FROM "work_attachments" WHERE id = $1', [id]);
      if (attachment.public_id) {
        cloudinary.uploader
          .destroy(attachment.public_id, { resource_type: attachment.resource_type || 'image' })
          .catch((error) => console.error('[attachments-cloudinary-destroy]', error));
      }

      await logActivity(req, 'DELETE_WORK_ATTACHMENT', id, attachment, null);
      return res.json({ success: true });
    } catch (error) {
      return handleServerError(res, error, 'attachments-delete');
    }
  });

  return router;
};