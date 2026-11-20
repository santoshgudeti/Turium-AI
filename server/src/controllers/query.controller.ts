import { Request, Response, NextFunction } from 'express';
import { QueryRequestSchema } from '../schemas/query.schema';
import { RAGService } from '../services/rag.service';

const defaultRAGService = new RAGService();

export const queryKnowledgeInbox = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const validated = QueryRequestSchema.parse(req.body);
    const result = await defaultRAGService.answerQuestion(validated.question, {
      topK: validated.topK,
      itemId: validated.item_id,
    });

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};
