/**
 * Recommendation Service - Rule-Based Engine
 * Location: backend/services/recommendationService.js
 * Purpose: Comprehensive rule-based product recommendations with routine plans
 */
const pool = require('../config/db');
const MAX_RECOMMENDED_RESULTS = (() => {
  const n = Number(process.env.MAX_RECOMMENDED_RESULTS || 20);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
})();

/** GROUP_CONCAT returns a string, but follow-up code may pass an array — never call .split on non-strings. */
function parseCategoryList(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((c) => String(c).trim()).filter(Boolean);
  if (Buffer.isBuffer && Buffer.isBuffer(raw)) return parseCategoryList(String(raw));
  const s = typeof raw === 'string' ? raw : String(raw);
  return s.split(',').map((c) => c.trim()).filter(Boolean);
}

/** Map UI assessment strings (e.g. "Visible flaking / dandruff") to categoryMap keys. */
function mapIssueToCategoryKey(issue) {
  if (issue == null) return null;
  const s = String(issue).toLowerCase();
  if (s.includes('thinning') || s.includes('hair fall') || s.includes('hairfall')) return null;
  if (s.includes('flak') || s.includes('dandruff')) return 'flaking';
  if (s.includes('oil') || s.includes('greas')) return 'oiliness';
  if (s.includes('frizz')) return 'frizz';
  if (s.includes('dry') || s.includes('brittle') || s.includes('dull') || s.includes('rough')) return 'dryness';
  if (s.includes('breakage') || s.includes('split end')) return 'dryness';
  return null;
}

function normalizeHairType(ht) {
  if (ht == null || ht === '') return null;
  const s = String(ht).toLowerCase();
  if (s.includes('coily') || s.includes('kinky')) return 'coily';
  if (s.includes('curly')) return 'curly';
  if (s.includes('wavy')) return 'wavy';
  if (s.includes('straight')) return 'straight';
  return s.trim() || null;
}

/** Values compatible with scoreProduct scalp checks (lowercase keywords). */
function normalizeScalpCondition(sc) {
  if (sc == null || sc === '') return null;
  const s = String(sc).toLowerCase();
  if (s.includes('eczema') || s.includes('dermatitis')) return 'eczema';
  if (s.includes('sensitive') || s.includes('irritated')) return 'sensitive';
  if (s.includes('combination')) return 'combination';
  if (s.includes('oily') && !s.includes('dry end')) return 'oily';
  if (s.includes('dry') || s.includes('flak')) return 'dry';
  if (s.includes('normal')) return 'normal';
  return s.split(/[\/,]/)[0].trim() || null;
}

class RecommendationService {
  constructor() {
    this._recommendationsTableReady = false;
    this._hairProfilesTableReady = false;
  }

  /**
   * Persisted product picks (used after assessment + /assessments/latest/results).
   * Some DBs were provisioned without this table from schema_hairvelous.sql.
   */
  async ensureRecommendationsTable() {
    if (this._recommendationsTableReady) return;
    if (process.env.SKIP_DB_FOR_TESTING === 'true') {
      this._recommendationsTableReady = true;
      return;
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recommendations (
        rec_id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        product_id INT NOT NULL,
        reason TEXT NULL,
        date_recommended TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_product_id (product_id),
        INDEX idx_date_recommended (date_recommended),
        CONSTRAINT fk_rec_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_rec_product FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB
    `);
    this._recommendationsTableReady = true;
  }

  async ensureHairProfilesTable() {
    if (this._hairProfilesTableReady) return;
    if (process.env.SKIP_DB_FOR_TESTING === 'true') {
      this._hairProfilesTableReady = true;
      return;
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hair_profiles (
        profile_id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        hair_type VARCHAR(100) NULL,
        scalp_condition VARCHAR(100) NULL,
        issues_detected TEXT NULL,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_last_updated (last_updated),
        CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB
    `);
    this._hairProfilesTableReady = true;
  }

  async ensureProductColumns() {
    const tryAlter = async (sql) => {
      try {
        await pool.query(sql);
      } catch (err) {
        if (err && (err.code === 'ER_DUP_FIELDNAME' || err.errno === 1060)) return;
        throw err;
      }
    };
    await tryAlter('ALTER TABLE products ADD COLUMN image_url VARCHAR(500) NULL');
    await tryAlter("ALTER TABLE products ADD COLUMN expiry_type ENUM('not_applicable','date','period_after_opening') NOT NULL DEFAULT 'not_applicable'");
    await tryAlter('ALTER TABLE products ADD COLUMN expiry_date DATE NULL');
    await tryAlter('ALTER TABLE products ADD COLUMN expiry_period_months INT NULL');
  }

  async ensureProductCategoryTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_categories (
        category_id INT PRIMARY KEY AUTO_INCREMENT,
        product_id INT NOT NULL,
        category_name VARCHAR(120) NOT NULL,
        INDEX idx_product_id (product_id),
        INDEX idx_category_name (category_name),
        CONSTRAINT fk_product_category_product
          FOREIGN KEY (product_id) REFERENCES products(product_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB
    `);
  }

  /**
   * Generate comprehensive recommendations based on user profile and preferences
   * @param {Object} profile - User hair profile
   * @param {Object} preferences - User preferences (budget, productType)
   * @returns {Object} Recommendations with products, routine plan, warnings, DIY guides
   */
  async generateRecommendations(profile, preferences = {}) {
    await this.ensureProductColumns();
    await this.ensureProductCategoryTable();
    if (process.env.SKIP_DB_FOR_TESTING !== 'true') {
      const billingService = require('./billingService');
      await billingService.ensureDiyGuidesAddonColumns();
    }

    const {
      hairType: rawHairType = null,
      scalpCondition: rawScalp = null,
      issues = [],
    } = profile;

    const hairType = normalizeHairType(rawHairType);
    const scalpCondition = normalizeScalpCondition(rawScalp);

    const {
      budget = 'medium', // low, medium, high
      productType = 'all', // shampoo, conditioner, serum, mask, all
    } = preferences;

    const hasThinning = issues.some((i) => String(i).toLowerCase().includes('thinning'));

    // Map issues to categories (UI labels are fuzzy-matched to product category tags)
    const categoryMap = this.getCategoryMap();
    const targetCategories = this.getTargetCategories(issues, categoryMap);

    // Get all products with categories
    const [allProducts] = await pool.query(
      `SELECT p.product_id, p.name, p.brand, p.description, p.price,
              p.image_url, p.expiry_type, p.expiry_date, p.expiry_period_months,
              GROUP_CONCAT(DISTINCT pc.category_name) as categories
       FROM products p
       LEFT JOIN product_categories pc ON p.product_id = pc.product_id
       GROUP BY p.product_id`
    );

    // Score and filter products
    const scoredProducts = allProducts.map(product => {
      const categories = parseCategoryList(product.categories);
      const score = this.scoreProduct(product, {
        categories,
        targetCategories,
        hairType,
        scalpCondition,
        issues,
        budget,
        productType,
      });
      return { ...product, score, categories };
    });

    // Sort by score and take top matches; if nothing scores, still show catalog picks
    scoredProducts.sort((a, b) => b.score - a.score);
    let topProducts = scoredProducts.slice(0, MAX_RECOMMENDED_RESULTS).filter((p) => p.score > 0);
    let usedFallback = false;
    if (topProducts.length === 0 && scoredProducts.length > 0) {
      usedFallback = true;
      topProducts = scoredProducts.slice(0, Math.min(8, MAX_RECOMMENDED_RESULTS)).map((p) => ({
        ...p,
        score: Math.max(0.01, Number(p.score) || 0),
      }));
    }

    // Generate recommendations with reasons (include categories for frontend filtering)
    const recommendations = topProducts.map((product) => {
      const catList = parseCategoryList(product.categories);
      const baseReason = this.generateReason(product, {
        hairType,
        scalpCondition,
        issues,
        categories: catList,
      });
      const reason = usedFallback
        ? `${baseReason} • General pick from our catalog — adjust budget/type above to explore more.`
        : baseReason;
      const img = product.image_url;
      const imageUrl =
        img == null || img === ''
          ? null
          : String(img).trim().startsWith('http')
            ? String(img).trim()
            : String(img).trim().startsWith('/')
              ? String(img).trim()
              : `/${String(img).trim().replace(/^\//, '')}`;

      return {
        productId: product.product_id,
        name: product.name,
        brand: product.brand,
        description: product.description,
        price: parseFloat(product.price),
        imageUrl,
        expiryType: product.expiry_type || 'not_applicable',
        expiryDate: product.expiry_date || null,
        expiryPeriodMonths:
          product.expiry_period_months != null ? Number(product.expiry_period_months) : null,
        reason,
        matchScore: product.score,
        categories: catList,
      };
    });

    // Generate routine plan
    const routinePlan = this.generateRoutinePlan({ hairType, scalpCondition, issues, recommendations });

    // Get DIY guide suggestions
    const diyGuides = await this.getMatchingDIYGuides(issues);

    // Generate warnings
    let warnings = this.generateWarnings(issues, scalpCondition);
    if (hasThinning) {
      warnings = [
        'Hair shedding or thinning can have many causes — a clinician or dermatologist can help rule out treatable conditions.',
        ...warnings,
      ];
    }

    const result = {
      recommendations: recommendations.slice(0, MAX_RECOMMENDED_RESULTS),
      routinePlan,
      warnings,
      diyGuides,
    };
    if (hasThinning) {
      result.medicalAdvice =
        'For ongoing hair loss or thinning, consider speaking with a healthcare professional or dermatologist. Product ideas here are general care only.';
    }
    return result;
  }

  /**
   * Get category mapping for issues
   */
  getCategoryMap() {
    return {
      'dryness': { primary: 'moisturizing', secondary: null },
      'frizz': { primary: 'anti-frizz', secondary: 'moisturizing' },
      'flaking': { primary: 'anti-dandruff', secondary: null },
      'dandruff': { primary: 'anti-dandruff', secondary: null },
      'oiliness': { primary: 'clarifying/oily scalp', secondary: null },
      'oily': { primary: 'clarifying/oily scalp', secondary: null },
    };
  }

  /**
   * Get target categories based on issues
   */
  getTargetCategories(issues, categoryMap) {
    const categories = new Set();
    issues.forEach((issue) => {
      const key = mapIssueToCategoryKey(issue);
      const mapping = key ? categoryMap[key] : null;
      if (mapping) {
        if (mapping.primary) categories.add(mapping.primary);
        if (mapping.secondary) categories.add(mapping.secondary);
      }
    });
    return Array.from(categories);
  }

  /**
   * Score a product based on multiple factors
   */
  scoreProduct(product, context) {
    const { categories, targetCategories, hairType, scalpCondition, issues, budget, productType } = context;
    let score = 0;
    const normalizedCategories = Array.isArray(categories)
      ? categories.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const issueKeys = new Set(
      (Array.isArray(issues) ? issues : [])
        .map((issue) => mapIssueToCategoryKey(issue))
        .filter(Boolean)
    );

    // Category matching (primary: +5, secondary: +3)
    const categoryMap = this.getCategoryMap();
    issues.forEach((issue) => {
      const key = mapIssueToCategoryKey(issue);
      const mapping = key ? categoryMap[key] : null;
      if (mapping) {
        if (normalizedCategories.includes(String(mapping.primary || '').toLowerCase())) score += 5;
        if (mapping.secondary && normalizedCategories.includes(String(mapping.secondary || '').toLowerCase())) score += 3;
      }
    });

    // Hair type compatibility
    if (hairType) {
      const hairCompatibility = this.getHairTypeCompatibility(product, hairType, scalpCondition);
      score += hairCompatibility;
    }

    // Scalp condition compatibility
    if (scalpCondition) {
      const scalpCompatibility = this.getScalpCompatibility(product, scalpCondition, normalizedCategories);
      score += scalpCompatibility;
    }

    // Product type preference
    const productTypeMatch = this.getProductTypeMatch(product.name, productType);
    score += productTypeMatch;

    // Budget filtering (penalize if outside budget, but don't exclude)
    const budgetMatch = this.getBudgetMatch(parseFloat(product.price), budget);
    score += budgetMatch;

    // Strong profile-priority boosts/penalties so scenario changes are visibly different in demos.
    const hasCat = (cat) => normalizedCategories.includes(String(cat || '').toLowerCase());
    const hasFlakingIssue = issueKeys.has('flaking') || issueKeys.has('dandruff');
    const hasOilIssue = issueKeys.has('oiliness') || issueKeys.has('oily');
    const hasDryIssue = issueKeys.has('dryness');
    const hasFrizzIssue = issueKeys.has('frizz');
    const sc = String(scalpCondition || '').toLowerCase();

    if (hasFlakingIssue) {
      if (hasCat('anti-dandruff')) score += 6;
      if (hasCat('clarifying/oily scalp') && sc === 'dry') score -= 2;
    }
    if (hasOilIssue || sc === 'oily') {
      if (hasCat('clarifying/oily scalp')) score += 6;
      if (hasCat('moisturizing')) score -= 2;
    }
    if (hasDryIssue || sc === 'dry') {
      if (hasCat('moisturizing')) score += 5;
      if (hasCat('clarifying/oily scalp')) score -= 3;
    }
    if (hasFrizzIssue) {
      if (hasCat('anti-frizz')) score += 4;
    }

    return score;
  }

  /**
   * Get hair type compatibility score
   */
  getHairTypeCompatibility(product, hairType, scalpCondition) {
    const name = product.name.toLowerCase();
    const description = (product.description || '').toLowerCase();
    const text = name + ' ' + description;

    let score = 0;

    // Straight hair + oily scalp: prefer clarifying, lightweight
    if (hairType === 'straight' && scalpCondition === 'oily') {
      if (text.includes('clarifying') || text.includes('lightweight')) score += 2;
      if (text.includes('heavy') || text.includes('rich')) score -= 1;
    }

    // Curly/Coily + dry scalp: prefer moisturizing, avoid clarifying
    if ((hairType === 'curly' || hairType === 'coily') && scalpCondition === 'dry') {
      if (text.includes('moisturizing') || text.includes('hydrating')) score += 2;
      if (text.includes('clarifying') && !text.includes('gentle')) score -= 2;
    }

    // Wavy: balanced approach
    if (hairType === 'wavy') {
      score += 1; // Neutral bonus
    }

    return score;
  }

  /**
   * Get scalp condition compatibility score
   */
  getScalpCompatibility(product, scalpCondition, categories) {
    const name = product.name.toLowerCase();
    const description = (product.description || '').toLowerCase();
    const text = name + ' ' + description;
    const sc = String(scalpCondition || '').toLowerCase();
    const isEczema = sc.includes('eczema') || sc.includes('dermatitis');

    let score = 0;

    if (isEczema) {
      if (text.includes('gentle') || text.includes('sensitive') || text.includes('soothing') || text.includes('fragrance-free') || text.includes('hypoallergenic')) score += 3;
      if (text.includes('harsh') || text.includes('strong')) score -= 1;
    }

    if (scalpCondition === 'sensitive' || sc.includes('sensitive')) {
      if (text.includes('gentle') || text.includes('sensitive') || text.includes('soothing')) score += 2;
      if (text.includes('harsh') || text.includes('strong')) score -= 2;
    }

    if (scalpCondition === 'oily') {
      if (categories.includes('clarifying/oily scalp')) score += 2;
    }

    if (scalpCondition === 'dry') {
      if (categories.includes('moisturizing')) score += 2;
      if (categories.includes('clarifying/oily scalp')) score -= 1;
    }

    return score;
  }

  /**
   * Get product type match score
   */
  getProductTypeMatch(productName, preferredType) {
    if (preferredType === 'all') return 0; // No preference bonus

    const name = productName.toLowerCase();
    const typeMap = {
      'shampoo': ['shampoo', 'cleanser'],
      'conditioner': ['conditioner'],
      'serum': ['serum', 'oil'],
      'mask': ['mask', 'treatment'],
    };

    const keywords = typeMap[preferredType] || [];
    return keywords.some(kw => name.includes(kw)) ? 1 : 0;
  }

  /**
   * Get budget match score
   */
  getBudgetMatch(price, budget) {
    const ranges = {
      low: { min: 0, max: 15 },
      medium: { min: 15, max: 25 },
      high: { min: 25, max: Infinity },
    };

    const range = ranges[budget] || ranges.medium;
    if (price >= range.min && price <= range.max) return 1;
    if (price < range.min) return 0.5; // Close to budget
    if (price > range.max && price <= range.max * 1.5) return 0.3; // Slightly over
    return -0.5; // Way over budget
  }

  /**
   * Generate reason text for recommendation
   */
  generateReason(product, context) {
    const { hairType, scalpCondition, issues, categories } = context;
    const reasons = [];

    // Issue-based reasons
    if (issues.length > 0) {
      const issueText = issues.join(', ');
      reasons.push(`Addresses: ${issueText}`);
    }

    // Category-based
    if (categories && (Array.isArray(categories) ? categories.length : String(categories).length)) {
      const catLine = Array.isArray(categories) ? categories.join(', ') : String(categories);
      reasons.push(`Category: ${catLine}`);
    }

    // Hair type
    if (hairType) {
      reasons.push(`Suitable for ${hairType} hair`);
    }

    // Scalp condition
    if (scalpCondition) {
      reasons.push(`For ${scalpCondition} scalp`);
    }

    return reasons.join('. ') || 'Recommended based on your profile';
  }

  /**
   * Generate routine plan (daily/weekly)
   */
  generateRoutinePlan(context) {
    const { hairType, scalpCondition, issues, recommendations } = context;

    // Determine wash frequency based on scalp condition
    let washFrequency = '2-3 times per week';
    if (scalpCondition === 'oily') washFrequency = '3-4 times per week';
    if (scalpCondition === 'dry') washFrequency = '1-2 times per week';
    if (scalpCondition === 'normal') washFrequency = '2-3 times per week';

    // Categorize recommended products
    const shampoos = recommendations.filter(p => p.name.toLowerCase().includes('shampoo'));
    const conditioners = recommendations.filter(p => p.name.toLowerCase().includes('conditioner'));
    const serums = recommendations.filter(p => p.name.toLowerCase().includes('serum') || p.name.toLowerCase().includes('oil'));
    const masks = recommendations.filter(p => p.name.toLowerCase().includes('mask') || p.name.toLowerCase().includes('treatment'));

    const daily = [];
    const weekly = [];

    // Daily routine
    if (serums.length > 0) {
      daily.push({
        time: 'Morning',
        step: 'Apply lightweight serum or oil',
        product: serums[0].name,
        note: 'Focus on ends and mid-lengths',
      });
    }

    // Weekly routine
    weekly.push({
      step: 'Wash hair',
      frequency: washFrequency,
      products: shampoos.slice(0, 1).map(p => p.name),
      note: 'Use lukewarm water, focus on scalp',
    });

    if (conditioners.length > 0) {
      weekly.push({
        step: 'Condition',
        frequency: 'After every wash',
        products: conditioners.slice(0, 1).map(p => p.name),
        note: 'Apply to mid-lengths and ends, avoid roots',
      });
    }

    if (masks.length > 0) {
      weekly.push({
        step: 'Deep treatment mask',
        frequency: 'Once per week',
        products: masks.slice(0, 1).map(p => p.name),
        note: 'Leave on for 15-30 minutes, then rinse',
      });
    }

    // Clarifying treatment (if oily scalp)
    if (scalpCondition === 'oily') {
      weekly.push({
        step: 'Clarifying treatment',
        frequency: 'Once per month',
        note: 'Use a clarifying shampoo to remove buildup',
      });
    }

    return {
      daily,
      weekly,
      notes: [
        'Adjust frequency based on your hair\'s response',
        'Always use products as directed',
        'Patch test new products before full use',
      ],
    };
  }

  /**
   * Get matching DIY guides based on issues
   */
  async getMatchingDIYGuides(issues) {
    if (!issues || issues.length === 0) return [];

    const issueMap = {
      dryness: ['moisturizing', 'dry'],
      frizz: ['frizz', 'smoothing'],
      flaking: ['scalp', 'dandruff'],
      oiliness: ['clarifying', 'oily'],
    };

    const searchTerms = [];
    issues.forEach((issue) => {
      const key = mapIssueToCategoryKey(issue);
      const terms = key ? issueMap[key] : null;
      if (terms) searchTerms.push(...terms);
    });

    if (searchTerms.length === 0) return [];

    // Schema uses title, steps, ingredients, caution (no summary/content/is_published)
    const term = `%${searchTerms[0]}%`;
    try {
      const [guides] = await pool.query(
        `SELECT guide_id, title, steps, ingredients, category
         FROM diy_guides
         WHERE title LIKE ?
            OR steps LIKE ?
            OR ingredients LIKE ?
            OR COALESCE(caution, '') LIKE ?
         LIMIT 3`,
        [term, term, term, term]
      );

      return guides.map((g) => ({
        guideId: g.guide_id,
        title: g.title,
        summary: g.steps
          ? String(g.steps).replace(/\s+/g, ' ').trim().slice(0, 220)
          : '',
      }));
    } catch (err) {
      console.warn('[recommendationService] DIY guides lookup skipped:', err.message);
      return [];
    }
  }

  /**
   * Generate warnings and disclaimers
   */
  generateWarnings(issues, scalpCondition) {
    const warnings = [
      'Always patch test new products on a small area of skin first (behind ear or inner arm)',
      'Stop use immediately if you experience irritation, redness, or discomfort',
      'Consult a healthcare professional for severe or persistent symptoms',
    ];

    const sc = String(scalpCondition || '').toLowerCase();
    if (sc.includes('eczema') || sc.includes('dermatitis')) {
      warnings.unshift('Severe scalp eczema or dermatitis should be guided by a clinician; product ideas here are general only');
    } else if (scalpCondition === 'sensitive' || sc.includes('sensitive')) {
      warnings.unshift('You have a sensitive scalp - start with gentle products and monitor for reactions');
    }

    if (issues.some(i => i.toLowerCase().includes('flaking'))) {
      warnings.push('If flaking persists or worsens, consult a dermatologist');
    }

    return warnings;
  }

  /**
   * Generate advice for thinning issue (non-medical only)
   */
  generateThinningAdvice(profile, preferences) {
    return {
      recommendations: [],
      routinePlan: {
        daily: [
          {
            time: 'Daily',
            step: 'Gentle hair care',
            note: 'Handle hair gently, avoid tight hairstyles and harsh chemicals',
          },
        ],
        weekly: [
          {
            step: 'Gentle washing',
            frequency: '2-3 times per week',
            note: 'Use mild, sulfate-free products',
          },
        ],
        notes: [
          'Avoid excessive heat styling',
          'Use wide-tooth comb instead of brush',
          'Protect hair from sun damage',
        ],
      },
      warnings: [
        'Hair loss concerns require professional evaluation',
        'Consult a healthcare provider or dermatologist for proper diagnosis',
        'This system provides preventive awareness only, not medical advice',
        'Early consultation can help identify underlying causes',
      ],
      diyGuides: [],
      medicalAdvice: 'For hair loss concerns, we recommend consulting a healthcare professional or dermatologist. They can help identify underlying causes and recommend appropriate treatments.',
    };
  }

  /**
   * Generate recommendations from user ID (backward compatibility)
   */
  async generateRecommendationsFromUserId(userId, preferences = {}) {
    if (process.env.SKIP_DB_FOR_TESTING === 'true') {
      return { recommendations: [], message: 'Database not available in testing mode' };
    }
    await this.ensureHairProfilesTable();

    const [profileRows] = await pool.query(
      'SELECT hair_type, scalp_condition, issues_detected FROM hair_profiles WHERE user_id = ?',
      [userId]
    );

    if (profileRows.length === 0) {
      return {
        recommendations: [],
        message: 'Complete an assessment to get recommendations',
      };
    }

    const profile = profileRows[0];
    const issues = profile.issues_detected ? profile.issues_detected.split(', ') : [];

    return this.generateRecommendations(
      {
        hairType: profile.hair_type,
        scalpCondition: profile.scalp_condition,
        issues,
      },
      preferences
    );
  }

  /**
   * Get user's saved recommendations
   */
  async getUserRecommendations(userId) {
    if (process.env.SKIP_DB_FOR_TESTING === 'true') {
      return [];
    }

    await this.ensureRecommendationsTable();

    const [rows] = await pool.query(
      `SELECT r.rec_id, r.reason, r.date_recommended,
              p.product_id, p.name, p.brand, p.description, p.price
       FROM recommendations r
       JOIN products p ON r.product_id = p.product_id
       WHERE r.user_id = ?
       ORDER BY r.date_recommended DESC`,
      [userId]
    );

    return rows.map(r => ({
      recId: r.rec_id,
      productId: r.product_id,
      name: r.name,
      brand: r.brand,
      description: r.description,
      price: parseFloat(r.price),
      reason: r.reason,
      dateRecommended: r.date_recommended,
    }));
  }

  /**
   * Replace all saved product rows for a user (after regenerating matches).
   */
  async replaceUserRecommendations(userId, recommendations) {
    if (process.env.SKIP_DB_FOR_TESTING === 'true') {
      return;
    }
    await this.ensureRecommendationsTable();
    await pool.query('DELETE FROM recommendations WHERE user_id = ?', [userId]);
    if (!recommendations || !recommendations.length) return;
    const values = recommendations.map((r) => [userId, r.productId, r.reason || '']);
    await pool.query('INSERT INTO recommendations (user_id, product_id, reason) VALUES ?', [values]);
  }

  /**
   * Generate from hair_profiles + persist rows so /recommendations/saved and dashboard work.
   */
  async generateAndPersistRecommendations(userId, preferences = {}) {
    const pack = await this.generateRecommendationsFromUserId(userId, preferences);
    const list = pack.recommendations || [];
    await this.replaceUserRecommendations(userId, list);
    return pack;
  }
}

module.exports = new RecommendationService();
