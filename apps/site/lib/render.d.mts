export interface MediaMeta { id: string; type: string }
export declare const ICONS: string[]
export declare const MEDIA_TYPES: Record<string, string>
export declare function escapeHtml(v: unknown): string
export declare function safeHref(v: unknown): string
export declare function mediaPath(m: MediaMeta): string
export declare function icon(name: string, strokeWidth?: string): string
export declare function renderPages(input: {
  pages: Record<string, string>
  partials: Record<string, string>
  content: unknown
  media: MediaMeta[]
  fallbacks?: Record<string, string>
  base?: string
  origin?: string
}): Record<string, string>
