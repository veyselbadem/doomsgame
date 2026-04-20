export type LanguageCode = 'tr' | 'en';
export type ContentType = 'post' | 'game';

export interface Game {
  id: number;
  title: string;
  embed_code: string;
  is_published: number;
  created_at: string;
  quality_score?: number;
}

export interface Post {
  id: number;
  title: string;
  content: string;
  is_published: number;
  created_at: string;
  quality_score?: number;
}

export interface User {
  id: number;
  username: string;
  password: string;
}

export interface EditorSource {
  id: number;
  url: string;
  type: 'news' | 'game';
  last_scraped: string | null;
}

export interface TaskStatus {
  name: string;
  schedule: string;
  status: string;
}
