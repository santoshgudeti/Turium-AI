import { Router } from 'express';
import { queryKnowledgeInbox } from '../controllers/query.controller';

export const queryRouter = Router();

queryRouter.post('/query', queryKnowledgeInbox);
