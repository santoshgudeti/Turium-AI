import { Router } from 'express';
import { getItems, getItemById, deleteItem } from '../controllers/item.controller';

export const itemRouter = Router();

itemRouter.get('/items', getItems);
itemRouter.get('/items/:id', getItemById);
itemRouter.delete('/items/:id', deleteItem);
