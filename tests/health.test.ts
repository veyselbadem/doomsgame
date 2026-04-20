import request from 'supertest';
import app from '../server';

describe('Health and public routes', () => {
  it('should respond with 200 and ok status on /health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('should render the home page', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Doomsgame');
  });
});
