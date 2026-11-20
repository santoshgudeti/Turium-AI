export type SourceType = 'note' | 'url';

export type ItemStatus = 'pending' | 'processing' | 'completed' | 'failed';

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

// Convenient alias for frontend UI components
export type KnowledgeItem = ItemSummary;

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

export interface ItemDetail {
  id: string;
  source_type: SourceType;
  title: string | null;
  source_url: string | null;
  raw_content: string;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
}

export interface IngestNotePayload {
  source_type: 'note';
  title?: string;
  content: string;
}

export interface IngestUrlPayload {
  source_type: 'url';
  url: string;
}

export type IngestPayload = IngestNotePayload | IngestUrlPayload;

export interface IngestResult {
  item: ItemDetail;
  chunk_count: number;
}

export interface GroundedSource {
  item_id: string;
  item_title: string | null;
  source_type: SourceType;
  source_url: string | null;
  chunk_id: string;
  chunk_index: number;
  snippet: string;
  similarity: number;
}

export interface QueryPayload {
  question: string;
  topK?: number;
  /**
   * Optional item UUID to scope the semantic search to a single knowledge item.
   * When present, retrieval is restricted to chunks belonging to that item.
   */
  item_id?: string;
}

export interface QueryResult {
  answer: string;
  sources: GroundedSource[];
}

export interface DeleteItemResult {
  id: string;
  deleted_chunks: number;
  database_deleted: boolean;
  vector_cleanup_completed: boolean;
  status?: 'success' | 'partial_success';
  code?: string;
  orphaned_point_ids?: string[];
}

export interface ApiResponse<T> {
  status: 'success' | 'partial_success' | 'error';
  data?: T;
  message?: string;
  code?: string;
  errors?: Array<{ path?: (string | number)[]; message?: string }>;
}
