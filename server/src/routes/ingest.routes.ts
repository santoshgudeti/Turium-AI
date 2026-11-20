import { Router } from 'express';
import { ingestContent } from '../controllers/ingest.controller';

export const ingestRouter = Router();

ingestRouter.post('/ingest', ingestContent);
