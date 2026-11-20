import { Request, Response, NextFunction } from 'express';
import { IngestRequestSchema } from '../schemas/ingest.schema';
import { IngestionService } from '../services/ingestion.service';

const ingestionService = new IngestionService();

export const ingestContent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validatedInput = IngestRequestSchema.parse(req.body);
    const result = await ingestionService.ingest(validatedInput);

    res.status(201).json({
      status: 'success',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};
