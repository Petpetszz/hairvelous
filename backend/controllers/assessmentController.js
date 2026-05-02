/**
 * Assessment Controller
 * Location: backend/controllers/assessmentController.js
 * Purpose: Handle HTTP requests for hair assessments
 */
const assessmentService = require('../services/assessmentService');
const recommendationService = require('../services/recommendationService');
const { validationResult } = require('express-validator');

class AssessmentController {
  async getCount(req, res, next) {
    try {
      const count = await assessmentService.getAssessmentCount(req.user.userId);
      res.json({ count });
    } catch (err) {
      next(err);
    }
  }

  async verifyCapture(req, res, next) {
    try {
      const { imageBase64, shotType } = req.body || {};
      if (!imageBase64) {
        return res.status(400).json({ error: 'imageBase64 is required' });
      }
      if (!shotType) {
        return res.status(400).json({ error: 'shotType is required' });
      }
      const result = await assessmentService.verifyCapture(req.user.userId, { imageBase64, shotType });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  async createAssessment(req, res, next) {
    try {
      const { assessmentId } = await assessmentService.createAssessment(req.user.userId);
      res.status(201).json({
        assessmentId,
      });
    } catch (err) {
      next(err);
    }
  }

  async saveResponses(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { assessmentId } = req.params;
      const { responses } = req.body;

      const id = parseInt(assessmentId, 10);
      if (!Number.isFinite(id) || id < 1) {
        return res.status(400).json({ error: 'Invalid assessment ID' });
      }
      await assessmentService.saveResponses(id, responses);
      res.json({
        message: 'Responses saved',
      });
    } catch (err) {
      next(err);
    }
  }

  async getResults(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { assessmentId } = req.params;
      const id = parseInt(assessmentId, 10);
      if (!Number.isFinite(id) || id < 1) {
        return res.status(400).json({ error: 'Invalid assessment ID' });
      }
      const results = await assessmentService.getResults(id, req.user.userId);

      await assessmentService.upsertHairProfile(req.user.userId, {
        hairType: results.hairType,
        scalpCondition: results.scalpCondition,
        issuesDetected: results.issuesDetected,
      });

      const preferences = {
        budget: req.query.budget || 'medium',
        productType: req.query.productType || 'all',
      };

      const recPack = await recommendationService.generateAndPersistRecommendations(
        req.user.userId,
        preferences
      );

      res.json({
        ...results,
        ...recPack,
      });
    } catch (err) {
      next(err);
    }
  }

  async getLatestResults(req, res, next) {
    try {
      const results = await assessmentService.getLatestResults(req.user.userId);
      if (!results) {
        return res.json({
          message: 'No assessment found',
        });
      }

      await assessmentService.upsertHairProfile(req.user.userId, {
        hairType: results.hairType,
        scalpCondition: results.scalpCondition,
        issuesDetected: results.issuesDetected,
      });

      await recommendationService.generateAndPersistRecommendations(req.user.userId, {
        budget: 'medium',
        productType: 'all',
      });

      const recommendations = await recommendationService.getUserRecommendations(req.user.userId);

      res.json({
        ...results,
        recommendations,
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AssessmentController();
