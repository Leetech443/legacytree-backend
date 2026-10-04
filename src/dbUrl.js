// Reads DATABASE_URL and forgives common copy/paste mistakes (psql wrapper, quotes, spaces).
export function getDatabaseUrl() {
  let u = (process.env.DATABASE_URL || '').trim();
  u = u.replace(/^psql\s+/i, '').replace(/^["']+|["']+$/g, '').trim();
  if (!/^postgres(ql)?:\/\//i.test(u)) {
    throw new Error('DATABASE_URL is missing or invalid. It must look like postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require');
  }
  // `require` is already treated as `verify-full` by pg; saying so explicitly silences its warning
  return u.replace(/sslmode=require/i, 'sslmode=verify-full');
}
export const needsSsl = (url) => !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
