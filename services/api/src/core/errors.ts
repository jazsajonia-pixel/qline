export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public title: string,
    public detail?: string,
    public fields?: Record<string, string>,
  ) {
    super(detail ?? title);
  }
}
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (detail = 'You do not have permission for this.') => new ApiError(403, 'FORBIDDEN', 'Forbidden', detail);
export const badRequest = (detail: string, fields?: Record<string, string>) => new ApiError(400, 'VALIDATION_FAILED', 'Invalid request', detail, fields);
export const conflict = (code: string, detail: string) => new ApiError(409, code, 'Conflict', detail);
