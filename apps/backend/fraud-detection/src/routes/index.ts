import { route, type Route } from "@delegolabs/utils";
import { checkFraudHandler, listRulesHandler, createRuleHandler, getRuleHandler, updateRuleHandler, deleteRuleHandler, evaluateRulesHandler, getModelVersionHandler, retrainModelHandler, getModelPerformanceHandler, listCasesHandler, createCaseHandler, getCaseHandler, updateCaseHandler, addEvidenceHandler, getFraudRateHandler, getFraudTrendsHandler, getTopFraudRulesHandler, recordEscrowVelocityHandler } from "./fraudRoutes.js";

export function registerFraudRoutes(): Route[] {
  return [
    // Fraud check
    route("POST", "/api/v1/fraud/check", checkFraudHandler),
    route("POST", "/api/v1/fraud/escrow-velocity", recordEscrowVelocityHandler),

    // Rules management
    route("GET", "/api/v1/rules", listRulesHandler),
    route("POST", "/api/v1/rules", createRuleHandler),
    route("GET", "/api/v1/rules/:id", getRuleHandler),
    route("PATCH", "/api/v1/rules/:id", updateRuleHandler),
    route("DELETE", "/api/v1/rules/:id", deleteRuleHandler),
    route("POST", "/api/v1/rules/evaluate", evaluateRulesHandler),

    // Model management
    route("GET", "/api/v1/model/version", getModelVersionHandler),
    route("POST", "/api/v1/model/retrain", retrainModelHandler),
    route("GET", "/api/v1/model/performance", getModelPerformanceHandler),

    // Case management
    route("GET", "/api/v1/cases", listCasesHandler),
    route("POST", "/api/v1/cases", createCaseHandler),
    route("GET", "/api/v1/cases/:id", getCaseHandler),
    route("PATCH", "/api/v1/cases/:id", updateCaseHandler),
    route("POST", "/api/v1/cases/:id/evidence", addEvidenceHandler),

    // Analytics
    route("GET", "/api/v1/analytics/fraud-rate", getFraudRateHandler),
    route("GET", "/api/v1/analytics/trends", getFraudTrendsHandler),
    route("GET", "/api/v1/analytics/top-fraud-rules", getTopFraudRulesHandler),
  ];
}
