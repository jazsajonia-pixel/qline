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
    rateLimit: { enabled: true, window: 60, max: 30, storage: 'memory' },
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
