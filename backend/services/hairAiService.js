/**
 * Hair AI Service
 * Location: backend/services/hairAiService.js
 * Purpose: Use Gemini to analyze hair photos with context from assessments
 */
const fs = require('fs').promises;
const path = require('path');
const pool = require('../config/db');

let GoogleGenerativeAI;
try {
  // Lazy require so the app still runs if dependency is missing
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
} catch (e) {
  console.warn('[hairAiService] @google/generative-ai is not installed. Run `npm install @google/generative-ai` in backend.');
}

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-1.5-flash'];
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatusCode(err) {
  const status = err && (err.status || err.statusCode || (err.response && err.response.status));
  const asNum = Number(status);
  return Number.isFinite(asNum) ? asNum : null;
}

function isRetryableGeminiError(err) {
  const status = getErrorStatusCode(err);
  if (status && RETRYABLE_STATUS_CODES.has(status)) return true;
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('service unavailable') || msg.includes('overloaded') || msg.includes('timeout');
}

function getUserFacingGeminiErrorMessage(err) {
  const status = getErrorStatusCode(err);
  const msg = String((err && err.message) || '').toLowerCase();
  if (status === 400 && msg.includes('api key not valid')) {
    return 'Gemini API key is invalid. Please update GEMINI_API_KEY in server environment.';
  }
  if (isRetryableGeminiError(err)) {
    return 'AI analysis is temporarily busy. Please try again in a moment.';
  }
  return 'AI analysis is currently unavailable. Please try again.';
}

async function generateWithFallback(apiKey, contentParts) {
  let lastErr = null;
  for (const modelName of GEMINI_MODELS) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await model.generateContent(contentParts);
        return result;
      } catch (err) {
        lastErr = err;
        if (!isRetryableGeminiError(err) || attempt === 3) break;
        await sleep(400 * attempt);
      }
    }
  }
  throw lastErr || new Error('Gemini request failed');
}

class HairAiService {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!this.apiKey) {
      console.warn('[hairAiService] GEMINI_API_KEY/GOOGLE_API_KEY not set. Hair AI analysis will be skipped.');
    }
  }

  /**
   * Get latest hair profile context from assessments (if available)
   */
  async getUserProfileContext(userId) {
    if (process.env.SKIP_DB_FOR_TESTING === 'true') return null;

    const [rows] = await pool.query(
      'SELECT hair_type, scalp_condition, issues_detected FROM hair_profiles WHERE user_id = ? ORDER BY profile_id DESC LIMIT 1',
      [userId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      hairType: row.hair_type || null,
      scalpCondition: row.scalp_condition || null,
      issuesDetected: row.issues_detected || null,
    };
  }

  /**
   * Analyze a hair photo using Gemini.
   * Returns a JSON string (AI result) and never null.
   */
  async analyzePhoto(userId, absoluteImagePath) {
    let imageBuffer;
    try {
      imageBuffer = await fs.readFile(absoluteImagePath);
    } catch (err) {
      console.error('[hairAiService] Failed to read image file:', absoluteImagePath, err.message);
      return JSON.stringify(
        buildAssessmentFallbackResult(null, [], 'image read failed')
      );
    }

    const imageDataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

    try {
      // Reuse the same fallback-capable path used by /api/hair-ai/analyze.
      const aiObject = await analyzeHairFromImage(userId, imageDataUrl);
      return JSON.stringify(aiObject);
    } catch (err) {
      console.error('[hairAiService] Error during photo analysis:', err.message);
      return JSON.stringify(
        buildAssessmentFallbackResult(null, [], getUserFacingGeminiErrorMessage(err))
      );
    }
  }
}

const assessmentService = require('./assessmentService');

// Export both the class instance and the standalone functions
module.exports = {
  HairAiService,
  analyzeHairFromImage,
  analyzeCaptureQuality,
  getUserProfileContext: HairAiService.prototype.getUserProfileContext,
  analyzePhoto: HairAiService.prototype.analyzePhoto,
};
let model = null;

function getModel() {
  if (model) return model;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (!apiKey) {
    console.warn('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set. Hair AI analysis will not work.');
    return null;
  }
  model = { apiKey };
  return model;
}

function buildProfileContext(profile, assessmentAnswers) {
  const lines = [];

  if (!profile && (!assessmentAnswers || assessmentAnswers.length === 0)) {
    return 'User has not completed a hair assessment profile yet.';
  }

  if (profile) {
    const issues = (profile.issuesDetected || []).join(', ') || 'none clearly reported';
    lines.push('User self-reported profile summary:');
    lines.push(`- Hair type: ${profile.hairType || 'not specified'}`);
    lines.push(`- Scalp condition: ${profile.scalpCondition || 'not specified'}`);
    lines.push(`- Key concerns/issues: ${issues}`);
  }

  if (assessmentAnswers && assessmentAnswers.length > 0) {
    lines.push('');
    lines.push('Full assessment Q&A answers:');
    assessmentAnswers.forEach((qa, i) => {
      const answerStr = Array.isArray(qa.answer)
        ? qa.answer.join(', ')
        : String(qa.answer);
      lines.push(`Q${i + 1}: ${qa.question}`);
      lines.push(`A${i + 1}: ${answerStr}`);
    });
  }

  return lines.join('\n');
}

function collectIssueList(latestProfile, assessmentAnswers) {
  const fromProfile = [];
  const raw = latestProfile && latestProfile.issuesDetected;
  if (Array.isArray(raw)) {
    fromProfile.push(...raw);
  } else if (typeof raw === 'string' && raw.trim()) {
    fromProfile.push(...raw.split(',').map((x) => x.trim()));
  }

  const fromAnswers = (assessmentAnswers || [])
    .filter((qa) => {
      const q = String((qa && qa.question) || '').toLowerCase();
      return q.includes('issue') || q.includes('concern') || q.includes('problem');
    })
    .flatMap((qa) => {
      const ans = qa && qa.answer;
      if (Array.isArray(ans)) return ans.map((x) => String(x || '').trim());
      if (typeof ans === 'string') {
        const s = ans.trim();
        if (!s) return [];
        if (s.startsWith('[') && s.endsWith(']')) {
          try {
            const parsed = JSON.parse(s);
            if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim());
          } catch (_e) {
            // keep plain string fallback
          }
        }
        return s.includes(',') ? s.split(',').map((x) => x.trim()) : [s];
      }
      return [];
    });

  return [...fromProfile, ...fromAnswers]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

function buildAssessmentFallbackResult(latestProfile, assessmentAnswers, reasonText) {
  const hairType =
    (latestProfile && latestProfile.hairType) ||
    ((assessmentAnswers || []).find((qa) => String(qa.question || '').toLowerCase().includes('hair type')) || {})
      .answer ||
    'uncertain';
  const scalpCondition =
    (latestProfile && latestProfile.scalpCondition) ||
    ((assessmentAnswers || []).find((qa) => String(qa.question || '').toLowerCase().includes('scalp')) || {})
      .answer ||
    'uncertain';

  const issues = collectIssueList(latestProfile, assessmentAnswers);
  const issueText = issues.join(' | ').toLowerCase();
  const scalpTextRaw = Array.isArray(scalpCondition)
    ? String(scalpCondition[0] || 'uncertain')
    : String(scalpCondition || 'uncertain');
  const scalpTextLower = scalpTextRaw.toLowerCase();
  const primaryIssue = issues.length ? issues[0] : 'general scalp concern';

  let conditionName = `Assessment-based: ${primaryIssue}`;
  let severity = 'mild';
  let confidence = 52;
  let careTips = [
    'Continue a gentle scalp-care routine and monitor weekly changes.',
    'Retake scalp photos in bright, even lighting for a stronger image-based analysis.',
  ];
  let recommendation = {
    title: 'Scalp-friendly cleanser',
    description:
      'Pick a mild cleanser aligned with your reported scalp condition to reduce irritation and buildup.',
    usageHint: 'Use consistently 2-4 times weekly depending on scalp oiliness.',
    exampleProducts: ['Gentle scalp cleanser', 'Hydrating anti-flake shampoo'],
  };

  if (issueText.includes('dandruff') || issueText.includes('flake') || issueText.includes('itch')) {
    conditionName = 'Assessment-based: flaking/itch-prone scalp';
    severity = issueText.includes('severe') ? 'severe' : 'moderate';
    confidence = 64;
    careTips = [
      'Use an anti-flake shampoo 2-3x weekly and leave on scalp for 2-3 minutes before rinsing.',
      'Avoid scratching and heavy scalp oils while active flaking is present.',
    ];
    recommendation = {
      title: 'Anti-flake scalp shampoo',
      description: 'Targets visible flakes and itch while keeping the scalp barrier calmer.',
      usageHint: 'Alternate with a gentle shampoo to avoid over-drying.',
      exampleProducts: ['Ketoconazole shampoo', 'Zinc pyrithione shampoo'],
    };
  } else if (issueText.includes('oil') || issueText.includes('greasy')) {
    conditionName = 'Assessment-based: excess scalp oiliness';
    severity = issueText.includes('very') || issueText.includes('severe') ? 'moderate' : 'mild';
    confidence = 62;
    careTips = [
      'Wash scalp on a regular schedule with a gentle clarifying shampoo.',
      'Avoid layering thick leave-on products directly on the scalp.',
    ];
    recommendation = {
      title: 'Balancing shampoo for oily scalp',
      description: 'Helps reduce excess sebum and buildup without aggressively stripping hair.',
      usageHint: 'Use 3-4x weekly, then adjust based on scalp comfort.',
      exampleProducts: ['Salicylic scalp shampoo', 'Light clarifying shampoo'],
    };
  } else if (issueText.includes('dry') || issueText.includes('dehydrat')) {
    conditionName = 'Assessment-based: dry scalp tendency';
    severity = issueText.includes('severe') ? 'moderate' : 'mild';
    confidence = 60;
    careTips = [
      'Use lukewarm water and avoid over-washing to protect scalp moisture.',
      'Pair gentle shampoo with lightweight hydration focused on scalp comfort.',
    ];
    recommendation = {
      title: 'Hydrating scalp-care wash',
      description: 'Supports scalp moisture and reduces tight, dry-feeling discomfort.',
      usageHint: 'Use 2-3x weekly and avoid harsh scrubbing.',
      exampleProducts: ['Hydrating scalp shampoo', 'Fragrance-light soothing cleanser'],
    };
  } else if (
    issueText.includes('hair fall') ||
    issueText.includes('shedding') ||
    issueText.includes('breakage') ||
    issueText.includes('thinning')
  ) {
    conditionName = 'Assessment-based: shedding/breakage tendency';
    severity = issueText.includes('rapid') || issueText.includes('severe') ? 'severe' : 'moderate';
    confidence = 63;
    careTips = [
      'Minimize heat styling and tight hairstyles while monitoring weekly hair shed.',
      'Prioritize protein-moisture balance and gentle detangling habits.',
    ];
    recommendation = {
      title: 'Strengthening routine set',
      description: 'Supports weaker strands and reduces breakage risk during wash and styling.',
      usageHint: 'Use a strengthening shampoo + conditioner pair consistently.',
      exampleProducts: ['Bond-repair shampoo', 'Strengthening conditioner'],
    };
  } else if (scalpTextLower.includes('oily')) {
    conditionName = 'Assessment-based: oily scalp tendency';
    severity = 'mild';
    confidence = 58;
    careTips = [
      'Use a gentle balancing shampoo and avoid heavy buildup on scalp.',
      'Rinse thoroughly and monitor oil levels after styling products.',
    ];
    recommendation = {
      title: 'Oily scalp balancing wash',
      description: 'Helps keep scalp fresher while staying gentle for regular use.',
      usageHint: 'Start with every other day, then adjust to comfort.',
      exampleProducts: ['Balancing shampoo', 'Clarifying scalp cleanser'],
    };
  } else if (scalpTextLower.includes('dry') || scalpTextLower.includes('flaky')) {
    conditionName = 'Assessment-based: dry/flaky scalp tendency';
    severity = 'mild';
    confidence = 58;
    careTips = [
      'Use gentle cleansers and avoid hot water to protect scalp moisture.',
      'Keep wash frequency moderate to reduce scalp tightness and flakes.',
    ];
    recommendation = {
      title: 'Hydration-focused scalp cleanser',
      description: 'Supports scalp comfort for dryness-prone routines.',
      usageHint: 'Use 2-3x weekly and avoid harsh scrubbing.',
      exampleProducts: ['Hydrating shampoo', 'Soothing anti-flake cleanser'],
    };
  }

  if (latestProfile && latestProfile.isBald) {
    severity = 'moderate';
  }

  const hairTypeText = Array.isArray(hairType) ? String(hairType[0] || 'uncertain') : String(hairType || 'uncertain');
  const scalpText = scalpTextRaw;
  const concernsText = issues.length ? issues.slice(0, 3).join(', ') : 'general scalp maintenance';
  const dynamicSummary =
    `Based on your assessment, your profile is ${hairTypeText} hair with a ${scalpText} scalp. ` +
    `Current focus is ${concernsText}; routine guidance is prioritized around these responses.`;

  return {
    conditionName,
    confidence,
    hairType: hairTypeText,
    scalpCondition: scalpText,
    severity,
    summary: dynamicSummary,
    careTips,
    recommendations: [recommendation],
    whenToSeeProfessional:
      'Consult a dermatologist or trichologist if symptoms persist, worsen, or include pain, bleeding, or sudden hair loss.',
    disclaimer:
      'This result is generated from your assessment answers for this attempt. Photo-based AI insight was not available, and this is not a medical diagnosis.',
  };
}

async function analyzeCaptureQuality(userId, imageBase64, shotType) {
  if (!imageBase64) {
    throw new Error('imageBase64 is required');
  }
  const m = getModel();
  if (!m) {
    return null;
  }
  const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const shot = String(shotType || '').trim().toLowerCase();
  const shotLabelMap = {
    top_crown: 'top/crown scalp',
    back_head: 'back of the head scalp',
    left_side: 'left side scalp/hair',
    right_side: 'right side scalp/hair',
  };
  const shotLabel = shotLabelMap[shot] || 'scalp area';
  const prompt = `
You are validating a scalp capture quality for a hair assessment app.
Evaluate if this image is acceptable for the required shot: "${shotLabel}".

Return STRICT JSON only with this shape:
{
  "pass": true,
  "checks": {
    "hairVisible": { "pass": true, "value": 0.0, "min": 0.5 },
    "lighting": { "pass": true, "value": 0.0, "min": 0.45 },
    "sharpness": { "pass": true, "value": 0.0, "min": 0.45 },
    "framing": { "pass": true, "value": 0.0, "min": 0.5 },
    "obstruction": { "pass": true, "value": 0.0, "max": 0.35 }
  },
  "tips": ["short retake guidance"]
}

Rules:
- pass=true only when hair/scalp is visible enough and image is usable.
- value scores are 0..1.
- If failing, include 1-3 concise tips.
- Return JSON only.
  `.trim();
  let result;
  try {
    result = await generateWithFallback(m.apiKey, [
      prompt,
      {
        inlineData: {
          data: base64Data,
          mimeType: 'image/jpeg',
        },
      },
    ]);
  } catch (_e) {
    return null;
  }
  const text = result && result.response && typeof result.response.text === 'function'
    ? result.response.text()
    : '';
  let cleanedText = String(text || '').trim();
  cleanedText = cleanedText.replace(/```json\\s*/gi, '');
  cleanedText = cleanedText.replace(/```\\s*/g, '');
  const jsonStart = cleanedText.indexOf('{');
  const jsonEnd = cleanedText.lastIndexOf('}') + 1;
  if (jsonStart === -1 || jsonEnd === 0) return null;
  try {
    const parsed = JSON.parse(cleanedText.substring(jsonStart, jsonEnd));
    if (typeof parsed.pass !== 'boolean') return null;
    if (!Array.isArray(parsed.tips)) parsed.tips = [];
    return parsed;
  } catch (_e) {
    return null;
  }
}

async function analyzeHairFromImage(userId, imageBase64) {
  if (!imageBase64) {
    throw new Error('imageBase64 is required');
  }

  // Get latest assessment profile summary AND full Q&A answers to give rich context to the AI
  let latestProfile = null;
  let assessmentAnswers = [];
  if (process.env.SKIP_DB_FOR_TESTING !== 'true') {
    try {
      latestProfile = await assessmentService.getLatestResults(userId);
    } catch (_e) {
      latestProfile = null;
    }
    try {
      assessmentAnswers = await assessmentService.getLatestAssessmentAnswers(userId);
    } catch (_e) {
      assessmentAnswers = [];
    }
  }

  const m = getModel();
  if (!m) {
    return buildAssessmentFallbackResult(latestProfile, assessmentAnswers, 'GEMINI_API_KEY not configured');
  }

  const profileContext = buildProfileContext(latestProfile, assessmentAnswers);

  // Extract the user's self-reported hair type and scalp condition to lock them in the prompt
  const userHairType = latestProfile && latestProfile.hairType
    ? latestProfile.hairType
    : (assessmentAnswers.find(qa => qa.question.toLowerCase().includes('hair type'))
        ? (Array.isArray(assessmentAnswers.find(qa => qa.question.toLowerCase().includes('hair type')).answer)
            ? assessmentAnswers.find(qa => qa.question.toLowerCase().includes('hair type')).answer[0]
            : String(assessmentAnswers.find(qa => qa.question.toLowerCase().includes('hair type')).answer))
        : null);

  const userScalpCondition = latestProfile && latestProfile.scalpCondition
    ? latestProfile.scalpCondition
    : (assessmentAnswers.find(qa => qa.question.toLowerCase().includes('scalp'))
        ? (Array.isArray(assessmentAnswers.find(qa => qa.question.toLowerCase().includes('scalp')).answer)
            ? assessmentAnswers.find(qa => qa.question.toLowerCase().includes('scalp')).answer[0]
            : String(assessmentAnswers.find(qa => qa.question.toLowerCase().includes('scalp')).answer))
        : null);

  const base64Data = imageBase64.includes(',')
    ? imageBase64.split(',')[1]
    : imageBase64;

  const prompt = `
You are "HairAI" – an advanced AI trichology assistant for a hair-care app.

The user has already completed a detailed hair assessment questionnaire.
Use BOTH the self-reported answers AND the photo you receive.

IMPORTANT RULES:
1. The "hairType" field in your JSON response MUST match the user's self-reported hair type exactly (see below). Do NOT infer a different hair type from the image.
2. The "scalpCondition" field in your JSON response MUST match the user's self-reported scalp condition exactly (see below). Do NOT infer a different scalp condition from the image.
3. Use the photo ONLY to identify visible conditions (e.g. dandruff flakes, breakage, oiliness, dryness) and to set the "conditionName", "severity", "summary", "careTips", and "recommendations".

User's self-reported values (USE THESE EXACTLY):
- hairType: "${userHairType || 'not specified'}"
- scalpCondition: "${userScalpCondition || 'not specified'}"

Full assessment context:
${profileContext}

YOUR TASK: From this image and the profile above, identify the most likely hair/scalp condition(s) and suggest product TYPES and basic routine ideas.

RETURN FORMAT: Valid JSON only, no markdown, no explanations.

{
  "conditionName": "Mild dandruff (likely seborrheic dermatitis)",
  "confidence": 87,
  "hairType": "${userHairType || 'uncertain'}",
  "scalpCondition": "${userScalpCondition || 'uncertain'}",
  "severity": "mild|moderate|severe|uncertain",
  "summary": "Short 1–2 sentence overview referencing the user's hair type and scalp condition.",
  "careTips": [
    "Short, practical tip 1 tailored to the user's hair type and scalp condition",
    "Short, practical tip 2"
  ],
  "recommendations": [
    {
      "title": "Anti-dandruff shampoo (ketoconazole-based)",
      "description": "1–2 sentences explaining why this type of product may help given what you see.",
      "usageHint": "How often and how to use it briefly.",
      "exampleProducts": [
        "Ketoconazole anti-dandruff shampoo",
        "Zinc pyrithione scalp shampoo"
      ]
    }
  ],
  "whenToSeeProfessional": "1–3 sentences describing when they should see a dermatologist or trichologist.",
  "disclaimer": "Short, clear disclaimer that this is not a medical diagnosis and cannot replace an in-person professional assessment."
}

CRITICAL: Return ONLY valid JSON. No markdown, no code blocks, no explanations. The "hairType" and "scalpCondition" fields MUST exactly match the user's self-reported values above.
  `.trim();

  let result;
  try {
    result = await generateWithFallback(m.apiKey, [
      prompt,
      {
        inlineData: {
          data: base64Data,
          mimeType: 'image/jpeg',
        },
      },
    ]);
  } catch (e) {
    return buildAssessmentFallbackResult(
      latestProfile,
      assessmentAnswers,
      getUserFacingGeminiErrorMessage(e)
    );
  }

  const response = result.response;
  const text = response.text();

  let cleanedText = text.trim();
  cleanedText = cleanedText.replace(/```json\\s*/gi, '');
  cleanedText = cleanedText.replace(/```\\s*/g, '');

  const jsonStart = cleanedText.indexOf('{');
  const jsonEnd = cleanedText.lastIndexOf('}') + 1;

  if (jsonStart === -1 || jsonEnd === 0) {
    return buildAssessmentFallbackResult(latestProfile, assessmentAnswers, 'invalid AI JSON response');
  }

  const jsonString = cleanedText.substring(jsonStart, jsonEnd);

  try {
    return JSON.parse(jsonString);
  } catch (e) {
    return buildAssessmentFallbackResult(latestProfile, assessmentAnswers, 'failed to parse AI JSON');
  }
};


