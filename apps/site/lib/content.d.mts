export interface ContentError { path: string; message: string }
export declare function validateContent(
  schema: unknown, input: unknown, defaults: unknown, mediaIds?: Set<string>,
): { content: Record<string, Record<string, Record<string, unknown>>>; errors: ContentError[] }
export declare function imageFallbacks(schema: unknown): Record<string, string>
export declare function referencedMedia(content: unknown): Set<string>
