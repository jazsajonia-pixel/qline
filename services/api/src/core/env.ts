export const env = {
  get databaseUrl() {
    return process.env.APP_DATABASE_URL ?? '';
  },
  get authSecret() {
    return process.env.BETTER_AUTH_SECRET ?? '';
  },
  get publicUrl() {
    return process.env.QLINE_PUBLIC_URL ?? 'http://localhost:8787';
  },
  get webOrigins() {
    return (process.env.QLINE_WEB_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  },
  get aiModel() {
    return process.env.QLINE_AI_MODEL ?? 'gemini-4-carbon';
  },
  /** 32+ random bytes (any string); encrypts organizations' AI provider keys at rest. */
  get dataKey() {
    return process.env.QLINE_DATA_KEY ?? '';
  },
  get bucket() {
    return process.env.QLINE_BUCKET ?? 'qline-files';
  },
  get cronKey() {
    return process.env.QLINE_CRON_KEY ?? '';
  },
  get minClientBuild() {
    return Number(process.env.QLINE_MIN_CLIENT_BUILD ?? '0');
  },
  /** The release this bundle was built from. QLINE_VERSION is only a fallback for local runs. */
  get version() {
    return API_VERSION || process.env.QLINE_VERSION || 'dev';
  },
};

export const API_VERSION = '1.4.0-rc.1';
