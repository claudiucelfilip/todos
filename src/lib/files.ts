// Attachment display helpers (pure): URLs, sizes and a coarse kind for the icon.
import type { Attachment } from './types';
import { apiBase } from './sync';

import { scopedUrl } from './account';
export const fileUrl = (id: string): string => scopedUrl(`${apiBase()}/kanban/files/${id}`);
/** The preview: the stored thumb when there is one, else the image itself. */
export const thumbUrl = (a: Attachment): string => (a.thumb ? scopedUrl(`${apiBase()}/kanban/files/${a.id}/thumb`) : fileUrl(a.id));
export const isImage = (a: { type: string }): boolean => /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|heic|heif)$/i.test(a.type);

/** "812 B", "14 KB", "3.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / 1024 / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export type FileKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'archive' | 'sheet' | 'doc' | 'file';

export function fileKind(a: { type: string; name: string }): FileKind {
  const t = a.type.toLowerCase();
  const ext = a.name.toLowerCase().split('.').pop() ?? '';
  if (isImage(a)) return 'image';
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (/zip|tar|gzip|x-7z|rar/.test(t) || ['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return 'archive';
  if (/sheet|excel|csv/.test(t) || ['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) return 'sheet';
  if (/word|document|rtf/.test(t) || ['doc', 'docx', 'pages', 'rtf'].includes(ext)) return 'doc';
  if (t.startsWith('text/') || /json|xml/.test(t)) return 'text';
  return 'file';
}

/** The short label on a file icon: the extension, else the kind. */
export function fileBadge(a: { type: string; name: string }): string {
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.slice(0, 4).toUpperCase() : '';
  return ext || fileKind(a).toUpperCase().slice(0, 4);
}
