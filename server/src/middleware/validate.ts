import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

// Validates and replaces req.body — handlers downstream only ever see
// schema-conforming data, which is the first line of the security model.
export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) return next(result.error);
    req.body = result.data;
    next();
  };
}
