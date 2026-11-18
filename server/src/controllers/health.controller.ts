import { Request, Response } from 'express';

export const getHealth = (_req: Request, res: Response): void => {
  res.status(200).json({
    status: 'ok',
    service: 'turium-ai-knowledge-inbox-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
};
