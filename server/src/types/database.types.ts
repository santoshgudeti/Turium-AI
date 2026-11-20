export type SourceType = 'note' | 'url';

export type ItemStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Item {
  id: string;
  source_type: SourceType;
  title: string | null;
  source_url: string | null;
  raw_content: string;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
}

export interface ItemSummary {
  id: string;
  source_type: SourceType;
  title: string | null;
  source_url: string | null;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
  chunk_count: number;
}

export interface CreateItemInput {
  id?: string;
  source_type: SourceType;
  title?: string | null;
  source_url?: string | null;
  raw_content: string;
  status?: ItemStatus;
}

export interface Chunk {
  id: string;
  item_id: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  created_at: string;
}

export interface ChunkWithMetadata extends Chunk {
  item_title: string | null;
  item_source_url: string | null;
  item_source_type: SourceType;
}

export interface CreateChunkInput {
  id?: string;
  item_id: string;
  chunk_index: number;
  content: string;
  embedding?: string | null;
  embedding_model?: string | null;
  embedding_dimensions?: number | null;
}
