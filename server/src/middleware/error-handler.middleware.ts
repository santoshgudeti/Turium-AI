import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public details?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    logger.warn({ path: req.path, issues: err.issues }, 'Validation Error');
    res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: 'Invalid request payload or parameters',
      details: err.flatten(),
    });
    return;
  }

  if (err instanceof AppError) {
    logger.warn({ path: req.path, statusCode: err.statusCode, message: err.message }, 'Application Error');
    res.status(err.statusCode).json({
      status: 'error',
      code: 'APP_ERROR',
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  logger.error({ err, path: req.path }, 'Unhandled Internal Server Error');
  res.status(500).json({
    status: 'error',
    code: 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
  });
};
