/** Mirrors the FastAPI Pydantic schemas (backend/app/schemas). */

export type JobStatus =
  | "pending"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export type VideoSource = "upload" | "youtube" | "url";

export interface User {
  id: number;
  email: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  is_superuser: boolean;
  created_at: string;
}

export interface Token {
  access_token: string;
  refresh_token: string;
  token_type?: string;
}

export interface Project {
  id: number;
  owner_id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  video_count: number;
  clip_count: number;
}

export interface Video {
  id: number;
  project_id: number;
  source: VideoSource;
  source_url: string | null;
  original_filename: string | null;
  title: string | null;
  language: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  size_bytes: number | null;
  thumbnail_path: string | null;
  status: JobStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  clip_count: number;
}
