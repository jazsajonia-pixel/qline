import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { getPool } from './db';
import { env } from './env';

let instance: ReturnType<typeof build> | null = null;

function build() {
  return betterAuth({
    database: getPool(),
    secret: env.authSecret,
    baseURL: env.publicUrl,
    basePath: '/v1/auth',
    trustedOrigins: env.webOrigins,
    emailAndPassword: { enabled: true, minPasswordLength: 10, maxPasswordLength: 128, autoSignIn: true },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    // Shared across function instances (0015). Tests keep memory storage so parallel suites do not share counters.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: (process.env.QLINE_RATE_LIMIT_STORAGE as 'memory' | 'database' | undefined) ?? (process.env.NODE_ENV === 'test' ? 'memory' : 'database'),
      customRules: {
        '/sign-in/email': { window: 300, max: 10 },
        '/sign-up/email': { window: 3600, max: 20 },
      },
    },
    advanced: {
      defaultCookieAttributes: { sameSite: 'none', secure: true },
    },
    plugins: [bearer()],
  });
}

export function getAuth() {
  if (!instance) instance = build();
  return instance;
}
