/**
 * Assessment Routes
 * Location: backend/routes/assessmentRoutes.js
 * Purpose: Define assessment endpoints
 */
const express = require('express');
const router = express.Router();
const assessmentController = require('../controllers/assessmentController');
const { requireAuth } = require('../middleware/auth');
const { validateAssessment, validateAssessmentId } = require('../middleware/validation');

router.post('/', requireAuth, assessmentController.createAssessment);
router.post('/verify-capture', requireAuth, assessmentController.verifyCapture);
router.get('/count', requireAuth, assessmentController.getCount);
router.post('/:assessmentId/responses', requireAuth, validateAssessment, assessmentController.saveResponses);
/** Must be before /:assessmentId/results or "latest" is captured as a param and becomes NaN. */
router.get('/latest/results', requireAuth, assessmentController.getLatestResults);
router.get('/:assessmentId/results', requireAuth, validateAssessmentId, assessmentController.getResults);

module.exports = router;
