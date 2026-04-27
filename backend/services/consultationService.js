const pool = require('../config/db');
const billingService = require('./billingService');
const notificationService = require('./notificationService');

const DEFAULT_CONSULTATION_PHP = 499;
const DEFAULT_PLATFORM_FEE_PERCENT = 10;
const SPECIALIST_PAYOUT_INTERVAL_DAYS = 14;
const GLOBAL_MAX_ACTIVE_CONSULTATIONS = (() => {
  const n = Number.parseInt(process.env.MAX_ACTIVE_CONSULTATIONS || '3', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();
const PLATFORM_FEE_PERCENT = (() => {
  const n = Number.parseFloat(
    process.env.PLATFORM_CONSULTATION_FEE_PERCENT || String(DEFAULT_PLATFORM_FEE_PERCENT)
  );
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_PLATFORM_FEE_PERCENT;
})();
const OFFLINE_CHATBOT_ENABLED =
  String(process.env.ENABLE_OFFLINE_CHATBOT || 'true').trim().toLowerCase() === 'true';
const OFFLINE_SPECIALIST_MINUTES = (() => {
  const n = Number(process.env.OFFLINE_SPECIALIST_MINUTES || 15);
  return Number.isFinite(n) && n > 0 ? n : 15;
})();
const OFFLINE_CHATBOT_COOLDOWN_MINUTES = (() => {
  const n = Number(process.env.OFFLINE_CHATBOT_COOLDOWN_MINUTES || 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();
const SPECIALIST_ONLINE_WINDOW_SECONDS = (() => {
  const n = Number(process.env.SPECIALIST_ONLINE_WINDOW_SECONDS || 90);
  return Number.isFinite(n) && n > 10 ? n : 90;
})();

function isModerator(actor) {
  return actor.roleName === 'admin' || actor.roleName === 'seller';
}

function isAssignedSpecialist(actor, specialistUserId) {
  return actor.roleName === 'specialist' && specialistUserId === actor.userId;
}

function canManageConsultation(actor, row) {
  if (isModerator(actor)) return true;
  return isAssignedSpecialist(actor, row.specialist_user_id);
}

function isDemoPaymentEnabled() {
  const mode = String(process.env.PAYMENT_MODE || '').trim().toLowerCase();
  if (mode === 'demo') return true;
  if (String(process.env.ENABLE_DEMO_PAYMENTS || '').trim().toLowerCase() === 'true') return true;
  return String(process.env.NODE_ENV || 'development').trim().toLowerCase() !== 'production';
}

/** MySQL TIME can surface from mysql2 as a string, Date, or other — normalize for JSON + UI. */
function normalizePreferredTimeForApi(v) {
  if (v == null || v === '') return null;
  if (Buffer.isBuffer(v)) {
    const s = v.toString('utf8').trim();
    if (!s) return null;
    return normalizePreferredTimeForApi(s);
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return (
      String(v.getHours()).padStart(2, '0') +
      `:${String(v.getMinutes()).padStart(2, '0')}` +
      `:${String(v.getSeconds()).padStart(2, '0')}`
    );
  }
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/(\.\d+)$/, '');
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    return (
      m[1].padStart(2, '0') +
      `:${m[2].padStart(2, '0')}` +
      `:${(m[3] != null ? m[3] : '0').padStart(2, '0')}`
    );
  }
  if (s.length >= 19 && s.includes('T')) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return (
        String(d.getHours()).padStart(2, '0') +
        `:${String(d.getMinutes()).padStart(2, '0')}` +
        `:${String(d.getSeconds()).padStart(2, '0')}`
      );
    }
  }
  return null;
}

const STATUS_FLOW = Object.freeze({
  pending: new Set(['awaiting_payment', 'declined', 'cancelled']),
  awaiting_payment: new Set(['scheduled', 'cancelled']),
  scheduled: new Set(['in_progress', 'completed', 'cancelled']),
  in_progress: new Set(['completed', 'cancelled']),
  completed: new Set([]),
  cancelled: new Set([]),
  declined: new Set([]),
});

function normalizeStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'accepted' || s === 'paid') return 'scheduled';
  return s;
}

function assertStatusTransition(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (from === to) return to;
  const allowed = STATUS_FLOW[from];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`Invalid status transition: ${from} -> ${to}`);
  }
  return to;
}

class ConsultationService {
  constructor() {
    this.tableReady = false;
    this.extendedReady = false;
  }

  async ensureTable() {
    if (this.tableReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultations (
        consultation_id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        specialist_user_id INT NULL,
        concern_title VARCHAR(150) NOT NULL,
        concern_message TEXT NOT NULL,
        preferred_date DATE NULL,
        preferred_time TIME NULL,
        status ENUM('pending', 'accepted', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
        specialist_notes TEXT NULL,
        validated_products_text TEXT NULL,
        final_recommendation TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_consult_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        CONSTRAINT fk_consult_specialist FOREIGN KEY (specialist_user_id) REFERENCES users(user_id) ON DELETE SET NULL
      )
    `);
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS consultation_messages (
          message_id INT PRIMARY KEY AUTO_INCREMENT,
          consultation_id INT NOT NULL,
          sender_user_id INT NOT NULL,
          sender_role ENUM('user', 'specialist') NOT NULL,
          message_text TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_consult_msg_consult FOREIGN KEY (consultation_id) REFERENCES consultations(consultation_id) ON DELETE CASCADE,
          CONSTRAINT fk_consult_msg_sender FOREIGN KEY (sender_user_id) REFERENCES users(user_id) ON DELETE CASCADE
        )
      `);
    } catch (_err) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS consultation_messages (
          message_id INT PRIMARY KEY AUTO_INCREMENT,
          consultation_id INT NOT NULL,
          sender_user_id INT NOT NULL,
          sender_role VARCHAR(20) NOT NULL,
          message_text TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    try {
      await pool.query(
        'ALTER TABLE consultation_messages ADD COLUMN image_path VARCHAR(512) NULL AFTER message_text'
      );
    } catch (_e) {
      /* column exists */
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultation_feedback (
        feedback_id INT PRIMARY KEY AUTO_INCREMENT,
        consultation_id INT NOT NULL,
        user_id INT NOT NULL,
        specialist_user_id INT NOT NULL,
        rating TINYINT NOT NULL,
        feedback_text TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_feedback_consult_user (consultation_id, user_id),
        INDEX idx_feedback_specialist (specialist_user_id),
        CONSTRAINT fk_feedback_consult FOREIGN KEY (consultation_id) REFERENCES consultations(consultation_id) ON DELETE CASCADE,
        CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        CONSTRAINT fk_feedback_specialist FOREIGN KEY (specialist_user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consultation_ai_handoffs (
        handoff_id INT PRIMARY KEY AUTO_INCREMENT,
        consultation_id INT NOT NULL,
        user_id INT NOT NULL,
        specialist_user_id INT NOT NULL,
        trigger_message_id INT NULL,
        summary_text TEXT NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_handoff_consult_created (consultation_id, created_at),
        INDEX idx_handoff_specialist_status (specialist_user_id, status),
        CONSTRAINT fk_handoff_consult FOREIGN KEY (consultation_id) REFERENCES consultations(consultation_id) ON DELETE CASCADE,
        CONSTRAINT fk_handoff_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        CONSTRAINT fk_handoff_specialist FOREIGN KEY (specialist_user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS specialist_presence (
        specialist_user_id INT PRIMARY KEY,
        last_seen_at DATETIME NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_specialist_presence_user FOREIGN KEY (specialist_user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);
    await this.ensureExtendedColumns();
    await this.ensureRevenueSchema();
    this.tableReady = true;
  }

  async ensureExtendedColumns() {
    if (this.extendedReady) return;
    const tryAlter = async (sql) => {
      try {
        await pool.query(sql);
      } catch (_e) {
        /* column exists or already migrated */
      }
    };
    await tryAlter("ALTER TABLE consultations MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'pending'");
    await tryAlter('ALTER TABLE consultations ADD COLUMN amount_php DECIMAL(10,2) NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN platform_fee_percent DECIMAL(5,2) NULL');
    await tryAlter(
      "ALTER TABLE consultations ADD COLUMN payment_status VARCHAR(24) NOT NULL DEFAULT 'unpaid'"
    );
    await tryAlter('ALTER TABLE consultations ADD COLUMN payment_reference VARCHAR(128) NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN payment_receipt_path VARCHAR(512) NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN payment_submitted_at TIMESTAMP NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN preferred_time TIME NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN meeting_url VARCHAR(512) NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN decline_reason TEXT NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN paid_verified_at TIMESTAMP NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN scheduled_at DATETIME NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN completed_at DATETIME NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN verified_by_admin_user_id INT NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN paymongo_checkout_session_id VARCHAR(128) NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN paymongo_payment_intent_id VARCHAR(128) NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN prescription_summary TEXT NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN prescription_products_text TEXT NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN prescription_plan_text TEXT NULL');
    await tryAlter('ALTER TABLE consultations ADD COLUMN prescription_issued_at DATETIME NULL');
    await tryAlter('ALTER TABLE consultation_messages MODIFY COLUMN sender_role VARCHAR(20) NOT NULL');
    try {
      await pool.query(`UPDATE consultations SET status = 'awaiting_payment' WHERE status = 'accepted'`);
    } catch (_e) {
      /* ignore */
    }
    try {
      await pool.query(`UPDATE consultations SET status = 'scheduled' WHERE status = 'paid'`);
    } catch (_e) {
      /* ignore */
    }
    this.extendedReady = true;
  }

  async ensureRevenueSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS specialist_earnings_ledger (
        earning_id INT PRIMARY KEY AUTO_INCREMENT,
        consultation_id INT NOT NULL,
        specialist_user_id INT NOT NULL,
        gross_amount_php DECIMAL(10,2) NOT NULL,
        commission_percent DECIMAL(5,2) NOT NULL,
        commission_amount_php DECIMAL(10,2) NOT NULL,
        net_amount_php DECIMAL(10,2) NOT NULL,
        status ENUM('released','in_payout','paid_out') NOT NULL DEFAULT 'released',
        released_at DATETIME NOT NULL,
        payout_request_id INT NULL,
        payout_paid_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_earnings_consult (consultation_id),
        INDEX idx_earnings_specialist_status (specialist_user_id, status, released_at),
        CONSTRAINT fk_earnings_consult FOREIGN KEY (consultation_id) REFERENCES consultations(consultation_id) ON DELETE CASCADE,
        CONSTRAINT fk_earnings_specialist FOREIGN KEY (specialist_user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS specialist_payout_requests (
        payout_request_id INT PRIMARY KEY AUTO_INCREMENT,
        specialist_user_id INT NOT NULL,
        period_start DATETIME NOT NULL,
        period_end DATETIME NOT NULL,
        gross_amount_php DECIMAL(10,2) NOT NULL,
        commission_amount_php DECIMAL(10,2) NOT NULL,
        net_amount_php DECIMAL(10,2) NOT NULL,
        item_count INT NOT NULL DEFAULT 0,
        status ENUM('requested','approved','paid','rejected') NOT NULL DEFAULT 'requested',
        requested_at DATETIME NOT NULL,
        processed_at DATETIME NULL,
        processed_by_user_id INT NULL,
        admin_note TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_payout_specialist_requested (specialist_user_id, requested_at),
        CONSTRAINT fk_payout_specialist FOREIGN KEY (specialist_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        CONSTRAINT fk_payout_processor FOREIGN KEY (processed_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL
      )
    `);
    try {
      await pool.query(`
        ALTER TABLE specialist_earnings_ledger
        ADD CONSTRAINT fk_earnings_payout_request
        FOREIGN KEY (payout_request_id) REFERENCES specialist_payout_requests(payout_request_id)
        ON DELETE SET NULL
      `);
    } catch (_e) {
      /* already exists */
    }
  }

  toImageUrl(p) {
    if (!p) return null;
    let s = String(p).trim().replace(/\\/g, '/');
    const lower = s.toLowerCase();
    const uploadsIdx = lower.indexOf('/uploads/');
    if (uploadsIdx >= 0) {
      s = s.slice(uploadsIdx + 1);
    } else if (lower.startsWith('uploads/')) {
      /* already relative */
    } else if (lower.includes('consultation-chat/')) {
      const ci = lower.indexOf('consultation-chat/');
      s = `uploads/${s.slice(ci)}`;
    } else if (lower.includes('consultation-payments/')) {
      const ci = lower.indexOf('consultation-payments/');
      s = `uploads/${s.slice(ci)}`;
    } else {
      s = s.replace(/^\/+/, '');
    }
    if (s.startsWith('uploads/')) return `/${s}`;
    if (s.startsWith('consultation-chat/')) return `/uploads/${s}`;
    if (s.startsWith('consultation-payments/')) return `/uploads/${s}`;
    return `/${s}`;
  }

  async shouldTriggerOfflineAssistant(consultation) {
    if (!OFFLINE_CHATBOT_ENABLED) return false;
    if (!consultation || !consultation.specialist_user_id) return false;
    const specialistOnline = await this.isSpecialistOnline(consultation.specialist_user_id);
    if (specialistOnline) return false;
    const [rows] = await pool.query(
      `SELECT MAX(created_at) AS last_specialist_at
       FROM consultation_messages
       WHERE consultation_id = ? AND sender_role = 'specialist'`,
      [consultation.consultation_id]
    );
    const lastAt = rows && rows[0] ? rows[0].last_specialist_at : null;
    if (!lastAt) return true;
    const diffMs = Date.now() - new Date(lastAt).getTime();
    return diffMs >= OFFLINE_SPECIALIST_MINUTES * 60 * 1000;
  }

  async markSpecialistPresence(actor) {
    if (!actor || actor.roleName !== 'specialist') {
      const e = new Error('Specialist access only');
      e.status = 403;
      throw e;
    }
    await this.ensureTable();
    await pool.query(
      `INSERT INTO specialist_presence (specialist_user_id, last_seen_at)
       VALUES (?, NOW())
       ON DUPLICATE KEY UPDATE last_seen_at = NOW()`,
      [actor.userId]
    );
    return { specialistUserId: actor.userId, online: true };
  }

  async isSpecialistOnline(specialistUserId) {
    const sid = Number(specialistUserId);
    if (!Number.isFinite(sid) || sid <= 0) return false;
    const [rows] = await pool.query(
      `SELECT last_seen_at
       FROM specialist_presence
       WHERE specialist_user_id = ?
       LIMIT 1`,
      [sid]
    );
    if (!rows.length || !rows[0].last_seen_at) return false;
    const diffMs = Date.now() - new Date(rows[0].last_seen_at).getTime();
    return diffMs <= SPECIALIST_ONLINE_WINDOW_SECONDS * 1000;
  }

  async canSendOfflineAssistantNow(consultationId) {
    const [rows] = await pool.query(
      `SELECT created_at
       FROM consultation_ai_handoffs
       WHERE consultation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [consultationId]
    );
    if (!rows.length) return true;
    const diffMs = Date.now() - new Date(rows[0].created_at).getTime();
    return diffMs >= OFFLINE_CHATBOT_COOLDOWN_MINUTES * 60 * 1000;
  }

  async getConsultationContextForAssistant(consultation) {
    const [profileRows] = await pool.query(
      `SELECT hair_type, scalp_condition, issues_detected
       FROM hair_profiles
       WHERE user_id = ?
       ORDER BY profile_id DESC
       LIMIT 1`,
      [consultation.user_id]
    );
    const [msgRows] = await pool.query(
      `SELECT sender_role, message_text, created_at
       FROM consultation_messages
       WHERE consultation_id = ?
       ORDER BY created_at DESC, message_id DESC
       LIMIT 8`,
      [consultation.consultation_id]
    );
    return {
      profile: profileRows[0] || null,
      recentMessages: (msgRows || []).reverse(),
    };
  }

  async generateOfflineAssistantReply(consultation, context) {
    const profile = context.profile || {};
    const latestUserMessage = (() => {
      const rows = Array.isArray(context.recentMessages) ? context.recentMessages : [];
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (String(rows[i].sender_role || '').toLowerCase() === 'user') {
          return String(rows[i].message_text || '').trim();
        }
      }
      return '';
    })();
    const recent = (context.recentMessages || [])
      .map((m) => `[${m.sender_role}] ${String(m.message_text || '').trim()}`)
      .filter(Boolean)
      .slice(-6)
      .join('\n');
    // Keep offline assistant deterministic and safe for MVP/demo:
    // profile-aware guidance + escalation language, without external model dependency.
    return this.buildRuleBasedOfflineReply(profile, latestUserMessage, recent);
  }

  buildRuleBasedOfflineReply(profile, userMessage, recentSummary = '') {
    const msg = String(userMessage || '').toLowerCase();
    const profileLine =
      profile && (profile.hair_type || profile.scalp_condition)
        ? `Based on your profile (${profile.hair_type || 'hair type not set'}, ${profile.scalp_condition || 'scalp condition not set'})`
        : 'Based on your current chat context';

    let tip = 'keep your routine gentle and consistent tonight';
    if (msg.includes('itch') || msg.includes('irritat') || msg.includes('flak') || msg.includes('dandruff')) {
      tip =
        'use a gentle anti-dandruff or soothing scalp wash, avoid scratching, and rinse thoroughly with lukewarm water';
    } else if (msg.includes('dry') || msg.includes('frizz') || msg.includes('rough')) {
      tip = 'focus on hydration: use a gentle conditioner or mask on lengths and avoid high heat styling tonight';
    } else if (msg.includes('oily') || msg.includes('greasy') || msg.includes('buildup')) {
      tip = 'use a lightweight cleanse and avoid heavy oils on scalp to reduce buildup';
    } else if (msg.includes('hair fall') || msg.includes('shedding') || msg.includes('thinning')) {
      tip = 'avoid tight hairstyles and harsh handling; use a mild routine until your specialist reviews this';
    }

    const acknowledged = userMessage
      ? `I received your message: "${String(userMessage).slice(0, 120)}${String(userMessage).length > 120 ? '…' : ''}".`
      : 'I received your latest concern.';
    const continuityLine = recentSummary ? 'I reviewed your recent chat context as well.' : '';
    const seedText = `${String(userMessage || '')}|${String(recentSummary || '')}`;
    const seed = Array.from(seedText).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const pick = (arr) => arr[seed % arr.length];
    const openers = [
      'Your specialist appears offline right now, so I can help with general guidance while you wait.',
      'Your specialist is currently offline, so I will provide safe initial guidance while waiting.',
      'It looks like your specialist is away at the moment, so I can assist with immediate general care tips.',
    ];
    const closers = [
      'I will forward a summary to your specialist for follow-up.',
      'I will pass this summary to your specialist so they can continue from here.',
      'I will send this context to your specialist for a proper follow-up review.',
    ];

    return [
      pick(openers),
      acknowledged,
      continuityLine,
      `${profileLine}, ${tip}.`,
      'If symptoms worsen, become painful, or include bleeding/infection signs, seek professional care promptly.',
      pick(closers),
    ].join(' ');
  }

  isUrgentUserConcern(messageText) {
    const msg = String(messageText || '').toLowerCase();
    if (!msg) return false;
    const urgentTerms = [
      'bleeding',
      'blood',
      'severe pain',
      'burning',
      'swelling',
      'pus',
      'infect',
      'infection',
      'worsening fast',
      'rapid hair loss',
      'patches',
      'allergic',
      'difficulty breathing',
    ];
    return urgentTerms.some((t) => msg.includes(t));
  }

  async createOfflineAssistantHandoff(consultation, triggerMessageId, assistantReply, context) {
    const recent = (context.recentMessages || [])
      .map((m) => `${m.sender_role}: ${String(m.message_text || '').trim()}`)
      .filter(Boolean)
      .slice(-6);
    const summary = [
      'Offline assistant handoff',
      `Concern: ${consultation.concern_title || '-'}`,
      `Profile: hair_type=${(context.profile && context.profile.hair_type) || 'unknown'}, scalp=${(context.profile && context.profile.scalp_condition) || 'unknown'}, issues=${(context.profile && context.profile.issues_detected) || 'unknown'}`,
      `Recent chat: ${recent.join(' | ') || 'no recent text'}`,
      `Assistant reply: ${assistantReply}`,
    ].join('\n');

    await pool.query(
      `INSERT INTO consultation_ai_handoffs
        (consultation_id, user_id, specialist_user_id, trigger_message_id, summary_text, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        consultation.consultation_id,
        consultation.user_id,
        consultation.specialist_user_id,
        triggerMessageId || null,
        summary,
      ]
    );

    await notificationService.createForUser(consultation.specialist_user_id, {
      type: 'assistant_handoff',
      title: 'AI handoff while offline',
      message: `New user concern summary is ready for "${consultation.concern_title}".`,
      linkUrl: `/consultations.html?chat=${consultation.consultation_id}`,
    });
  }

  mapRow(r) {
    const amount = r.amount_php != null ? Number(r.amount_php) : null;
    const platformPct =
      r.platform_fee_percent != null ? Number(r.platform_fee_percent) : PLATFORM_FEE_PERCENT;
    const platformCut = amount != null && Number.isFinite(platformPct) ? (amount * platformPct) / 100 : null;
    const specialistNet = amount != null ? amount : null;
    const clientTotal = amount != null && platformCut != null ? amount + platformCut : null;
    const pay = r.payment_status || 'unpaid';
    return {
      consultationId: r.consultation_id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      specialistUserId: r.specialist_user_id,
      specialistName: r.specialist_name,
      specialistEmail: r.specialist_email,
      userProfilePhotoUrl: r.user_profile_photo_path ? this.toImageUrl(r.user_profile_photo_path) : null,
      specialistProfilePhotoUrl: r.specialist_profile_photo_path
        ? this.toImageUrl(r.specialist_profile_photo_path)
        : null,
      concernTitle: r.concern_title,
      concernMessage: r.concern_message,
      preferredDate: r.preferred_date,
      preferredTime: normalizePreferredTimeForApi(r.preferred_time),
      status: r.status,
      specialistNotes: r.specialist_notes,
      validatedProductsText: r.validated_products_text,
      finalRecommendation: r.final_recommendation,
      prescriptionSummary: r.prescription_summary || null,
      prescriptionProductsText: r.prescription_products_text || null,
      prescriptionPlanText: r.prescription_plan_text || null,
      prescriptionIssuedAt: r.prescription_issued_at || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      isProUser: !!r.is_pro_user,
      amountPhp: amount,
      platformFeePercent: platformPct,
      platformFeePhp: platformCut != null ? Math.round(platformCut * 100) / 100 : null,
      specialistNetPhp: specialistNet != null ? Math.round(specialistNet * 100) / 100 : null,
      clientTotalPhp: clientTotal != null ? Math.round(clientTotal * 100) / 100 : null,
      paymentStatus: pay,
      paymentReference: r.payment_reference || null,
      paymentReceiptUrl: r.payment_receipt_path ? this.toImageUrl(r.payment_receipt_path) : null,
      paymentSubmittedAt: r.payment_submitted_at || null,
      meetingUrl: r.meeting_url || null,
      scheduledAt: r.scheduled_at || null,
      completedAt: r.completed_at || null,
      declineReason: r.decline_reason || null,
      paidVerifiedAt: r.paid_verified_at || null,
      feedbackRating: r.feedback_rating != null ? Number(r.feedback_rating) : null,
      feedbackText: r.feedback_text || null,
      feedbackAt: r.feedback_created_at || null,
      specialistRatingAvg: r.specialist_rating_avg != null ? Number(r.specialist_rating_avg) : null,
      specialistRatingCount: r.specialist_rating_count != null ? Number(r.specialist_rating_count) : 0,
    };
  }

  applyChatUnlocked(row, actor) {
    const pay = row.paymentStatus || 'unpaid';
    const st = String(row.status || '');
    const sessionLive = st === 'in_progress' || st === 'completed';
    const unlocked = (pay === 'verified' && sessionLive) || isModerator(actor);
    return { ...row, chatUnlocked: unlocked };
  }

  calculateSplit(amountPhp, commissionPercent) {
    const specialistFee = Number(amountPhp || 0);
    const pct = Number(commissionPercent || 0);
    const normalizedCommission = Math.round(((specialistFee * pct) / 100) * 100) / 100;
    const clientTotal = Math.round((specialistFee + normalizedCommission) * 100) / 100;
    return {
      grossAmountPhp: clientTotal,
      commissionPercent: Math.round(pct * 100) / 100,
      commissionAmountPhp: normalizedCommission,
      netAmountPhp: Math.round(specialistFee * 100) / 100,
    };
  }

  async releaseConsultationEarning(consultationId) {
    const id = Number(consultationId);
    if (!Number.isFinite(id)) return;
    const [rows] = await pool.query(
      `SELECT consultation_id, specialist_user_id, amount_php, platform_fee_percent, status, payment_status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) return;
    const c = rows[0];
    const st = String(c.status || '');
    if (!c.specialist_user_id || String(c.payment_status) !== 'verified') return;
    if (st === 'cancelled' || st === 'declined') return;
    // Accuracy rule: specialist earning is released only after case closure.
    if (st !== 'completed') return;
    const split = this.calculateSplit(c.amount_php || DEFAULT_CONSULTATION_PHP, c.platform_fee_percent || PLATFORM_FEE_PERCENT);
    await pool.query(
      `INSERT INTO specialist_earnings_ledger
         (consultation_id, specialist_user_id, gross_amount_php, commission_percent, commission_amount_php, net_amount_php, status, released_at)
       VALUES (?, ?, ?, ?, ?, ?, 'released', NOW())
       ON DUPLICATE KEY UPDATE
         specialist_user_id = VALUES(specialist_user_id),
         gross_amount_php = VALUES(gross_amount_php),
         commission_percent = VALUES(commission_percent),
         commission_amount_php = VALUES(commission_amount_php),
         net_amount_php = VALUES(net_amount_php)`,
      [
        id,
        c.specialist_user_id,
        split.grossAmountPhp,
        split.commissionPercent,
        split.commissionAmountPhp,
        split.netAmountPhp,
      ]
    );
  }

  async createRequest(userId, payload) {
    await this.ensureTable();
    const [activeRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM consultations
       WHERE user_id = ?
         AND status NOT IN ('completed', 'cancelled', 'declined')`,
      [userId]
    );
    const activeTotal = Number((activeRows && activeRows[0] && activeRows[0].total) || 0);
    const ent = await billingService.getEntitlements(userId);
    const planCap = Number(ent.maxActiveConsultations);
    const planMax =
      Number.isFinite(planCap) && planCap >= 0 ? Math.min(GLOBAL_MAX_ACTIVE_CONSULTATIONS, planCap) : 0;
    if (planMax <= 0) {
      const e = new Error(
        'Consultations require a Pro subscription. Upgrade on the Pricing page to book a specialist.'
      );
      e.status = 403;
      throw e;
    }
    if (activeTotal >= planMax) {
      const e = new Error(`You can only keep up to ${planMax} active consultation(s) on your current plan.`);
      e.status = 403;
      throw e;
    }
    const concernTitle = String(payload.concernTitle || '').trim();
    const concernMessage = String(payload.concernMessage || '').trim();
    const preferredDate = payload.preferredDate || null;
    const preferredTimeRaw = payload.preferredTime != null ? String(payload.preferredTime).trim() : '';
    const specialistUserId = Number(payload.specialistUserId);
    if (!Number.isFinite(specialistUserId) || specialistUserId <= 0) {
      throw new Error('Choose a specialist for this consultation');
    }

    if (!concernTitle || !concernMessage) {
      throw new Error('Concern title and message are required');
    }

    if (!preferredDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(preferredDate))) {
      throw new Error('Preferred date is required (YYYY-MM-DD)');
    }
    if (!preferredTimeRaw) {
      throw new Error('Preferred time is required');
    }
    let preferredTime = null;
    if (/^\d{2}:\d{2}$/.test(preferredTimeRaw)) {
      preferredTime = `${preferredTimeRaw}:00`;
    } else if (/^\d{2}:\d{2}:\d{2}$/.test(preferredTimeRaw)) {
      preferredTime = preferredTimeRaw;
    } else {
      throw new Error('Preferred time must be HH:MM (24-hour)');
    }

    const [specRows] = await pool.query(
      `SELECT u.user_id, up.consultation_rate
       FROM users u
       JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN user_profiles up ON up.user_id = u.user_id
       WHERE u.user_id = ? AND r.role_name IN ('seller', 'specialist')`,
      [specialistUserId]
    );
    if (!specRows.length) {
      throw new Error('Invalid specialist');
    }
    if (specRows[0].user_id === userId) {
      throw new Error('You cannot book a consultation with yourself');
    }

    let amountPhp = payload.amountPhp != null ? Number(payload.amountPhp) : null;
    if (!Number.isFinite(amountPhp) || amountPhp <= 0) {
      const rate = specRows[0].consultation_rate != null ? Number(specRows[0].consultation_rate) : null;
      amountPhp = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_CONSULTATION_PHP;
    }

    const [result] = await pool.query(
      `INSERT INTO consultations (
         user_id, specialist_user_id, concern_title, concern_message, preferred_date, preferred_time,
         amount_php, platform_fee_percent, status, payment_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unpaid')`,
      [
        userId,
        specialistUserId,
        concernTitle,
        concernMessage,
        preferredDate,
        preferredTime,
        amountPhp,
        PLATFORM_FEE_PERCENT,
      ]
    );

    const prefSlot = `${preferredDate} ${preferredTimeRaw}`;
    await notificationService.createForUser(specialistUserId, {
      type: 'consultation_request',
      title: 'New consultation request',
      message: `You have a new request: "${concernTitle}" (preferred ${prefSlot}).`,
      linkUrl: '/consultations.html',
    });
    await notificationService.createForRoles(
      ['admin'],
      {
        type: 'consultation_request',
        title: 'New consultation request',
        message: `A user submitted "${concernTitle}" (preferred ${prefSlot}).`,
        linkUrl: '/consultations.html',
      },
      userId
    );

    return { consultationId: result.insertId };
  }

  async listConsultations(actor) {
    await this.ensureTable();
    const showAllStaff = isModerator(actor);
    const specialistScope = actor.roleName === 'specialist' ? 1 : 0;
    await billingService.ensureSchema();
    const [rows] = await pool.query(
      `SELECT c.consultation_id, c.user_id, c.specialist_user_id, c.concern_title, c.concern_message,
              c.preferred_date,
              TIME_FORMAT(c.preferred_time, '%H:%i:%s') AS preferred_time, c.status, c.specialist_notes, c.validated_products_text,
              c.final_recommendation, c.prescription_summary, c.prescription_products_text,
              c.prescription_plan_text, c.prescription_issued_at, c.created_at, c.updated_at,
              c.amount_php, c.platform_fee_percent, c.payment_status, c.payment_reference,
              c.payment_receipt_path, c.payment_submitted_at, c.meeting_url, c.scheduled_at, c.completed_at, c.decline_reason,
              c.paid_verified_at, c.verified_by_admin_user_id,
              cf.rating AS feedback_rating, cf.feedback_text, cf.created_at AS feedback_created_at,
              u.name AS user_name, u.email AS user_email,
              s.name AS specialist_name, s.email AS specialist_email,
              up_user.profile_photo_path AS user_profile_photo_path,
              up_spec.profile_photo_path AS specialist_profile_photo_path,
              sr.avg_rating AS specialist_rating_avg, sr.total_reviews AS specialist_rating_count,
              CASE WHEN pro_sub.subscription_id IS NULL THEN 0 ELSE 1 END AS is_pro_user
       FROM consultations c
       JOIN users u ON u.user_id = c.user_id
       LEFT JOIN users s ON s.user_id = c.specialist_user_id
       LEFT JOIN user_profiles up_user ON up_user.user_id = c.user_id
       LEFT JOIN user_profiles up_spec ON up_spec.user_id = c.specialist_user_id
       LEFT JOIN consultation_feedback cf ON cf.consultation_id = c.consultation_id AND cf.user_id = c.user_id
       LEFT JOIN (
         SELECT specialist_user_id, ROUND(AVG(rating), 2) AS avg_rating, COUNT(*) AS total_reviews
         FROM consultation_feedback
         GROUP BY specialist_user_id
       ) sr ON sr.specialist_user_id = c.specialist_user_id
       LEFT JOIN (
         SELECT us.subscription_id, us.user_id
         FROM user_subscriptions us
         JOIN subscription_plans sp ON sp.plan_id = us.plan_id
         WHERE us.status = 'active' AND us.ends_at >= NOW() AND sp.plan_code <> 'free'
       ) pro_sub ON pro_sub.user_id = c.user_id
       WHERE (
         ? = 1
         OR c.user_id = ?
         OR (? = 1 AND c.specialist_user_id = ?)
       )
       ORDER BY
         CASE WHEN ? = 1 THEN CASE WHEN pro_sub.subscription_id IS NULL THEN 1 ELSE 0 END ELSE 0 END ASC,
         c.created_at DESC`,
      [
        showAllStaff ? 1 : 0,
        actor.userId,
        specialistScope,
        actor.userId,
        showAllStaff ? 1 : 0,
      ]
    );

    return rows.map((r) => this.applyChatUnlocked(this.mapRow(r), actor));
  }

  /**
   * Client permanently removes a consultation (messages + row) from their account.
   * Not allowed while payment is verified and the session is still in progress.
   */
  async deleteConsultationAsOwner(actor, consultationId) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id)) {
      const e = new Error('Invalid consultation ID');
      e.status = 400;
      throw e;
    }

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, status, payment_status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) {
      const e = new Error('Consultation not found');
      e.status = 404;
      throw e;
    }

    const c = rows[0];
    if (c.user_id !== actor.userId) {
      const e = new Error('Not allowed');
      e.status = 403;
      throw e;
    }

    const st = String(c.status || '');
    const pay = c.payment_status || 'unpaid';
    if (pay === 'verified' && st === 'in_progress') {
      const e = new Error('Complete this consultation before removing it from your list');
      e.status = 409;
      throw e;
    }

    try {
      await pool.query(`DELETE FROM consultation_messages WHERE consultation_id = ?`, [id]);
      await pool.query(`DELETE FROM consultations WHERE consultation_id = ?`, [id]);
    } catch (sqlErr) {
      if (sqlErr && (sqlErr.errno === 1451 || sqlErr.code === 'ER_ROW_IS_REFERENCED_2')) {
        const e = new Error('This chat cannot be removed yet due to linked records. Try again or contact support.');
        e.status = 409;
        throw e;
      }
      throw sqlErr;
    }
    return { consultationId: id, deleted: true };
  }

  async updateConsultation(actor, consultationId, payload) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id, concern_title, status, payment_status,
              specialist_notes, validated_products_text, final_recommendation,
              prescription_summary, prescription_products_text, prescription_plan_text, prescription_issued_at
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');

    const existing = rows[0];
    const isOwner = existing.user_id === actor.userId;
    const canManage = canManageConsultation(actor, existing);
    const hadPrescriptionBefore =
      String(existing.prescription_summary || '').trim() ||
      String(existing.prescription_products_text || '').trim() ||
      String(existing.prescription_plan_text || '').trim();

    const fields = [];
    const values = [];

    const requestedStatus = payload.status;
    const action = payload.action ? String(payload.action).toLowerCase() : null;
    const nextSpecialistNotes =
      payload.specialistNotes !== undefined ? String(payload.specialistNotes || '').trim() || null : undefined;
    const nextValidatedProductsText =
      payload.validatedProductsText !== undefined
        ? String(payload.validatedProductsText || '').trim() || null
        : undefined;
    const nextFinalRecommendation =
      payload.finalRecommendation !== undefined
        ? String(payload.finalRecommendation || '').trim() || null
        : undefined;
    const nextPrescriptionSummary =
      payload.prescriptionSummary !== undefined
        ? String(payload.prescriptionSummary || '').trim() || null
        : undefined;
    const nextPrescriptionProductsText =
      payload.prescriptionProductsText !== undefined
        ? String(payload.prescriptionProductsText || '').trim() || null
        : undefined;
    const nextPrescriptionPlanText =
      payload.prescriptionPlanText !== undefined
        ? String(payload.prescriptionPlanText || '').trim() || null
        : undefined;
    const attemptsPrescriptionChangeAfterIssuance =
      !!hadPrescriptionBefore &&
      ((nextPrescriptionSummary !== undefined &&
        (existing.prescription_summary || null) !== nextPrescriptionSummary) ||
        (nextPrescriptionProductsText !== undefined &&
          (existing.prescription_products_text || null) !== nextPrescriptionProductsText) ||
        (nextPrescriptionPlanText !== undefined &&
          (existing.prescription_plan_text || null) !== nextPrescriptionPlanText));
    if (attemptsPrescriptionChangeAfterIssuance) {
      const e = new Error('Care prescription is already issued and locked');
      e.status = 409;
      throw e;
    }
    let touchedReviewerContent = false;
    let touchedPrescriptionContent = false;
    let willHavePrescriptionAfter = !!hadPrescriptionBefore;
    if (canManage) {
      if ((action === 'accept' || action === 'decline') && actor.roleName !== 'specialist') {
        const e = new Error('Only specialists can accept or decline consultation requests');
        e.status = 403;
        throw e;
      }
      if (action === 'accept') {
        if (existing.status !== 'pending') throw new Error('Only pending requests can be accepted');
        fields.push('status = ?');
        values.push('awaiting_payment');
        const meetingUrl = payload.meetingUrl != null ? String(payload.meetingUrl).trim() : '';
        fields.push('meeting_url = ?');
        values.push(meetingUrl || null);
      } else if (action === 'decline') {
        if (existing.status !== 'pending') throw new Error('Only pending requests can be declined');
        fields.push('status = ?');
        values.push('declined');
        fields.push('decline_reason = ?');
        values.push(payload.declineReason != null ? String(payload.declineReason).trim() || null : null);
      } else if (payload.status !== undefined) {
        const st = assertStatusTransition(existing.status, payload.status);
        if (st === 'cancelled' && String(existing.payment_status || '') === 'verified') {
          const e = new Error('Cannot cancel a paid consultation directly. Use refund flow first.');
          e.status = 409;
          throw e;
        }
        if (st === 'scheduled' && (!payload.meetingUrl || !String(payload.meetingUrl).trim())) {
          throw new Error('Meeting link is required before scheduling a paid consultation');
        }
        fields.push('status = ?');
        values.push(st);
        if (st === 'awaiting_payment') {
          const meetingUrl = payload.meetingUrl != null ? String(payload.meetingUrl).trim() : '';
          fields.push('meeting_url = ?');
          values.push(meetingUrl || null);
        }
        if (st === 'scheduled' && payload.meetingUrl !== undefined) {
          fields.push('meeting_url = ?');
          values.push(String(payload.meetingUrl).trim() || null);
          fields.push('scheduled_at = COALESCE(scheduled_at, NOW())');
        }
        if (st === 'completed') {
          const finalRecommendation = payload.finalRecommendation != null ? String(payload.finalRecommendation).trim() : '';
          const existingFinal = existing.final_recommendation != null ? String(existing.final_recommendation).trim() : '';
          if (!finalRecommendation && !existingFinal) {
            throw new Error('Provide a short case summary before closing the consultation');
          }
          fields.push('completed_at = COALESCE(completed_at, NOW())');
        }
      }
      if (nextSpecialistNotes !== undefined && (existing.specialist_notes || null) !== nextSpecialistNotes) {
        fields.push('specialist_notes = ?');
        values.push(nextSpecialistNotes);
        touchedReviewerContent = true;
      }
      if (
        nextValidatedProductsText !== undefined &&
        (existing.validated_products_text || null) !== nextValidatedProductsText
      ) {
        fields.push('validated_products_text = ?');
        values.push(nextValidatedProductsText);
        touchedReviewerContent = true;
      }
      if (nextFinalRecommendation !== undefined && (existing.final_recommendation || null) !== nextFinalRecommendation) {
        fields.push('final_recommendation = ?');
        values.push(nextFinalRecommendation);
        touchedReviewerContent = true;
      }
      if (
        nextPrescriptionSummary !== undefined &&
        (existing.prescription_summary || null) !== nextPrescriptionSummary
      ) {
        fields.push('prescription_summary = ?');
        values.push(nextPrescriptionSummary);
        touchedPrescriptionContent = true;
      }
      if (
        nextPrescriptionProductsText !== undefined &&
        (existing.prescription_products_text || null) !== nextPrescriptionProductsText
      ) {
        fields.push('prescription_products_text = ?');
        values.push(nextPrescriptionProductsText);
        touchedPrescriptionContent = true;
      }
      if (
        nextPrescriptionPlanText !== undefined &&
        (existing.prescription_plan_text || null) !== nextPrescriptionPlanText
      ) {
        fields.push('prescription_plan_text = ?');
        values.push(nextPrescriptionPlanText);
        touchedPrescriptionContent = true;
      }
      if (touchedPrescriptionContent && !hadPrescriptionBefore) {
        fields.push('prescription_issued_at = COALESCE(prescription_issued_at, NOW())');
        willHavePrescriptionAfter =
          String(nextPrescriptionSummary !== undefined ? nextPrescriptionSummary : existing.prescription_summary || '').trim() ||
          String(
            nextPrescriptionProductsText !== undefined
              ? nextPrescriptionProductsText
              : existing.prescription_products_text || ''
          ).trim() ||
          String(nextPrescriptionPlanText !== undefined ? nextPrescriptionPlanText : existing.prescription_plan_text || '').trim();
      }
      if (payload.meetingUrl !== undefined) {
        const payOk = String(existing.payment_status || '') === 'verified';
        const st = String(existing.status || '');
        if (
          payOk &&
          st !== 'declined' &&
          st !== 'cancelled'
        ) {
          fields.push('meeting_url = ?');
          values.push(String(payload.meetingUrl).trim() || null);
          if (st === 'scheduled' || st === 'in_progress') {
            fields.push('scheduled_at = COALESCE(scheduled_at, NOW())');
          }
        }
      }
      if (existing.specialist_user_id == null && isModerator(actor)) {
        fields.push('specialist_user_id = ?');
        values.push(actor.userId);
      }
    } else if (isOwner) {
      if (action === 'request_meeting') {
        if (!existing.specialist_user_id) {
          throw new Error('No specialist assigned yet');
        }
        if (existing.status === 'cancelled' || existing.status === 'declined') {
          throw new Error('This consultation cannot receive requests');
        }
        const clientLabel = actor.name ? String(actor.name).trim() : 'Your client';
        await notificationService.createForUser(existing.specialist_user_id, {
          type: 'consultation_meeting_request',
          title: 'Video call requested',
          message: `${clientLabel} asked for a video chat for "${existing.concern_title}". Add a Meet or Zoom link to the consultation when ready.`,
          linkUrl: `/consultations.html?chat=${id}`,
        });
        return { consultationId: id, meetingRequestSent: true };
      }
      if (payload.status === 'cancelled') {
        const ok =
          (existing.status === 'pending' ||
            (existing.status === 'awaiting_payment' && existing.payment_status !== 'verified')) &&
          existing.payment_status !== 'verified';
        if (!ok) {
          throw new Error('You cannot cancel this consultation at this stage');
        }
        fields.push('status = ?');
        values.push('cancelled');
      } else {
        throw new Error('Not allowed to update this consultation');
      }
    } else {
      throw new Error('Not allowed to update this consultation');
    }

    if (!fields.length) {
      return { consultationId: id, updated: false, noChanges: true };
    }

    values.push(id);
    await pool.query(`UPDATE consultations SET ${fields.join(', ')} WHERE consultation_id = ?`, values);

    const effectiveStatus =
      action === 'accept' ? 'awaiting_payment' : action === 'decline' ? 'declined' : normalizeStatus(requestedStatus);

    if (effectiveStatus === 'completed') {
      await this.releaseConsultationEarning(id);
    }

    if (canManage) {
      const st = effectiveStatus || requestedStatus;
      if (st === 'awaiting_payment' || st === 'completed' || st === 'cancelled' || st === 'declined') {
        const label =
          st === 'awaiting_payment'
            ? 'Awaiting payment'
            : st.charAt(0).toUpperCase() + st.slice(1);
        await notificationService.createForUser(existing.user_id, {
          type: 'consultation_status',
          title: `Consultation update`,
          message: `Your consultation "${existing.concern_title}" is now ${st === 'awaiting_payment' ? 'awaiting payment' : st}.`,
          linkUrl: '/consultations.html',
        });
      }
      if (action === 'decline' && existing.specialist_user_id) {
        /* already notified user above */
      }
      if (touchedPrescriptionContent && !hadPrescriptionBefore && !!willHavePrescriptionAfter) {
        await notificationService.createForUser(existing.user_id, {
          type: 'consultation_update',
          title: 'Care prescription is ready',
          message: `Your specialist added a care prescription for "${existing.concern_title}".`,
          linkUrl: '/consultations.html',
        });
      } else if (touchedReviewerContent) {
        await notificationService.createForUser(existing.user_id, {
          type: 'consultation_update',
          title: 'Specialist updated your consultation',
          message: `New specialist notes were added to "${existing.concern_title}".`,
          linkUrl: '/consultations.html',
        });
      }
    } else if (requestedStatus === 'cancelled') {
      if (existing.specialist_user_id) {
        await notificationService.createForUser(existing.specialist_user_id, {
          type: 'consultation_cancelled',
          title: 'Consultation cancelled',
          message: `User cancelled "${existing.concern_title}".`,
          linkUrl: '/consultations.html',
        });
      } else {
        await notificationService.createForRoles(
          ['seller', 'specialist', 'admin'],
          {
            type: 'consultation_cancelled',
            title: 'Consultation cancelled',
            message: `User cancelled "${existing.concern_title}".`,
            linkUrl: '/consultations.html',
          },
          existing.user_id
        );
      }
    }

    return { consultationId: id, updated: true };
  }

  async submitPaymentProof(actor, consultationId, payload) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');
    const reference = String(payload.paymentReference || '').trim();
    const receiptPath = payload.receiptRelativePath
      ? String(payload.receiptRelativePath).trim().replace(/^\/+/, '')
      : null;
    if (!reference) throw new Error('Payment reference is required');
    if (!receiptPath) throw new Error('Payment receipt image is required');

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, status, payment_status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];
    if (c.user_id !== actor.userId) throw new Error('Not allowed');
    if (c.status !== 'awaiting_payment') throw new Error('Payment is not required for this consultation');
    if (c.payment_status === 'verified') throw new Error('Payment already verified');
    if (c.payment_status === 'pending_review') throw new Error('Receipt already submitted');

    await pool.query(
      `UPDATE consultations SET
         payment_reference = ?,
         payment_receipt_path = ?,
         payment_status = 'pending_review',
         payment_submitted_at = CURRENT_TIMESTAMP
       WHERE consultation_id = ?`,
      [reference, receiptPath, id]
    );

    await notificationService.createForRoles(
      ['admin'],
      {
        type: 'payment_pending',
        title: 'Payment proof submitted',
        message: `Consultation #${id} needs GCash verification.`,
        linkUrl: '/consultations.html',
      },
      actor.userId
    );

    return { consultationId: id, submitted: true };
  }

  async submitDemoPayment(actor, consultationId) {
    await this.ensureTable();
    if (!isDemoPaymentEnabled()) {
      throw new Error('Demo payment mode is disabled on this server');
    }
    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');
    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, status, payment_status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];
    if (c.user_id !== actor.userId) throw new Error('Not allowed');
    if (c.status !== 'awaiting_payment') throw new Error('Payment is not required for this consultation');
    if (c.payment_status === 'verified') throw new Error('Payment already verified');
    if (c.payment_status === 'pending_review') throw new Error('Payment already submitted for review');

    const reference = `DEMO-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    await pool.query(
      `UPDATE consultations SET
         payment_reference = ?,
         payment_receipt_path = NULL,
         payment_status = 'pending_review',
         payment_submitted_at = CURRENT_TIMESTAMP
       WHERE consultation_id = ?`,
      [reference, id]
    );

    await notificationService.createForRoles(
      ['admin'],
      {
        type: 'payment_pending',
        title: 'Demo payment submitted',
        message: `Consultation #${id} submitted demo payment for verification.`,
        linkUrl: '/consultations.html',
      },
      actor.userId
    );

    return { consultationId: id, submitted: true, demoReference: reference };
  }

  async verifyPayment(adminUserId, consultationId) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id, concern_title, payment_status, status,
              payment_reference, payment_receipt_path
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];
    const canDirectVerify =
      c.status === 'awaiting_payment' &&
      c.payment_status === 'pending_review';
    if (!canDirectVerify) {
      throw new Error('This consultation is not eligible for payment verification');
    }
    const ref = String(c.payment_reference || '').trim();
    const hasManualProof = !!String(c.payment_receipt_path || '').trim();
    const hasDemoMarker = /^DEMO-/i.test(ref);
    if (!hasManualProof && !hasDemoMarker) {
      throw new Error('Payment proof is required before verification');
    }

    await pool.query(
      `UPDATE consultations SET
         payment_status = 'verified',
         status = 'scheduled',
         scheduled_at = COALESCE(scheduled_at, NOW()),
         paid_verified_at = CURRENT_TIMESTAMP,
         verified_by_admin_user_id = ?
       WHERE consultation_id = ?`,
      [adminUserId, id]
    );

    await notificationService.createForUser(c.user_id, {
      type: 'payment_verified',
      title: 'Payment confirmed',
      message: `"${c.concern_title}" is paid. You can message your specialist now.`,
      linkUrl: `/consultations.html?chat=${id}`,
    });
    if (c.specialist_user_id) {
      await notificationService.createForUser(c.specialist_user_id, {
        type: 'payment_verified',
        title: 'Consultation paid',
        message: `"${c.concern_title}" is verified paid. Session can proceed.`,
        linkUrl: `/consultations.html?chat=${id}`,
      });
    }

    await this.releaseConsultationEarning(id);

    return { consultationId: id, verified: true };
  }

  async rejectPayment(adminUserId, consultationId, payload) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');
    const note = payload && payload.note != null ? String(payload.note).trim() : '';

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, concern_title, payment_status FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];
    if (c.payment_status !== 'pending_review') {
      throw new Error('This consultation is not awaiting payment verification');
    }

    await pool.query(
      `UPDATE consultations SET
         payment_status = 'rejected',
         payment_reference = NULL,
         payment_receipt_path = NULL,
         payment_submitted_at = NULL
       WHERE consultation_id = ?`,
      [id]
    );

    await notificationService.createForUser(c.user_id, {
      type: 'payment_rejected',
      title: 'Payment proof needs resubmission',
      message: note
        ? `Admin note: ${note}`
        : `Please resubmit GCash proof for "${c.concern_title}".`,
      linkUrl: '/consultations.html',
    });

    return { consultationId: id, rejected: true };
  }

  async listMessages(actor, consultationId) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');
    const [consultRows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id, payment_status, status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!consultRows.length) throw new Error('Consultation not found');
    const consultation = consultRows[0];
    const isOwner = consultation.user_id === actor.userId;
    const isSpec = isAssignedSpecialist(actor, consultation.specialist_user_id);
    const mod = isModerator(actor);
    if (!mod && !isOwner && !isSpec) {
      throw new Error('Not allowed to view this chat');
    }
    const pay = consultation.payment_status || 'unpaid';
    const st = String(consultation.status || '');
    const sessionLive = st === 'in_progress' || st === 'completed';
    const chatUnlocked = (pay === 'verified' && sessionLive) || mod;
    if (!chatUnlocked) {
      return { messages: [], chatLocked: true };
    }

    const [rows] = await pool.query(
      `SELECT cm.message_id, cm.sender_user_id, cm.sender_role, cm.message_text, cm.image_path, cm.created_at,
              u.name AS sender_name, up.profile_photo_path AS sender_profile_photo_path
       FROM consultation_messages cm
       JOIN users u ON u.user_id = cm.sender_user_id
       LEFT JOIN user_profiles up ON up.user_id = cm.sender_user_id
       WHERE cm.consultation_id = ?
       ORDER BY cm.created_at ASC, cm.message_id ASC`,
      [id]
    );
    const messages = rows.map((r) => ({
      messageId: r.message_id,
      senderUserId: r.sender_user_id,
      senderRole: r.sender_role,
      senderName: r.sender_name,
      senderPhotoUrl: r.sender_profile_photo_path ? this.toImageUrl(r.sender_profile_photo_path) : null,
      messageText: r.message_text,
      imageUrl: r.image_path ? this.toImageUrl(r.image_path) : null,
      createdAt: r.created_at,
    }));
    return { messages, chatLocked: false };
  }

  async sendMessage(actor, consultationId, payload) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');
    const messageText = String(payload.messageText || '').trim();
    let imageRelativePath = payload.imageRelativePath
      ? String(payload.imageRelativePath).trim().replace(/^\/+/, '')
      : null;
    if (imageRelativePath && imageRelativePath.startsWith('consultation-chat/')) {
      imageRelativePath = `uploads/${imageRelativePath}`;
    }
    if (!messageText && !imageRelativePath) throw new Error('Add a message, a photo, or both.');
    const [consultRows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id, concern_title, status, payment_status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!consultRows.length) throw new Error('Consultation not found');
    const consultation = consultRows[0];
    if (consultation.status === 'cancelled' || consultation.status === 'declined') {
      throw new Error('Cannot send message to this consultation');
    }
    const isOwner = consultation.user_id === actor.userId;
    const isSpec = isAssignedSpecialist(actor, consultation.specialist_user_id);
    const mod = isModerator(actor);
    if (!mod && !isOwner && !isSpec) {
      throw new Error('Not allowed to message in this consultation');
    }
    const pay = consultation.payment_status || 'unpaid';
    const st = String(consultation.status || '');
    const sessionLive = st === 'in_progress' || st === 'completed';
    if (!mod && (pay !== 'verified' || !sessionLive)) {
      throw new Error('Chat opens when payment is verified and the specialist starts the session');
    }
    const senderRole = mod || isSpec ? 'specialist' : 'user';
    const textForDb = messageText || (imageRelativePath ? '' : '');
    const [result] = await pool.query(
      `INSERT INTO consultation_messages (consultation_id, sender_user_id, sender_role, message_text, image_path)
       VALUES (?, ?, ?, ?, ?)`,
      [id, actor.userId, senderRole, textForDb, imageRelativePath]
    );
    if (mod || isSpec) {
      if (consultation.specialist_user_id == null) {
        await pool.query('UPDATE consultations SET specialist_user_id = ? WHERE consultation_id = ?', [
          actor.userId,
          id,
        ]);
      }
      await notificationService.createForUser(consultation.user_id, {
        type: 'chat_message',
        title: 'New message from specialist',
        message: `${actor.name || 'Specialist'} sent a message on "${consultation.concern_title}".`,
        linkUrl: `/consultations.html?chat=${id}`,
      });
    } else {
      if (consultation.specialist_user_id) {
        await notificationService.createForUser(consultation.specialist_user_id, {
          type: 'chat_message',
          title: 'New message from user',
          message: `${actor.name || 'User'} sent a message on "${consultation.concern_title}".`,
          linkUrl: `/consultations.html?chat=${id}`,
        });
      }
      // Offline assistant fallback: provide immediate safe guidance and queue a handoff summary.
      if (consultation.specialist_user_id) {
        const shouldTrigger = await this.shouldTriggerOfflineAssistant(consultation);
        if (shouldTrigger) {
          const context = await this.getConsultationContextForAssistant(consultation);
          let assistantReply = await this.generateOfflineAssistantReply(consultation, context);
          const urgent = this.isUrgentUserConcern(messageText);
          if (urgent) {
            assistantReply = [
              'Your message may include urgent symptoms. I cannot diagnose conditions in chat.',
              'Please seek immediate professional care if symptoms are severe, painful, spreading, or include bleeding/infection signs.',
              'I am escalating this to your specialist now and they should follow up as soon as possible.',
            ].join(' ');
          }
          if (assistantReply && assistantReply.trim()) {
            await pool.query(
              `INSERT INTO consultation_messages (consultation_id, sender_user_id, sender_role, message_text, image_path)
               VALUES (?, ?, 'assistant', ?, NULL)`,
              [id, consultation.specialist_user_id, assistantReply.trim()]
            );
            const canCreateHandoffNow = urgent || (await this.canSendOfflineAssistantNow(id));
            if (canCreateHandoffNow) {
              await this.createOfflineAssistantHandoff(
                consultation,
                result.insertId,
                assistantReply.trim(),
                context
              );
            }
          }
        }
      }
    }
    return { messageId: result.insertId, sent: true };
  }

  async deleteMessage(actor, consultationId, messageId) {
    await this.ensureTable();
    const cid = Number(consultationId);
    const mid = Number(messageId);
    if (!Number.isFinite(cid) || !Number.isFinite(mid)) throw new Error('Invalid id');
    const [rows] = await pool.query(
      `SELECT cm.message_id, cm.sender_user_id, cm.consultation_id,
              c.user_id, c.specialist_user_id, c.status
       FROM consultation_messages cm
       JOIN consultations c ON c.consultation_id = cm.consultation_id
       WHERE cm.message_id = ? AND cm.consultation_id = ?`,
      [mid, cid]
    );
    if (!rows.length) throw new Error('Message not found');
    const msg = rows[0];
    const mod = isModerator(actor);
    const isConsultOwner = msg.user_id === actor.userId;
    const isSpec = isAssignedSpecialist(actor, msg.specialist_user_id);
    if (!mod && !isConsultOwner && !isSpec) {
      throw new Error('Not allowed to access this consultation');
    }
    if (!mod && msg.sender_user_id !== actor.userId) {
      throw new Error('You can only delete your own messages');
    }
    await pool.query('DELETE FROM consultation_messages WHERE message_id = ? AND consultation_id = ?', [mid, cid]);
    return { deleted: true, messageId: mid };
  }

  /**
   * Creates a PayMongo Checkout Session and returns checkout_url for redirect.
   */
  async createPayMongoCheckoutForOwner(actor, consultationId) {
    await this.ensureTable();
    const paymongoService = require('./paymongoService');
    if (!paymongoService.isConfigured()) {
      const err = new Error(
        'PayMongo is not configured. Set PAYMONGO_SECRET_KEY in the server environment (see .env.example).'
      );
      err.status = 503;
      throw err;
    }

    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id, concern_title, amount_php, platform_fee_percent, payment_status, status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];
    if (c.user_id !== actor.userId) throw new Error('Not allowed');
    if (c.status !== 'awaiting_payment') {
      throw new Error('Consultation is not awaiting payment');
    }
    const pay = c.payment_status || 'unpaid';
    if (pay === 'verified') throw new Error('Already paid');
    if (pay === 'pending_review') {
      throw new Error('Payment proof is already pending admin review. Wait for a decision or contact support.');
    }

    const amountPhp = c.amount_php != null ? Number(c.amount_php) : DEFAULT_CONSULTATION_PHP;
    const split = this.calculateSplit(
      amountPhp,
      c.platform_fee_percent != null ? Number(c.platform_fee_percent) : PLATFORM_FEE_PERCENT
    );
    const centavos = Math.round(split.grossAmountPhp * 100);
    const port = process.env.PORT || 3000;
    const base = (process.env.APP_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
    const successUrl = `${base}/consultations.html?chat=${id}&paymongo=success`;
    const cancelUrl = `${base}/consultations.html?chat=${id}&paymongo=cancel`;

    const title = String(c.concern_title || 'Consultation').slice(0, 255);
    const session = await paymongoService.createCheckoutSession({
      line_items: [
        {
          currency: 'PHP',
          amount: centavos,
          name: `Consultation #${id}`,
          quantity: 1,
          description: title,
        },
      ],
      payment_method_types: paymongoService.getPaymentMethodTypes(),
      success_url: successUrl,
      cancel_url: cancelUrl,
      description: `Hairvelous · ${title}`,
      reference_number: `HV${id}-${Date.now()}`.slice(0, 32),
      metadata: {
        consultation_id: String(id),
        user_id: String(actor.userId),
      },
    });

    const checkoutUrl = session.attributes && session.attributes.checkout_url;
    const sessionId = session.id;
    if (!checkoutUrl) {
      throw new Error('PayMongo did not return a checkout URL');
    }

    await pool.query(
      `UPDATE consultations SET paymongo_checkout_session_id = ?, paymongo_payment_intent_id = NULL WHERE consultation_id = ?`,
      [sessionId, id]
    );

    return { checkoutUrl, consultationId: id, checkoutSessionId: sessionId };
  }

  /**
   * QR Ph: Payment Intent + attach → `qrImageUrl` (data URL) for display. User scans with GCash / any QR Ph app.
   * @see https://developers.paymongo.com/docs/qr-ph-api
   */
  async createPayMongoQrForOwner(actor, consultationId) {
    await this.ensureTable();
    const paymongoService = require('./paymongoService');
    if (!paymongoService.isConfigured()) {
      const err = new Error(
        'PayMongo is not configured. Set PAYMONGO_SECRET_KEY in the server environment (see .env.example).'
      );
      err.status = 503;
      throw err;
    }

    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id, concern_title, amount_php, platform_fee_percent, payment_status, status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];
    if (c.user_id !== actor.userId) throw new Error('Not allowed');
    if (c.status !== 'awaiting_payment') {
      throw new Error('Consultation is not awaiting payment');
    }
    const pay = c.payment_status || 'unpaid';
    if (pay === 'verified') throw new Error('Already paid');
    if (pay === 'pending_review') {
      throw new Error('Payment proof is already pending admin review. Wait for a decision or contact support.');
    }

    const amountPhp = c.amount_php != null ? Number(c.amount_php) : DEFAULT_CONSULTATION_PHP;
    const split = this.calculateSplit(
      amountPhp,
      c.platform_fee_percent != null ? Number(c.platform_fee_percent) : PLATFORM_FEE_PERCENT
    );
    let centavos = Math.round(split.grossAmountPhp * 100);
    /** PayMongo PaymentIntent minimum (see API docs; typically ₱20.00). */
    const minCentavos = 2000;
    if (centavos < minCentavos) {
      throw new Error(`Amount must be at least ₱${(minCentavos / 100).toFixed(2)} for QR Ph payments`);
    }

    const title = String(c.concern_title || 'Consultation').slice(0, 255);
    const pi = await paymongoService.createPaymentIntentQrPh({
      amount: centavos,
      description: `Hairvelous · ${title}`,
      metadata: {
        consultation_id: String(id),
        user_id: String(actor.userId),
      },
    });

    const piId = pi.id;
    const pm = await paymongoService.createQrPhPaymentMethod({
      name: actor.name || 'Customer',
      email: actor.email || 'customer@example.com',
    });

    const attached = await paymongoService.attachPaymentMethodToIntent(piId, pm.id);
    const attrs = attached.attributes || {};
    const imageUrl =
      attrs.next_action &&
      attrs.next_action.code &&
      attrs.next_action.code.image_url
        ? attrs.next_action.code.image_url
        : null;

    if (!imageUrl) {
      throw new Error('PayMongo did not return a QR Ph image. Check QR Ph is enabled on your merchant account.');
    }

    await pool.query(
      `UPDATE consultations SET paymongo_payment_intent_id = ?, paymongo_checkout_session_id = NULL WHERE consultation_id = ?`,
      [piId, id]
    );

    return {
      consultationId: id,
      paymentIntentId: piId,
      qrImageUrl: imageUrl,
      expiresInMinutes: 30,
    };
  }

  /**
   * Sync payment status from PayMongo (e.g. if webhook was missed). Safe to poll from the client.
   */
  async syncPayMongoPaymentIntentForOwner(actor, consultationId) {
    await this.ensureTable();
    const paymongoService = require('./paymongoService');
    if (!paymongoService.isConfigured()) {
      const err = new Error('PayMongo is not configured');
      err.status = 503;
      throw err;
    }
    const id = Number(consultationId);
    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, paymongo_payment_intent_id, amount_php, payment_status, status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];
    if (c.user_id !== actor.userId) throw new Error('Not allowed');
    if (!c.paymongo_payment_intent_id) {
      return { consultationId: id, synced: false, reason: 'no_qr_session' };
    }
    if (c.payment_status === 'verified') {
      return { consultationId: id, synced: true, paid: true };
    }

    const live = await paymongoService.retrievePaymentIntent(c.paymongo_payment_intent_id);
    const st = live.attributes && live.attributes.status;
    const amount = live.attributes && live.attributes.amount;
    if (st === 'succeeded') {
      await this.markPaidViaPayMongo(id, {
        paymentIntentId: c.paymongo_payment_intent_id,
        paidAmountCentavos: amount != null ? Number(amount) : null,
        metadataUserId: Number(actor.userId),
      });
      return { consultationId: id, synced: true, paid: true };
    }
    return { consultationId: id, synced: true, paid: false, intentStatus: st };
  }

  /**
   * Called from PayMongo webhook when checkout_session.payment.paid fires.
   */
  async markPaidViaPayMongo(consultationId, opts = {}) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id)) throw new Error('Invalid consultation ID');

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id, concern_title, amount_php, payment_status, status,
              paymongo_checkout_session_id, paymongo_payment_intent_id
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];

    if (opts.metadataUserId != null && Number(opts.metadataUserId) !== Number(c.user_id)) {
      throw new Error('metadata user_id does not match consultation owner');
    }

    const split = this.calculateSplit(
      Number(c.amount_php != null ? c.amount_php : DEFAULT_CONSULTATION_PHP),
      Number(c.platform_fee_percent != null ? c.platform_fee_percent : PLATFORM_FEE_PERCENT)
    );
    const expectedCentavos = Math.round(split.grossAmountPhp * 100);
    if (opts.paidAmountCentavos != null && Number(opts.paidAmountCentavos) !== expectedCentavos) {
      throw new Error(
        `PayMongo amount mismatch: expected ${expectedCentavos} centavos, webhook had ${opts.paidAmountCentavos}`
      );
    }

    if (
      opts.checkoutSessionId &&
      c.paymongo_checkout_session_id &&
      String(c.paymongo_checkout_session_id) !== String(opts.checkoutSessionId)
    ) {
      throw new Error('Checkout session id does not match this consultation');
    }
    if (
      opts.paymentIntentId &&
      c.paymongo_payment_intent_id &&
      String(c.paymongo_payment_intent_id) !== String(opts.paymentIntentId)
    ) {
      throw new Error('Payment intent id does not match this consultation');
    }

    if (c.payment_status === 'verified') {
      return { consultationId: id, alreadyPaid: true };
    }
    if (c.status !== 'awaiting_payment') {
      throw new Error('Consultation is not awaiting payment');
    }

    const ref = opts.paymentIntentId
      ? `paymongo:pi:${opts.paymentIntentId}`
      : `paymongo:${opts.checkoutSessionId || 'paid'}`;
    const [result] = await pool.query(
      `UPDATE consultations SET
         payment_status = 'verified',
         status = 'scheduled',
         scheduled_at = COALESCE(scheduled_at, NOW()),
         paid_verified_at = CURRENT_TIMESTAMP,
         verified_by_admin_user_id = NULL,
         payment_reference = ?
       WHERE consultation_id = ?
         AND status = 'awaiting_payment'
         AND payment_status IN ('unpaid', 'rejected', 'pending_review')`,
      [ref, id]
    );

    if (!result.affectedRows) {
      return { consultationId: id, skipped: true };
    }

    await this.releaseConsultationEarning(id);

    await notificationService.createForUser(c.user_id, {
      type: 'payment_verified',
      title: 'Payment confirmed',
      message: `"${c.concern_title}" is paid. You can message your specialist now.`,
      linkUrl: `/consultations.html?chat=${id}`,
    });
    if (c.specialist_user_id) {
      await notificationService.createForUser(c.specialist_user_id, {
        type: 'payment_verified',
        title: 'Consultation paid',
        message: `"${c.concern_title}" was paid via PayMongo.`,
        linkUrl: `/consultations.html?chat=${id}`,
      });
    }

    return { consultationId: id, verified: true };
  }

  async getSpecialistRevenue(actor) {
    await this.ensureTable();
    if (actor.roleName !== 'specialist') {
      const e = new Error('Specialist access only');
      e.status = 403;
      throw e;
    }
    const specialistId = Number(actor.userId);
    const [totalsRows] = await pool.query(
      `SELECT
         COALESCE(SUM(el.gross_amount_php), 0) AS gross_total,
         COALESCE(SUM(el.commission_amount_php), 0) AS commission_total,
         COALESCE(SUM(el.net_amount_php), 0) AS net_total,
         COALESCE(SUM(CASE WHEN el.status = 'released' THEN el.net_amount_php ELSE 0 END), 0) AS available_now
       FROM specialist_earnings_ledger el
       JOIN consultations c ON c.consultation_id = el.consultation_id
       WHERE el.specialist_user_id = ?
         AND c.status = 'completed'
         AND c.payment_status = 'verified'`,
      [specialistId]
    );
    const [recentRows] = await pool.query(
      `SELECT el.earning_id, el.consultation_id, el.gross_amount_php, el.commission_percent, el.commission_amount_php, el.net_amount_php, el.status, el.released_at, el.payout_paid_at
       FROM specialist_earnings_ledger el
       JOIN consultations c ON c.consultation_id = el.consultation_id
       WHERE el.specialist_user_id = ?
         AND c.status = 'completed'
         AND c.payment_status = 'verified'
       ORDER BY el.released_at DESC
       LIMIT 100`,
      [specialistId]
    );
    const [latestPayoutRows] = await pool.query(
      `SELECT requested_at
       FROM specialist_payout_requests
       WHERE specialist_user_id = ? AND status IN ('requested','approved','paid')
       ORDER BY requested_at DESC
       LIMIT 1`,
      [specialistId]
    );
    const [payoutRows] = await pool.query(
      `SELECT payout_request_id, period_start, period_end, gross_amount_php, commission_amount_php, net_amount_php,
              item_count, status, requested_at, processed_at
       FROM specialist_payout_requests
       WHERE specialist_user_id = ?
       ORDER BY requested_at DESC
       LIMIT 30`,
      [specialistId]
    );
    const latest = latestPayoutRows[0] ? new Date(latestPayoutRows[0].requested_at) : null;
    const now = new Date();
    const nextEligibleAt = latest ? new Date(latest.getTime() + SPECIALIST_PAYOUT_INTERVAL_DAYS * 24 * 60 * 60 * 1000) : now;
    return {
      totals: {
        grossPhp: Number(totalsRows[0]?.gross_total || 0),
        commissionPhp: Number(totalsRows[0]?.commission_total || 0),
        netPhp: Number(totalsRows[0]?.net_total || 0),
        availableNowPhp: Number(totalsRows[0]?.available_now || 0),
      },
      nextPayoutEligibleAt: nextEligibleAt,
      payoutIntervalDays: SPECIALIST_PAYOUT_INTERVAL_DAYS,
      ledger: (recentRows || []).map((r) => ({
        earningId: r.earning_id,
        consultationId: r.consultation_id,
        grossPhp: Number(r.gross_amount_php),
        commissionPercent: Number(r.commission_percent),
        commissionPhp: Number(r.commission_amount_php),
        netPhp: Number(r.net_amount_php),
        status: r.status,
        releasedAt: r.released_at,
        payoutPaidAt: r.payout_paid_at,
      })),
      payoutRequests: (payoutRows || []).map((r) => ({
        payoutRequestId: r.payout_request_id,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        grossPhp: Number(r.gross_amount_php || 0),
        commissionPhp: Number(r.commission_amount_php || 0),
        netPhp: Number(r.net_amount_php || 0),
        itemCount: Number(r.item_count || 0),
        status: r.status,
        requestedAt: r.requested_at,
        processedAt: r.processed_at,
      })),
    };
  }

  async requestSpecialistPayout(actor) {
    await this.ensureTable();
    if (actor.roleName !== 'specialist') {
      const e = new Error('Specialist access only');
      e.status = 403;
      throw e;
    }
    const specialistId = Number(actor.userId);
    const [latestRows] = await pool.query(
      `SELECT requested_at
       FROM specialist_payout_requests
       WHERE specialist_user_id = ? AND status IN ('requested','approved','paid')
       ORDER BY requested_at DESC
       LIMIT 1`,
      [specialistId]
    );
    if (latestRows.length) {
      const lastRequestedAt = new Date(latestRows[0].requested_at);
      const minNextAt = new Date(lastRequestedAt.getTime() + SPECIALIST_PAYOUT_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
      if (Date.now() < minNextAt.getTime()) {
        throw new Error(`Payout requests are allowed every ${SPECIALIST_PAYOUT_INTERVAL_DAYS} days. Next eligible date: ${minNextAt.toISOString().slice(0, 10)}`);
      }
    }
    const [ledgerRows] = await pool.query(
      `SELECT el.earning_id, el.consultation_id, el.gross_amount_php, el.commission_amount_php, el.net_amount_php, el.released_at
       FROM specialist_earnings_ledger el
       JOIN consultations c ON c.consultation_id = el.consultation_id
       WHERE el.specialist_user_id = ?
         AND el.status = 'released'
         AND c.status = 'completed'
         AND c.payment_status = 'verified'
       ORDER BY el.released_at ASC`,
      [specialistId]
    );
    if (!ledgerRows.length) {
      throw new Error('No released earnings available for payout');
    }
    const sums = ledgerRows.reduce(
      (acc, row) => {
        acc.gross += Number(row.gross_amount_php || 0);
        acc.commission += Number(row.commission_amount_php || 0);
        acc.net += Number(row.net_amount_php || 0);
        return acc;
      },
      { gross: 0, commission: 0, net: 0 }
    );
    const periodStart = ledgerRows[0].released_at;
    const periodEnd = ledgerRows[ledgerRows.length - 1].released_at;
    const [insert] = await pool.query(
      `INSERT INTO specialist_payout_requests
         (specialist_user_id, period_start, period_end, gross_amount_php, commission_amount_php, net_amount_php, item_count, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', NOW())`,
      [specialistId, periodStart, periodEnd, sums.gross, sums.commission, sums.net, ledgerRows.length]
    );
    const payoutRequestId = insert.insertId;
    const earningIds = ledgerRows.map((r) => Number(r.earning_id)).filter((n) => Number.isFinite(n));
    const placeholders = earningIds.map(() => '?').join(',');
    await pool.query(
      `UPDATE specialist_earnings_ledger
       SET status = 'in_payout', payout_request_id = ?
       WHERE specialist_user_id = ?
         AND earning_id IN (${placeholders})`,
      [payoutRequestId, specialistId, ...earningIds]
    );
    await notificationService.createForRoles(
      ['admin'],
      {
        type: 'payout_request',
        title: 'New specialist payout request',
        message: `${actor.name || 'A specialist'} requested payout #${payoutRequestId} for ₱${(
          Math.round(sums.net * 100) / 100
        ).toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
        linkUrl: '/admin_dashboard.html',
      },
      specialistId
    );
    return {
      payoutRequestId,
      requested: true,
      totals: {
        grossPhp: Math.round(sums.gross * 100) / 100,
        commissionPhp: Math.round(sums.commission * 100) / 100,
        netPhp: Math.round(sums.net * 100) / 100,
        itemCount: ledgerRows.length,
      },
    };
  }

  async getAdminTransactionReport(actor) {
    await this.ensureTable();
    if (!isModerator(actor) && actor.roleName !== 'admin') {
      const e = new Error('Admin access only');
      e.status = 403;
      throw e;
    }
    const [rows] = await pool.query(
      `SELECT c.consultation_id, c.concern_title, c.status, c.payment_status, c.amount_php, c.platform_fee_percent,
              c.paid_verified_at, c.completed_at,
              u.name AS user_name, u.email AS user_email,
              s.name AS specialist_name, s.email AS specialist_email,
              el.earning_id, el.gross_amount_php, el.commission_amount_php, el.net_amount_php, el.status AS earning_status,
              pr.payout_request_id, pr.status AS payout_status, pr.requested_at AS payout_requested_at
       FROM consultations c
       JOIN users u ON u.user_id = c.user_id
       LEFT JOIN users s ON s.user_id = c.specialist_user_id
       LEFT JOIN specialist_earnings_ledger el ON el.consultation_id = c.consultation_id
       LEFT JOIN specialist_payout_requests pr ON pr.payout_request_id = el.payout_request_id
       WHERE c.payment_status = 'verified'
       ORDER BY COALESCE(c.paid_verified_at, c.completed_at, c.updated_at) DESC, c.consultation_id DESC
       LIMIT 500`
    );
    return {
      transactions: (rows || []).map((r) => {
        const amountPhp = r.amount_php != null ? Number(r.amount_php) : null;
        const feePercent =
          r.platform_fee_percent != null ? Number(r.platform_fee_percent) : Number(PLATFORM_FEE_PERCENT || 0);
        const fallbackSplit = this.calculateSplit(
          amountPhp != null ? amountPhp : DEFAULT_CONSULTATION_PHP,
          feePercent
        );
        const grossPhp = r.gross_amount_php != null ? Number(r.gross_amount_php) : fallbackSplit.grossAmountPhp;
        const commissionPhp =
          r.commission_amount_php != null ? Number(r.commission_amount_php) : fallbackSplit.commissionAmountPhp;
        const specialistNetPhp =
          r.net_amount_php != null ? Number(r.net_amount_php) : fallbackSplit.netAmountPhp;
        return {
          consultationId: r.consultation_id,
          concernTitle: r.concern_title,
          consultationStatus: r.status,
          paymentStatus: r.payment_status,
          clientName: r.user_name,
          clientEmail: r.user_email,
          specialistName: r.specialist_name,
          specialistEmail: r.specialist_email,
          amountPhp,
          platformFeePercent: feePercent,
          paidVerifiedAt: r.paid_verified_at,
          completedAt: r.completed_at,
          earningId: r.earning_id || null,
          grossPhp,
          commissionPhp,
          specialistNetPhp,
          earningStatus: r.earning_status || null,
          payoutRequestId: r.payout_request_id || null,
          payoutStatus: r.payout_status || null,
          payoutRequestedAt: r.payout_requested_at || null,
        };
      }),
    };
  }

  async listPayoutRequests(actor) {
    await this.ensureTable();
    if (!isModerator(actor) && actor.roleName !== 'admin') {
      const e = new Error('Admin access only');
      e.status = 403;
      throw e;
    }
    const [rows] = await pool.query(
      `SELECT pr.payout_request_id, pr.specialist_user_id, s.name AS specialist_name, s.email AS specialist_email,
              pr.period_start, pr.period_end, pr.gross_amount_php, pr.commission_amount_php, pr.net_amount_php,
              pr.item_count, pr.status, pr.requested_at, pr.processed_at, pr.admin_note
       FROM specialist_payout_requests pr
       JOIN users s ON s.user_id = pr.specialist_user_id
       ORDER BY pr.requested_at DESC
       LIMIT 300`
    );
    return {
      payoutRequests: (rows || []).map((r) => ({
        payoutRequestId: r.payout_request_id,
        specialistUserId: r.specialist_user_id,
        specialistName: r.specialist_name,
        specialistEmail: r.specialist_email,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        grossPhp: Number(r.gross_amount_php || 0),
        commissionPhp: Number(r.commission_amount_php || 0),
        netPhp: Number(r.net_amount_php || 0),
        itemCount: Number(r.item_count || 0),
        status: r.status,
        requestedAt: r.requested_at,
        processedAt: r.processed_at,
        adminNote: r.admin_note || null,
      })),
    };
  }

  async processPayoutRequest(actor, payoutRequestId, payload) {
    await this.ensureTable();
    if (!isModerator(actor) && actor.roleName !== 'admin') {
      const e = new Error('Admin access only');
      e.status = 403;
      throw e;
    }
    const id = Number(payoutRequestId);
    if (!Number.isFinite(id)) throw new Error('Invalid payout request ID');
    const action = String((payload && payload.action) || '').trim().toLowerCase();
    if (!['approve', 'paid', 'reject'].includes(action)) {
      throw new Error('Invalid payout action');
    }
    const note = payload && payload.note != null ? String(payload.note).trim() : null;
    const [rows] = await pool.query(
      `SELECT payout_request_id, specialist_user_id, status
       FROM specialist_payout_requests
       WHERE payout_request_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Payout request not found');
    const row = rows[0];
    const current = String(row.status || '');

    if (action === 'approve') {
      if (current !== 'requested') throw new Error('Only requested payouts can be approved');
      await pool.query(
        `UPDATE specialist_payout_requests
         SET status = 'approved', processed_at = NOW(), processed_by_user_id = ?, admin_note = ?
         WHERE payout_request_id = ?`,
        [actor.userId, note, id]
      );
      await notificationService.createForUser(row.specialist_user_id, {
        type: 'payout_update',
        title: 'Payout request approved',
        message: note
          ? `Your payout request #${id} was approved. Admin note: ${note}`
          : `Your payout request #${id} was approved and is now being processed.`,
        linkUrl: '/consultations.html',
      });
      return { payoutRequestId: id, status: 'approved' };
    }

    if (action === 'reject') {
      if (current !== 'requested' && current !== 'approved') {
        throw new Error('Only requested/approved payouts can be rejected');
      }
      await pool.query(
        `UPDATE specialist_payout_requests
         SET status = 'rejected', processed_at = NOW(), processed_by_user_id = ?, admin_note = ?
         WHERE payout_request_id = ?`,
        [actor.userId, note, id]
      );
      await pool.query(
        `UPDATE specialist_earnings_ledger
         SET status = 'released', payout_request_id = NULL
         WHERE payout_request_id = ? AND status = 'in_payout'`,
        [id]
      );
      await notificationService.createForUser(row.specialist_user_id, {
        type: 'payout_update',
        title: 'Payout request rejected',
        message: note
          ? `Your payout request #${id} was rejected. Admin note: ${note}`
          : `Your payout request #${id} was rejected. Please contact admin for details.`,
        linkUrl: '/consultations.html',
      });
      return { payoutRequestId: id, status: 'rejected' };
    }

    if (current !== 'approved' && current !== 'requested') {
      throw new Error('Only requested/approved payouts can be marked paid');
    }
    await pool.query(
      `UPDATE specialist_payout_requests
       SET status = 'paid', processed_at = NOW(), processed_by_user_id = ?, admin_note = ?
       WHERE payout_request_id = ?`,
      [actor.userId, note, id]
    );
    await pool.query(
      `UPDATE specialist_earnings_ledger
       SET status = 'paid_out', payout_paid_at = NOW()
       WHERE payout_request_id = ? AND status = 'in_payout'`,
      [id]
    );
    await notificationService.createForUser(row.specialist_user_id, {
      type: 'payout_update',
      title: 'Payout marked as paid',
      message: note
        ? `Your payout request #${id} was marked as paid. Admin note: ${note}`
        : `Your payout request #${id} was marked as paid.`,
      linkUrl: '/consultations.html',
    });
    return { payoutRequestId: id, status: 'paid' };
  }

  async submitFeedback(actor, consultationId, payload) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid consultation ID');
    const rating = Number(payload && payload.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5 stars');
    }
    const feedbackText =
      payload && payload.feedbackText != null ? String(payload.feedbackText).trim() : '';

    const [rows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id, status
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!rows.length) throw new Error('Consultation not found');
    const c = rows[0];
    if (Number(c.user_id) !== Number(actor.userId)) throw new Error('Only the client can submit feedback');
    if (!c.specialist_user_id) throw new Error('No specialist assigned for this consultation');
    if (String(c.status || '') !== 'completed') {
      throw new Error('You can submit feedback after consultation completion');
    }

    await pool.query(
      `INSERT INTO consultation_feedback
         (consultation_id, user_id, specialist_user_id, rating, feedback_text)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         rating = VALUES(rating),
         feedback_text = VALUES(feedback_text)`,
      [id, actor.userId, c.specialist_user_id, Math.round(rating), feedbackText || null]
    );

    await notificationService.createForUser(c.specialist_user_id, {
      type: 'consultation_feedback',
      title: 'New consultation feedback',
      message: `${actor.name || 'A client'} left a ${Math.round(rating)}-star rating.`,
      linkUrl: `/consultations.html?chat=${id}`,
    });

    return { consultationId: id, saved: true };
  }

  async getFeedback(actor, consultationId) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid consultation ID');
    const [consultRows] = await pool.query(
      `SELECT consultation_id, user_id, specialist_user_id
       FROM consultations WHERE consultation_id = ?`,
      [id]
    );
    if (!consultRows.length) throw new Error('Consultation not found');
    const c = consultRows[0];
    const isOwner = Number(c.user_id) === Number(actor.userId);
    const isSpec = Number(c.specialist_user_id) === Number(actor.userId) && actor.roleName === 'specialist';
    if (!isOwner && !isSpec && !isModerator(actor)) throw new Error('Not allowed');

    const [rows] = await pool.query(
      `SELECT feedback_id, rating, feedback_text, created_at, updated_at
       FROM consultation_feedback
       WHERE consultation_id = ? AND user_id = ?
       LIMIT 1`,
      [id, c.user_id]
    );
    const row = rows[0] || null;
    if (!row) return { consultationId: id, feedback: null };
    return {
      consultationId: id,
      feedback: {
        feedbackId: row.feedback_id,
        rating: Number(row.rating),
        feedbackText: row.feedback_text || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  }

  async getSpecialistFeedbackSummaries(specialistIds) {
    await this.ensureTable();
    const ids = Array.isArray(specialistIds)
      ? specialistIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (!ids.length) return { summaries: {} };
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT specialist_user_id, ROUND(AVG(rating), 2) AS avg_rating, COUNT(*) AS total_reviews
       FROM consultation_feedback
       WHERE specialist_user_id IN (${placeholders})
       GROUP BY specialist_user_id`,
      ids
    );
    const [feedbackRows] = await pool.query(
      `SELECT cf.specialist_user_id, cf.rating, cf.feedback_text, cf.created_at, u.name AS client_name
       FROM consultation_feedback cf
       JOIN users u ON u.user_id = cf.user_id
       WHERE cf.specialist_user_id IN (${placeholders})
         AND cf.feedback_text IS NOT NULL
         AND TRIM(cf.feedback_text) <> ''
       ORDER BY cf.created_at DESC`,
      ids
    );
    const summaries = {};
    ids.forEach((specId) => {
      summaries[specId] = { avgRating: null, totalReviews: 0, recentFeedbacks: [] };
    });
    rows.forEach((r) => {
      summaries[r.specialist_user_id] = {
        avgRating: r.avg_rating != null ? Number(r.avg_rating) : null,
        totalReviews: Number(r.total_reviews || 0),
        recentFeedbacks: summaries[r.specialist_user_id]
          ? summaries[r.specialist_user_id].recentFeedbacks
          : [],
      };
    });
    feedbackRows.forEach((r) => {
      const sid = Number(r.specialist_user_id);
      if (!summaries[sid]) return;
      if (summaries[sid].recentFeedbacks.length >= 2) return;
      summaries[sid].recentFeedbacks.push({
        rating: r.rating != null ? Number(r.rating) : null,
        feedbackText: String(r.feedback_text || '').trim(),
        clientName: String(r.client_name || '').trim() || 'Client',
        createdAt: r.created_at,
      });
    });
    return { summaries };
  }

  async getSpecialistFeedbackList(specialistUserId, limit = 20) {
    await this.ensureTable();
    const sid = Number(specialistUserId);
    if (!Number.isFinite(sid) || sid <= 0) {
      const err = new Error('Invalid specialist ID');
      err.status = 400;
      throw err;
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const [rows] = await pool.query(
      `SELECT cf.feedback_id, cf.rating, cf.feedback_text, cf.created_at, u.name AS client_name
       FROM consultation_feedback cf
       JOIN users u ON u.user_id = cf.user_id
       WHERE cf.specialist_user_id = ?
       ORDER BY cf.created_at DESC
       LIMIT ?`,
      [sid, safeLimit]
    );
    return {
      specialistUserId: sid,
      feedbacks: (rows || []).map((r) => ({
        feedbackId: r.feedback_id,
        rating: r.rating != null ? Number(r.rating) : null,
        feedbackText: String(r.feedback_text || '').trim(),
        clientName: String(r.client_name || '').trim() || 'Client',
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * Dashboard analytics for assigned specialist (own consultations only).
   */
  async getSpecialistAnalytics(specialistUserId) {
    await this.ensureTable();
    const sid = Number(specialistUserId);
    if (!Number.isFinite(sid) || sid <= 0) {
      return { statusCounts: [], clients: [], monthly: [], totals: {} };
    }

    const [statusCounts] = await pool.query(
      `SELECT c.status, COUNT(*) AS cnt
       FROM consultations c
       WHERE c.specialist_user_id = ?
       GROUP BY c.status`,
      [sid]
    );

    const [[clientAgg]] = await pool.query(
      `SELECT COUNT(DISTINCT c.user_id) AS distinctClients,
              COUNT(*) AS totalConsultations,
              COUNT(DISTINCT CASE WHEN c.payment_status = 'verified' THEN c.user_id END) AS paidClients
       FROM consultations c
       WHERE c.specialist_user_id = ?`,
      [sid]
    );

    const [clients] = await pool.query(
      `SELECT c.user_id AS userId, u.name, u.email,
              MAX(c.created_at) AS lastConsultAt,
              COUNT(*) AS consultationCount,
              SUM(CASE WHEN c.payment_status = 'verified' THEN 1 ELSE 0 END) AS paidConsultationCount,
              MAX(CASE WHEN c.payment_status = 'verified' THEN 1 ELSE 0 END) AS hasPaid
       FROM consultations c
       JOIN users u ON u.user_id = c.user_id
       WHERE c.specialist_user_id = ?
       GROUP BY c.user_id, u.name, u.email
       ORDER BY lastConsultAt DESC
       LIMIT 200`,
      [sid]
    );

    const [monthly] = await pool.query(
      `SELECT DATE_FORMAT(c.created_at, '%Y-%m') AS ym, COUNT(*) AS cnt
       FROM consultations c
       WHERE c.specialist_user_id = ?
         AND c.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY ym
       ORDER BY ym ASC`,
      [sid]
    );

    return {
      totals: {
        distinctClients: Number(clientAgg.distinctClients || 0),
        totalConsultations: Number(clientAgg.totalConsultations || 0),
        paidClients: Number(clientAgg.paidClients || 0),
      },
      statusCounts: (statusCounts || []).map((r) => ({
        status: r.status,
        count: Number(r.cnt || 0),
      })),
      clients: (clients || []).map((r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        lastConsultAt: r.lastConsultAt,
        consultationCount: Number(r.consultationCount || 0),
        paidConsultationCount: Number(r.paidConsultationCount || 0),
        hasPaid: Number(r.hasPaid || 0) > 0,
      })),
      monthly: (monthly || []).map((r) => ({
        month: r.ym,
        count: Number(r.cnt || 0),
      })),
    };
  }

  /**
   * Hair profile summary for the client in a consultation (assigned specialist or moderator).
   */
  async getClientConsultSummary(actor, consultationId) {
    await this.ensureTable();
    const id = Number(consultationId);
    if (!Number.isFinite(id) || id <= 0) {
      const e = new Error('Invalid consultation ID');
      e.status = 400;
      throw e;
    }

    const [rows] = await pool.query(
      `SELECT c.consultation_id, c.user_id, c.specialist_user_id, u.name AS user_name, u.email AS user_email
       FROM consultations c
       JOIN users u ON u.user_id = c.user_id
       WHERE c.consultation_id = ?`,
      [id]
    );
    if (!rows.length) {
      const e = new Error('Consultation not found');
      e.status = 404;
      throw e;
    }
    const row = rows[0];
    const canSee =
      isModerator(actor) ||
      (actor.roleName === 'specialist' && Number(row.specialist_user_id) === Number(actor.userId));
    if (!canSee) {
      const e = new Error('Not allowed');
      e.status = 403;
      throw e;
    }

    const [hpRows] = await pool.query(
      `SELECT hair_type, scalp_condition, issues_detected, last_updated
       FROM hair_profiles WHERE user_id = ?
       ORDER BY last_updated DESC LIMIT 1`,
      [row.user_id]
    );
    let hp = hpRows[0] || null;
    const hpHasData =
      !!hp &&
      (String(hp.hair_type || '').trim() ||
        String(hp.scalp_condition || '').trim() ||
        String(hp.issues_detected || '').trim());
    if (!hpHasData) {
      try {
        const assessmentService = require('./assessmentService');
        const latest = await assessmentService.getLatestResults(row.user_id);
        if (latest) {
          const issues = Array.isArray(latest.issuesDetected) ? latest.issuesDetected.filter(Boolean).join(', ') : '';
          hp = {
            hair_type: latest.hairType || null,
            scalp_condition: latest.scalpCondition || null,
            issues_detected: issues || null,
            last_updated: new Date().toISOString(),
          };
        }
      } catch (_fallbackErr) {
        // Keep null if no assessment fallback is available.
      }
    }

    return {
      consultationId: id,
      client: {
        userId: row.user_id,
        name: row.user_name,
        email: row.user_email,
      },
      hairProfile: hp
        ? {
            hairType: hp.hair_type,
            scalpCondition: hp.scalp_condition,
            issuesDetected: hp.issues_detected,
            lastUpdated: hp.last_updated,
          }
        : null,
    };
  }

  /**
   * Specialist may read a client's routine only if:
   * - They are the assigned specialist on at least one consultation with that client after accept
   *   (awaiting_payment, scheduled, in_progress, completed), and
   * - The client enabled share_routine_with_specialist on their profile.
   */
  async canSpecialistViewClientRoutine(actor, clientUserId) {
    await this.ensureTable();
    const profileService = require('./profileService');
    await profileService.ensureProfileColumns();
    if (!actor || actor.roleName !== 'specialist') {
      return { ok: false, reason: 'not_specialist' };
    }
    const clientId = Number(clientUserId);
    if (!Number.isFinite(clientId) || clientId <= 0) {
      return { ok: false, reason: 'invalid_client' };
    }
    if (Number(clientId) === Number(actor.userId)) {
      return { ok: false, reason: 'self' };
    }
    const [consRows] = await pool.query(
      `SELECT COUNT(*) AS c
       FROM consultations
       WHERE specialist_user_id = ?
         AND user_id = ?
         AND status IN ('awaiting_payment','scheduled','in_progress','completed')`,
      [actor.userId, clientId]
    );
    const linked = Number((consRows[0] && consRows[0].c) || 0) > 0;
    if (!linked) {
      return { ok: false, reason: 'no_accepted_consultation' };
    }
    const [profRows] = await pool.query(
      'SELECT share_routine_with_specialist FROM user_profiles WHERE user_id = ? LIMIT 1',
      [clientId]
    );
    const consent =
      profRows.length > 0 && Number(profRows[0].share_routine_with_specialist) === 1;
    if (!consent) {
      return { ok: false, reason: 'consent_required' };
    }
    return { ok: true };
  }
}

module.exports = new ConsultationService();
