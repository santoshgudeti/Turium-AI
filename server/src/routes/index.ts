import { Router } from 'express';
import { healthRouter } from './health.routes';
import { ingestRouter } from './ingest.routes';
import { itemRouter } from './item.routes';
import { queryRouter } from './query.routes';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(ingestRouter);
apiRouter.use(itemRouter);
apiRouter.use(queryRouter);
