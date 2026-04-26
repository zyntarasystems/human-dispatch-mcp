import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Express middleware that requires `Authorization: Bearer <token>` on every
 * request. Compares with `timingSafeEqual` to defeat timing-side-channel
 * attacks on token guessing. The expected token is read from the closure
 * once, so rotation requires a process restart.
 */
export function requireBearerAuth(token: string) {
  if (!token || token.length < 32) {
    throw new Error("Bearer auth token must be at least 32 characters");
  }
  const expectedBuf = Buffer.from(`Bearer ${token}`);

  return function bearerAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers["authorization"];
    if (typeof header !== "string") {
      res.status(401).json({ error: "Missing Authorization header" });
      return;
    }
    const gotBuf = Buffer.from(header);
    if (gotBuf.length !== expectedBuf.length) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    if (!timingSafeEqual(gotBuf, expectedBuf)) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    next();
  };
}
