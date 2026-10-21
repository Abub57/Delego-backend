import express from 'express';
import request from 'supertest';
import { securityHeaders } from './securityHeaders';

describe('securityHeaders middleware', () => {
  const buildApp = () => {
    const app = express();
    app.use(securityHeaders());
    app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  };

  it('sets X-Content-Type-Options to nosniff', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets Strict-Transport-Security with a long max-age', async () => {
    const res = await request(buildApp()).get('/health');
    const hsts = res.headers['strict-transport-security'];
    expect(hsts).toBeDefined();
    expect(hsts).toMatch(/max-age=\d{6,}/);
    expect(hsts).toContain('includeSubDomains');
  });

  it('sets a strict Content-Security-Policy', async () => {
    const res = await request(buildApp()).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('does not leak the X-Powered-By header', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('applies headers to every response', async () => {
    const app = buildApp();
    const first = await request(app).get('/health');
    const second = await request(app).get('/health');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(second.headers['x-content-type-options']).toBe('nosniff');
  });
});
