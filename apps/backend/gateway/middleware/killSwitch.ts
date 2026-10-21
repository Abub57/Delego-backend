/**
 * Emergency Kill-Switch Middleware for Gateway (Issue #375)
 *
 * Rejects requests with 503 Service Unavailable when all traffic is paused by kill-switch.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { getEmergencyKillSwitchService } from "../src/emergency/killSwitch.js";

export function killSwitchMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    // Exclude health routes and emergency control routes from being blocked
    const url = req.url || "";
    if (
      url.startsWith("/health") ||
      url.startsWith("/api/v1/health") ||
      url.startsWith("/api/v1/admin/emergency")
    ) {
      return true;
    }

    const killSwitch = getEmergencyKillSwitchService();
    if (killSwitch.isTrafficPaused()) {
      json(res, 503, {
        data: null,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Emergency kill-switch is active. Traffic is temporarily paused across gateway nodes.",
        },
      });
      return false;
    }

    return true;
  };
}
